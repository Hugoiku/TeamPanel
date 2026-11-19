"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { runGraph, resumeGraph, loadCheckpoint, emptyState, reduceState, GraphError } = require("../runtime/graph/engine");
const ROOT = path.resolve(__dirname, "..");

function graph(over) {
  return Object.assign({
    id: "test-graph",
    start: "fetch",
    limits: { maxSteps: 30, maxVisitsPerNode: 12, maxEdgeTraversals: 30, maxRepeatedState: 6, maxDurationMs: 30000 },
    nodes: [
      { id: "fetch", type: "fetch" },
      { id: "gate", type: "gate" },
      { id: "data", type: "data" },
      { id: "report", type: "report" },
      { id: "approval", type: "approval" }
    ],
    edges: [
      { from: "fetch", to: "gate" },
      { from: "gate", to: "report", when: { path: "coverage.ge.spot", op: ">=", value: 95 } },
      { from: "gate", to: "data", default: true },
      { from: "data", to: "gate" },
      { from: "report", to: "approval" }
    ]
  }, over || {});
}

const executors = {
  fetch: async () => ({ patch: { coverage: { "ge.spot": 60 }, evidence: [{ id: "S1", value: 1 }] } }),
  gate: async () => ({}),
  data: async ({ state }) => {
    const c = Number((state.coverage || {})["ge.spot"] || 0) + 20;
    return { patch: { coverage: { "ge.spot": c }, evidence: [{ id: "S" + (c / 20 + 1), value: c }] } };
  },
  report: async ({ state }) => ({ patch: { artifacts: [{ path: "reports/x.docx", coverage: state.coverage["ge.spot"] }] } }),
  approval: async ({ decision }) => decision
    ? { patch: { gates: { sign: true } } }
    : { interrupt: { prompt: "确认签发？", options: [{ id: "yes" }, { id: "no" }] } }
};

(async () => {
  let pass = 0;
  const ok = (c, m) => { if (c) { pass++; } else throw new Error("FAIL: " + m); };

  // 1. 条件循环 + 覆盖率收敛
  let run = await runGraph(graph(), { runId: "test-loop-" + Date.now(), executors, checkpoint: true });
  ok(run.status === "running" || run.status === "waiting" || run.status === "done", "loop run ended");
  // approval 会 interrupt，所以 run 应是 waiting
  ok(run.status === "waiting", "should wait at approval");
  ok(run.state.coverage["ge.spot"] >= 100, "coverage converged: " + run.state.coverage["ge.spot"]);
  ok(run.state.evidence.length === 3, "evidence merged: " + run.state.evidence.length);

  // 2. resume
  const rid = run.id;
  run = await resumeGraph(rid, { id: "yes" }, executors, { graph: graph(), checkpoint: false });
  ok(run.status === "done", "resume done");
  ok(run.state.decisions.approval.id === "yes", "decision recorded");

  // 3. 死循环防护：data 不增加覆盖
  const badExec = Object.assign({}, executors, { data: async () => ({}) });
  let err = null;
  try { await runGraph(graph({ id: "bad-loop" }), { runId: "bad-" + Date.now(), executors: badExec, checkpoint: false }); }
  catch (e) { err = e; }
  ok(err && (err.code === "MAX_VISITS" || err.code === "NO_PROGRESS"), "loop guard: " + (err && err.code));

  // 4. reducer 防覆盖
  const st = emptyState("c", { evidence: [{ id: "S1", a: 1 }] });
  const st2 = reduceState(st, { evidence: [{ id: "S1", b: 2 }, { id: "S2", c: 3 }] });
  ok(st2.evidence.length === 2 && st2.evidence[0].a === 1 && st2.evidence[0].b === 2, "reducer merge");

  // 5. checkpoint
  const cpr = await runGraph(graph({ id: "cp" }), { runId: "cp-" + Date.now(), executors, checkpoint: true });
  const loaded = loadCheckpoint(cpr.id);
  ok(loaded.id === cpr.id && loaded.status === "waiting", "checkpoint load");

  console.log(JSON.stringify({ ok: true, pass }, null, 2));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
