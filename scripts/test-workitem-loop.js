#!/usr/bin/env node
"use strict";
/**
 * test-workitem-loop — WorkItem 与 Employee Loop 的闭环验收：
 * claim -> fake 循环 -> 确定性门禁 -> finish，失败路径挂 needs_review。
 */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const lib = require("./agent-loop-lib");
const ROOT = lib.ROOT;
const CASE = "default";

function runLoop(args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "employee-loop.js")].concat(args), {
    cwd: ROOT, encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { DESK_BROKER: lib.BROKER })
  });
  let j = null;
  try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), j };
}
(async () => {
  const health = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE)).catch(() => null);
  assert(health && health.status === 200, "broker 未启动: " + lib.BROKER);
  const tag = Date.now().toString(36);

  // 1) 无声明产物：fake done 应通过门禁并完成 WorkItem
  let c = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "T-" + tag + "-a",
    name: "test A", agent: "industry", task: "fake task A", outputs: [] });
  assert.strictEqual(c.status, 200);
  const w1 = c.body.item;
  const r1 = runLoop(["--case", CASE, "--agent", "industry", "--mode", "fake", "--work-id", w1.id]);
  assert.strictEqual(r1.status, 0, r1.err || r1.out);
  assert.strictEqual(r1.j.status, "done");
  const g1 = await lib.api("GET", "/api/work/item?case=" + encodeURIComponent(CASE) + "&id=" + encodeURIComponent(w1.id));
  assert.strictEqual(g1.body.item.state, "done");
  assert.strictEqual(g1.body.item.loopId, r1.j.loopId);
  assert(g1.body.item.gate && g1.body.item.gate.ok, "gate 应通过");
  console.log("PASS 1 WorkItem claim -> fake loop -> done");

  // 2) 声明产物缺失：done 必须被确定性门禁拒绝，WorkItem 挂 needs_review
  const missing = "research/missing-" + tag + ".md";
  c = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "T-" + tag + "-b",
    name: "test B", agent: "industry", task: "fake task B", outputs: [missing] });
  const w2 = c.body.item;
  const r2 = runLoop(["--case", CASE, "--agent", "industry", "--mode", "fake", "--work-id", w2.id]);
  assert.strictEqual(r2.status, 1, "门禁失败应 exit 1");
  assert.strictEqual(r2.j.status, "needs_review");
  assert(r2.j.gate && r2.j.gate.ok === false);
  const g2 = await lib.api("GET", "/api/work/item?case=" + encodeURIComponent(CASE) + "&id=" + encodeURIComponent(w2.id));
  assert.strictEqual(g2.body.item.state, "failed");
  assert.strictEqual(g2.body.item.needsReview, true);
  assert(/contract_rejected/.test(g2.body.item.error), g2.body.item.error);
  console.log("PASS 2 missing output -> contract_rejected -> work failed + needsReview");

  // 3) 产物真实存在：门禁通过，outputs 落到 WorkItem
  const rel = "research/workitem-gate-" + tag + ".md";
  fs.mkdirSync(path.join(ROOT, "vault", CASE, "research"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "vault", CASE, rel), "# gate test\n\n[S1]\n");
  const contract = JSON.stringify({ status: "done", summary: "wrote artifact", artifacts: [rel],
    evidenceIds: [], openQuestions: [], needs: [], subagents: [], confidence: 1 });
  c = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "T-" + tag + "-c",
    name: "test C", agent: "industry", task: "fake task C", outputs: [rel] });
  const w3 = c.body.item;
  const r3 = runLoop(["--case", CASE, "--agent", "industry", "--mode", "fake", "--work-id", w3.id,
    "--fake-contract", contract]);
  assert.strictEqual(r3.status, 0, r3.err || r3.out);
  assert.strictEqual(r3.j.status, "done");
  const g3 = await lib.api("GET", "/api/work/item?case=" + encodeURIComponent(CASE) + "&id=" + encodeURIComponent(w3.id));
  assert.strictEqual(g3.body.item.state, "done");
  assert.deepStrictEqual(g3.body.item.outputs, [rel]);
  console.log("PASS 3 artifact exists -> done + outputs recorded");

  // 4) 已绑定其他 loop 的 WorkItem 不能被冒领
  c = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "T-" + tag + "-d",
    name: "test D", agent: "industry", task: "fake task D", outputs: [], loopId: "OTHER-LOOP" });
  const w4 = c.body.item;
  const r4 = runLoop(["--case", CASE, "--agent", "industry", "--mode", "fake", "--work-id", w4.id]);
  assert.strictEqual(r4.status, 1);
  assert(/已绑定其他 loop/.test(r4.err), r4.err);
  console.log("PASS 4 loopId mismatch rejected");

  console.log("ALL PASS test-workitem-loop");
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
