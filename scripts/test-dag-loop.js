#!/usr/bin/env node
"use strict";
/**
 * test-dag-loop — DAG 节点走 Employee Loop 的闭环验收：
 * claim -> loop attach -> 执行 -> gate -> run-dag finish；失败挂 needsReview。
 */
const { spawnSync } = require("child_process");
const path = require("path");
const assert = require("assert");
const lib = require("./agent-loop-lib");
const ROOT = lib.ROOT;
const TAG = Date.now().toString(36);
const CASE = "dagloop-test-" + TAG;

async function createApprovedPlan(steps) {
  const c = await lib.api("POST", "/api/plan", { case: CASE, agent: "industry", goal: "dag loop test " + TAG, steps });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const id = c.body.plan.id;
  const a = await lib.api("POST", "/api/plan/approve", { case: CASE, id });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  return id;
}
function runDag(planId, extra, maxConc) {
  const args = [path.join(__dirname, "run-dag.js"), "--case", CASE, "--plan", planId,
    "--fake", "--max-concurrency", String(maxConc || 1)].concat(extra || []);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { DESK_BROKER: lib.BROKER }) });
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
async function items(planId) {
  const r = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE));
  return ((r.body && r.body.items) || []).filter(w => w.planId === planId && w.kind !== "child");
}
(async () => {
  const health = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE)).catch(() => null);
  assert(health && health.status === 200, "broker 未启动: " + lib.BROKER);

  // 1) 成功路径：DAG 节点由 Employee Loop 执行，gate 通过后由 run-dag finish
  let planId = await createApprovedPlan([{ id: "S1", name: "loop smoke", task: "写一句话结论", outputs: [] }]);
  let r = runDag(planId, ["--agent-loop"]);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert(/全部完成/.test(r.out), r.out);
  let ws = await items(planId);
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].state, "done");
  assert(ws[0].loopId, "WorkItem 应记录 loopId");
  assert(ws[0].gate && ws[0].gate.ok, "WorkItem 应记录通过的 gate");
  console.log("PASS 1 DAG node -> Employee Loop -> gate -> done");

  // 2) 失败路径：声明产物缺失，loop gate 拒绝，WorkItem failed + needsReview
  const missing = "research/missing-" + TAG + ".md";
  planId = await createApprovedPlan([{ id: "S1", name: "loop fail", task: "写结论", outputs: [missing] }]);
  r = runDag(planId, ["--agent-loop"]);
  assert.strictEqual(r.status, 6, r.err || r.out);
  ws = await items(planId);
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].state, "failed");
  assert.strictEqual(ws[0].needsReview, true);
  assert(ws[0].gate && ws[0].gate.ok === false);
  assert(/contract_rejected/.test(ws[0].error || ""), ws[0].error);
  console.log("PASS 2 missing output -> gate rejected -> failed + needsReview");

  // 3) 回退开关：--no-agent-loop 仍走旧 fake 路径，不产生 loopId
  planId = await createApprovedPlan([{ id: "S1", name: "legacy", task: "旧路径", outputs: [] }]);
  r = runDag(planId, ["--no-agent-loop"]);
  assert.strictEqual(r.status, 0, r.err || r.out);
  ws = await items(planId);
  assert.strictEqual(ws[0].state, "done");
  assert(!ws[0].loopId, "回退路径不应有 loopId");
  console.log("PASS 3 --no-agent-loop falls back to legacy employee path");

  // 4) 并发：两个独立节点同时 claim，各自 attach 一个 Employee Loop
  planId = await createApprovedPlan([
    { id: "S1", name: "并发 A", task: "a", outputs: [], depends: [], dependsExplicit: true },
    { id: "S2", name: "并发 B", task: "b", outputs: [], depends: [], dependsExplicit: true }
  ]);
  r = runDag(planId, ["--agent-loop"], 2);
  assert.strictEqual(r.status, 0, r.err || r.out);
  ws = await items(planId);
  assert.strictEqual(ws.length, 2);
  assert(ws.every(w => w.state === "done" && w.loopId && w.gate && w.gate.ok), JSON.stringify(ws));
  console.log("PASS 4 concurrent DAG nodes each run an Employee Loop");

  // 5) modelChain：每个阶段都走 Employee Loop，中间阶段 skip-gate，最后阶段 gate
  planId = await createApprovedPlan([{ id: "S1", name: "chain", task: "chain task", outputs: [],
    modelChain: [{ id: "M1", provider: "fake", model: "m1", task: "阶段一" },
      { id: "M2", provider: "fake", model: "m2", task: "阶段二" }] }]);
  r = runDag(planId, ["--agent-loop"]);
  assert.strictEqual(r.status, 0, r.err || r.out);
  ws = await items(planId);
  assert.strictEqual(ws.length, 1);
  assert.strictEqual(ws[0].state, "done");
  assert(ws[0].loopId, "modelChain 最终阶段应记录 loopId");
  const fs = require("fs");
  assert(fs.existsSync(path.join(ROOT, "runtime/work", ws[0].id, "S1.M1.artifact.json")));
  assert(fs.existsSync(path.join(ROOT, "runtime/work", ws[0].id, "S1.M2.artifact.json")));
  console.log("PASS 5 modelChain stages run through Employee Loop");

  console.log("ALL PASS test-dag-loop");
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
