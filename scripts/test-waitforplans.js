#!/usr/bin/env node
"use strict";
/** test-waitforplans — 跨计划节点依赖：stock 预研先跑，收口节点等上游计划完成。 */
const assert = require("assert");
const lib = require("./agent-loop-lib");
const TAG = Date.now().toString(36);
const CASE = "waitforplans-" + TAG;

async function createPlan(agent, steps) {
  const c = await lib.api("POST", "/api/plan", { case: CASE, agent, goal: "waitforplans " + TAG, steps });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const id = c.body.plan.id;
  const a = await lib.api("POST", "/api/plan/approve", { case: CASE, id });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  return id;
}
async function createWork(planId, nodeId, waitForPlans) {
  const r = await lib.api("POST", "/api/work/create", { case: CASE, planId, nodeId,
    agent: "industry", task: nodeId, outputs: [], waitForPlans: waitForPlans || [] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.item;
}
async function claim(planId) {
  return lib.api("POST", "/api/work/claim", { case: CASE, planId, owner: "test", maxConcurrency: 1, leaseMs: 120000 });
}
async function finish(item) {
  return lib.api("POST", "/api/work/finish", { case: CASE, id: item.id, owner: "test",
    leaseId: item.leaseId, ok: true, outputs: [] });
}
(async () => {
  const health = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE)).catch(() => null);
  assert(health && health.status === 200, "broker 未启动: " + lib.BROKER);

  const upstream = await createPlan("macro", [{ id: "U1", name: "上游", task: "u", outputs: [], depends: [], dependsExplicit: true }]);
  await createWork(upstream, "U1");
  const stock = await createPlan("stock", [
    { id: "S1", name: "预研", task: "pre", outputs: [], depends: [], dependsExplicit: true },
    { id: "S2", name: "估值与结论", task: "final", outputs: [], depends: [], dependsExplicit: true, waitForPlans: [upstream] }
  ]);
  await createWork(stock, "S1");
  await createWork(stock, "S2", [upstream]);

  // 预研节点可以先跑
  let c = await claim(stock);
  assert.strictEqual(c.status, 200);
  assert(c.body.item && c.body.item.nodeId === "S1", JSON.stringify(c.body));
  await finish(c.body.item);

  // 收口节点等上游
  c = await claim(stock);
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.body.item, null);
  assert.strictEqual(c.body.reason, "waiting-upstream", JSON.stringify(c.body));
  console.log("PASS 1 stock pre-research runs; final node waits for upstream");

  // 上游完成后，收口节点可 claim
  c = await claim(upstream);
  assert.strictEqual(c.status, 200);
  assert(c.body.item && c.body.item.nodeId === "U1");
  await finish(c.body.item);
  c = await claim(stock);
  assert.strictEqual(c.status, 200);
  assert(c.body.item && c.body.item.nodeId === "S2", JSON.stringify(c.body));
  await finish(c.body.item);
  console.log("PASS 2 upstream done -> stock final node becomes claimable");

  console.log("ALL PASS test-waitforplans");
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
