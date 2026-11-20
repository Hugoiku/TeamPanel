#!/usr/bin/env node
"use strict";
/**
 * test-lead-recovery — Lead 租约并发 + 阻塞 need 答复后自动 resume。
 * 需要 broker 已启动（和 test-lead-actions 相同约束）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const lib = require("./agent-loop-lib");
const ROOT = lib.ROOT;
const TAG = Date.now().toString(36);
const CASE = "lead-recovery-" + TAG;

async function startLead(decision, maxRounds) {
  const r = await lib.api("POST", "/api/agent/loop", {
    case: CASE, kind: "lead", mode: "fake", runtime: "fake", maxRounds: maxRounds || 2,
    objective: "lead recovery test", fakeDecision: decision, by: "test"
  });
  return r;
}
async function getLoops() {
  const r = await lib.api("GET", "/api/agent/loops?case=" + encodeURIComponent(CASE));
  return (r.body && r.body.loops) || [];
}
async function waitLoop(id, statuses, timeoutMs) {
  const end = Date.now() + (timeoutMs || 15000);
  while (Date.now() < end) {
    const l = (await getLoops()).filter(x => x.id === id)[0];
    if (l && statuses.indexOf(l.status) >= 0) return l;
    await lib.sleep(300);
  }
  return null;
}
(async () => {
  const health = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE)).catch(() => null);
  assert(health && health.status === 200, "broker 未启动: " + lib.BROKER);

  // 1) 单 case 只允许一个 active Lead
  const a = await startLead({ action: "wait", reason: "hold lease" }, 3);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  const loopId = a.body.loopId;
  const b = await startLead({ action: "wait", reason: "should be rejected" }, 1);
  assert.strictEqual(b.status, 409, "第二个 Lead 应被租约拒绝: " + JSON.stringify(b.body));
  assert.strictEqual(b.body.code, "lead_lease_held");
  console.log("PASS 1 second Lead rejected by lease");

  await lib.api("POST", "/api/agent/loop/stop", { case: CASE, id: loopId, by: "test" });
  await waitLoop(loopId, ["stopped", "done", "done_max_rounds", "failed"], 12000);

  // 2) 阻塞 need 答复后，自动 resume waiting_human 的 Lead
  const c = await startLead({ action: "request_review", review: { title: "auto resume test" } }, 1);
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  const waitId = c.body.loopId;
  const waiting = await waitLoop(waitId, ["waiting_human"], 15000);
  assert(waiting, "Lead 应进入 waiting_human");
  const nr = await lib.api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
  const need = ((nr.body && nr.body.needs) || []).find(n => n.status === "pending" || n.status === "partial");
  assert(need && need.id, "应创建待答复 need");
  const ar = await lib.api("POST", "/api/need/answer", { case: CASE, id: need.id, decision: "approve", answer: "同意", by: "test" });
  assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));
  let resumed = null;
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const loops = await getLoops();
    resumed = loops.find(l => l.resumedFrom === waitId);
    if (resumed && resumed.status === "done") break;
    await lib.sleep(500);
  }
  assert(resumed, "应自动创建 resume Loop");
  assert.strictEqual(resumed.status, "done");
  console.log("PASS 2 answered blocking need auto-resumes Lead");

  // 清理测试 loop 文件
  for (const l of await getLoops()) {
    try { fs.unlinkSync(path.join(ROOT, "runtime/agent-loops", l.id + ".json")); } catch (e) {}
    try { fs.unlinkSync(path.join(ROOT, "runtime/agent-loops", l.id + ".log")); } catch (e) {}
  }
  console.log("ALL PASS test-lead-recovery");
})().catch(e => { console.error("FAIL test-lead-recovery:", e && e.message || e); process.exit(1); });
