#!/usr/bin/env node
"use strict";
/**
 * graph-pilot — 用 Graph Runtime 试点“失败节点恢复 + 人工确认”。
 * 不替换 Plan/WorkItem，只作为图运行时接入现有 Broker 的最小闭环。
 *
 *   node scripts/graph-pilot.js --case c --plan PL35
 *   node scripts/graph-pilot.js --case c --plan PL35 --resume <runId> --decision retry
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const { runGraph, resumeGraph } = require("../runtime/graph/engine");
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.DESK_PORT || "7801";
const BASE = process.env.DESK_BROKER || ("http://127.0.0.1:" + PORT);
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, res => {
      let s = ""; res.on("data", d => s += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const CASE = arg("case", "");
const PLAN = arg("plan", "");
if (!CASE) { console.error("--case required"); process.exit(2); }

function graph() {
  return {
    id: "pilot-failure-recovery",
    start: "inspect",
    limits: { maxSteps: 20, maxVisitsPerNode: 5, maxEdgeTraversals: 20, maxRepeatedState: 3, maxDurationMs: 600000 },
    nodes: [
      { id: "inspect" }, { id: "gate" }, { id: "ask" }, { id: "retry" }, { id: "done" }
    ],
    edges: [
      { from: "inspect", to: "gate" },
      { from: "gate", to: "ask", when: { path: "failed.length", op: ">", value: 0 } },
      { from: "gate", to: "done", default: true },
      { from: "ask", to: "retry", when: { path: "decision.retry", op: "==", value: true } },
      { from: "ask", to: "done", default: true },
      { from: "retry", to: "done" }
    ]
  };
}

async function loadPlan() {
  const p = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
  const plans = (p.body && p.body.plans) || [];
  let plan = PLAN ? plans.find(x => x.id === PLAN) : plans.filter(x => x.status === "approved" || x.status === "running").pop();
  if (!plan) throw new Error("找不到计划 " + (PLAN || "(approved)"));
  const w = await api("GET", "/api/work?case=" + encodeURIComponent(CASE));
  const items = ((w.body && w.body.items) || []).filter(x => x.planId === plan.id && x.kind !== "child");
  return { plan, items };
}

const executors = {
  async inspect({ run }) {
    const { plan, items } = await loadPlan();
    const failed = items.filter(x => x.state === "failed").map(x => ({ id: x.id, nodeId: x.nodeId, name: x.name, error: x.error }));
    const running = items.filter(x => x.state === "running").map(x => x.nodeId);
    const done = items.filter(x => x.state === "done").length;
    run.state.planId = plan.id;
    return { patch: { planId: plan.id, total: items.length, done, failed, running } };
  },
  async gate() { return {}; },
  async ask({ run, decision }) {
    if (decision && decision.decision) {
      return { patch: { decision: { retry: decision.decision === "retry" } } };
    }
    const failed = run.state.failed || [];
    return { interrupt: { prompt: "计划 " + run.state.planId + " 有 " + failed.length + " 个失败节点，是否重试？",
      options: [{ id: "retry", label: "重试失败节点" }, { id: "skip", label: "跳过" }] } };
  },
  async retry({ run }) {
    const failed = run.state.failed || [];
    const out = [];
    for (const f of failed) {
      const r = await api("POST", "/api/work/retry", { case: CASE, id: f.id, by: "graph-pilot",
        expectedState: "failed", requestId: run.id + ":" + f.id });
      const already = !!(r.body && r.body.already) ||
        (r.status === 409 && ["queued", "running", "done"].includes(r.body && r.body.state));
      out.push({ id: f.id, ok: r.status === 200 || already, already,
        state: r.body && r.body.item && r.body.item.state,
        error: r.body && r.body.error || "" });
    }
    return { patch: { retried: out } };
  },
  async done({ run, state }) {
    const p = path.join(ROOT, "runtime/graph", "pilot-" + run.id + ".json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ runId: run.id, case: CASE, state, finishedAt: new Date().toISOString() }, null, 2));
    return { patch: { finishedAt: new Date().toISOString() }, done: true };
  }
};

(async () => {
  const resumeId = arg("resume", "");
  if (resumeId) {
    const decision = arg("decision", "");
    const run = await resumeGraph(resumeId, { decision }, executors, { graph: graph() });
    console.log(JSON.stringify({ ok: run.status === "done", runId: run.id, status: run.status,
      state: run.state, error: run.error || "" }, null, 2));
    process.exit(run.status === "done" ? 0 : 1);
  }
  const run = await runGraph(graph(), { caseId: CASE, executors, checkpoint: true });
  console.log(JSON.stringify({ ok: run.status === "done", runId: run.id, status: run.status,
    state: run.state, interrupt: run.interrupt, error: run.error || "" }, null, 2));
  process.exit(run.status === "done" ? 0 : 0);
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
