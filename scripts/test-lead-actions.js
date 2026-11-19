#!/usr/bin/env node
"use strict";
/**
 * test-lead-actions — Lead Loop 扩展动作验收：
 * create_plan / revise_plan（撤销批准）/ assign_task / spawn_employee /
 * request_review / cancel_task / synthesize（不签发，走审批）。
 */
const { spawnSync } = require("child_process");
const path = require("path");
const assert = require("assert");
const lib = require("./agent-loop-lib");
const ROOT = lib.ROOT;
const TAG = Date.now().toString(36);
const CASE = "lead-test-" + TAG;

function runLead(decision, maxRounds, autonomy) {
  const args = [path.join(__dirname, "lead-loop.js"), "--case", CASE, "--mode", "fake",
    "--max-rounds", String(maxRounds || 1), "--loop-id", "LT" + TAG + Math.random().toString(36).slice(2, 5)];
  if (autonomy) args.push("--autonomy", autonomy);
  if (decision) args.push("--fake-decision", JSON.stringify(decision));
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, { DESK_BROKER: lib.BROKER }) });
  let j = null; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
  return { status: r.status, out: String(r.stdout || ""), err: String(r.stderr || ""), j };
}
async function getPlan(id) {
  const r = await lib.api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
  return ((r.body && r.body.plans) || []).find(p => p.id === id);
}
async function getWork(id) {
  const r = await lib.api("GET", "/api/work/item?case=" + encodeURIComponent(CASE) + "&id=" + encodeURIComponent(id));
  return r.status === 200 ? r.body.item : null;
}
(async () => {
  const health = await lib.api("GET", "/api/work?case=" + encodeURIComponent(CASE)).catch(() => null);
  assert(health && health.status === 200, "broker 未启动: " + lib.BROKER);

  // 1) create_plan：只能建 pending 草稿
  let r = runLead({ action: "create_plan", reason: "test create",
    plan: { agent: "industry", goal: "Lead action test " + TAG,
      steps: [{ id: "S1", name: "研究", task: "写研究底稿", outputs: ["research/lead-" + TAG + ".md"] }] } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "done_max_rounds");
  const createAct = (r.j.actions || []).find(a => a.action === "create_plan");
  assert(createAct && createAct.ok, "create_plan 应成功");
  const planId = createAct.planId;
  assert(planId, "应返回 planId");
  let plan = await getPlan(planId);
  assert.strictEqual(plan.status, "pending");
  console.log("PASS 1 create_plan -> pending draft");

  // 2) 人工批准后修订：批准必须被撤销
  let ap = await lib.api("POST", "/api/plan/approve", { case: CASE, id: planId, by: "test" });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body));
  plan = await getPlan(planId);
  assert.strictEqual(plan.status, "approved");
  r = runLead({ action: "revise_plan", reason: "test revise",
    revise: { planId, add: [{ id: "S2", name: "复核", task: "复核", outputs: [] }] } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  plan = await getPlan(planId);
  assert.strictEqual(plan.version, 2);
  assert.strictEqual(plan.status, "pending", "已批准计划被修改后应回到 pending");
  console.log("PASS 2 revise approved plan -> approval revoked");

  // 3) assign_task：创建 WorkItem + Task Envelope
  const nodeId = "T" + TAG;
  r = runLead({ action: "assign_task", reason: "test assign",
    task: { planId, nodeId, name: "Lead 任务", agent: "industry", task: "产出测试产物",
      outputs: [], envelope: { acceptance: ["有结论"], tools: ["case.snapshot"] } } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  const assignAct = (r.j.actions || []).find(a => a.action === "assign_task");
  assert(assignAct && assignAct.ok, "assign_task 应成功");
  const workId = assignAct.workId;
  let work = await getWork(workId);
  assert(work && work.state === "queued");
  assert(work.envelope && Array.isArray(work.envelope.acceptance));
  console.log("PASS 3 assign_task -> WorkItem + envelope");

  // 4) spawn_employee：为 WorkItem 启动 fake Employee Loop，完成后 WorkItem done
  r = runLead({ action: "spawn_employee", reason: "test spawn",
    spawn: { workId, agent: "industry", runtime: "fake", mode: "fake", maxRounds: 1 } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  const spawnAct = (r.j.actions || []).find(a => a.action === "spawn_employee");
  assert(spawnAct && spawnAct.ok, "spawn_employee 应成功: " + JSON.stringify(spawnAct));
  let done = null;
  for (let i = 0; i < 30; i++) {
    work = await getWork(workId);
    if (work && (work.state === "done" || work.state === "failed")) { done = work; break; }
    await lib.sleep(300);
  }
  assert(done, "Employee Loop 未在 9s 内完成");
  assert.strictEqual(done.state, "done", done.error);
  assert(done.loopId, "WorkItem 应记录 loopId");
  assert(done.gate && done.gate.ok, "gate 应通过");
  console.log("PASS 4 spawn_employee -> bounded loop -> WorkItem done");

  // 5) request_review：进入人工复核
  r = runLead({ action: "request_review", reason: "test review",
    review: { title: "复核 " + TAG, detail: "请复核测试产物" } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "waiting_human");
  let needs = (await lib.api("GET", "/api/needs?case=" + encodeURIComponent(CASE))).body.needs || [];
  assert(needs.some(n => String(n.title || "").indexOf("复核 " + TAG) >= 0), "应创建复核 need");
  console.log("PASS 5 request_review -> waiting_human + need");

  // 6) cancel_task：高风险，未审批时只创建审批 need
  r = runLead({ action: "cancel_task", reason: "test cancel",
    cancel: { workId, reason: "测试取消" } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "waiting_human");
  needs = (await lib.api("GET", "/api/needs?case=" + encodeURIComponent(CASE))).body.needs || [];
  assert(needs.some(n => String(n.title || "").indexOf("[取消审批]") >= 0 && String(n.detail || "").indexOf(workId) >= 0), "应创建取消审批 need");
  console.log("PASS 6 cancel_task -> pending human approval");

  // 7) synthesize：只装配不签发；未审批时进入审批等待
  r = runLead({ action: "synthesize", reason: "test synthesize" }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "waiting_human");
  needs = (await lib.api("GET", "/api/needs?case=" + encodeURIComponent(CASE))).body.needs || [];
  assert(needs.some(n => String(n.title || "").startsWith("[装配审批]")), "应创建装配审批 need");
  console.log("PASS 7 synthesize -> pending approval, no sign");

  // 8) 结构化审批 approve：token 校验通过后真正取消 WorkItem
  let wc = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "CANCEL-A-" + TAG,
    agent: "industry", task: "cancel me", outputs: [] });
  assert.strictEqual(wc.status, 200);
  const cancelId = wc.body.item.id;
  let nc = await lib.api("POST", "/api/need", { case: CASE, agent: "lead", kind: "other",
    title: "[取消审批] " + cancelId, detail: "Lead 请求取消 WorkItem " + cancelId, blocking: true });
  assert.strictEqual(nc.status, 200);
  const approvedNeed = nc.body.need;
  let ans = await lib.api("POST", "/api/need/answer", { case: CASE, id: approvedNeed.id,
    decision: "approve", answer: "批准", by: "test" });
  assert.strictEqual(ans.status, 200, JSON.stringify(ans.body));
  assert.strictEqual(ans.body.need.decision, "approve");
  r = runLead({ action: "cancel_task", reason: "approved cancel",
    cancel: { workId: cancelId, reason: "测试已批准取消" } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  const cancelAct = (r.j.actions || []).find(a => a.action === "cancel_task");
  assert(cancelAct && cancelAct.ok, "已批准取消应成功: " + JSON.stringify(cancelAct));
  const cancelledWork = await getWork(cancelId);
  assert.strictEqual(cancelledWork.state, "cancelled");
  needs = (await lib.api("GET", "/api/needs?case=" + encodeURIComponent(CASE))).body.needs || [];
  const usedNeed = needs.find(n => n.id === approvedNeed.id);
  assert(usedNeed && usedNeed.consumedAt, "批准后的 need 应被消费，不能复用");
  console.log("PASS 8 structured approve -> approval token -> WorkItem cancelled + need consumed");

  // 9) 结构化审批 reject：不能执行取消
  wc = await lib.api("POST", "/api/work/create", { case: CASE, nodeId: "CANCEL-R-" + TAG,
    agent: "industry", task: "do not cancel", outputs: [] });
  const rejectId = wc.body.item.id;
  nc = await lib.api("POST", "/api/need", { case: CASE, agent: "lead", kind: "other",
    title: "[取消审批] " + rejectId, detail: "Lead 请求取消 WorkItem " + rejectId, blocking: true });
  ans = await lib.api("POST", "/api/need/answer", { case: CASE, id: nc.body.need.id,
    decision: "reject", answer: "拒绝", by: "test" });
  assert.strictEqual(ans.body.need.decision, "reject");
  r = runLead({ action: "cancel_task", reason: "rejected cancel",
    cancel: { workId: rejectId, reason: "测试被拒绝取消" } }, 1);
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "waiting_human");
  const still = await getWork(rejectId);
  assert.strictEqual(still.state, "queued");
  console.log("PASS 9 structured reject -> cancel not executed");

  // 10) autonomy=workflow：只允许 start/ask/wait/finish，create_plan 被确定性拦截
  r = runLead({ action: "create_plan", reason: "workflow should block",
    plan: { agent: "industry", goal: "blocked", steps: [{ id: "S1", name: "n", task: "t", outputs: [] }] } }, 1, "workflow");
  assert.strictEqual(r.status, 0, r.err || r.out);
  assert.strictEqual(r.j.status, "waiting_human");
  assert((r.j.actions || []).some(a => a.action === "blocked_by_autonomy" && !a.ok), "应记录 autonomy 拦截");
  const plansNow = (await lib.api("GET", "/api/plans?case=" + encodeURIComponent(CASE))).body.plans || [];
  assert(!plansNow.some(p => p.goal === "blocked"), "workflow 模式不应创建计划");
  console.log("PASS 10 autonomy=workflow blocks create_plan");

  console.log("ALL PASS test-lead-actions");
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
