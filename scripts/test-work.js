#!/usr/bin/env node
"use strict";
// WorkItem 状态机/租约/CAS/取消 测试（需要 broker 在 7801 运行）
const http = require("http");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const CASE = "work-test-" + Date.now();
const passes = [], fails = [];
function ok(c, m) { (c ? passes : fails).push(m); console.log((c ? "  ✓ " : "  ✗ ") + m); }
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p), payload = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, x => {
      let s = ""; x.on("data", d => s += d);
      x.on("end", () => { let j = {}; try { j = JSON.parse(s); } catch (e) {} resolve({ status: x.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}
(async () => {
  await req("POST", "/api/case", { case: CASE, ticker: "", name: "work" });
  const plan = await req("POST", "/api/plan", { case: CASE, agent: "macro", goal: "t", by: "test",
    steps: [{ id: "S1", name: "a", task: "a" }, { id: "S2", name: "b", task: "b", depends: ["S1"] }] });
  const pid = plan.body.plan.id;
  await req("POST", "/api/plan/approve", { case: CASE, id: pid, decision: "approve", by: "test" });
  const c1 = await req("POST", "/api/work/create", { case: CASE, planId: pid, nodeId: "S1", agent: "macro", name: "a", task: "a" });
  ok(c1.status === 200 && c1.body.item.state === "queued", "create -> queued");
  ok(c1.body.item.maxWallMs === 2700000, "create 默认 strong wall budget 45min");
  ok(!!c1.body.item.traceId, "create 带 traceId");
  const dup = await req("POST", "/api/work/create", { case: CASE, planId: pid, nodeId: "S1", agent: "macro" });
  ok(dup.body.existing === true && dup.body.item.id === c1.body.item.id, "重复 create 幂等");
  const claim = await req("POST", "/api/work/claim", { case: CASE, owner: "w1" });
  const item = claim.body.item;
  ok(!!item && item.state === "running" && !!item.leaseId, "claim -> running + leaseId");
  const claim2 = await req("POST", "/api/work/claim", { case: CASE, owner: "w2" });
  ok(!claim2.body.item, "running 时其他 worker 领不到同一节点");
  const hbBad = await req("POST", "/api/work/heartbeat", { case: CASE, id: item.id, owner: "w1", leaseId: "bogus" });
  ok(hbBad.status === 409, "错误 leaseId 心跳被拒绝");
  const finBad = await req("POST", "/api/work/finish", { case: CASE, id: item.id, owner: "w1", leaseId: "bogus", ok: true });
  ok(finBad.status === 409, "错误 leaseId finish 被拒绝");
  const cancel = await req("POST", "/api/work/cancel", { case: CASE, id: item.id, reason: "test" });
  ok(cancel.body.item.state === "cancelling" && cancel.body.item.cancelRequested, "cancel running -> cancelling");
  const hb = await req("POST", "/api/work/heartbeat", { case: CASE, id: item.id, owner: "w1", leaseId: item.leaseId });
  ok(hb.status === 200 && hb.body.cancelRequested === true, "心跳返回 cancelRequested");
  const fin = await req("POST", "/api/work/finish", { case: CASE, id: item.id, owner: "w1",
    leaseId: item.leaseId, cancelled: true });
  ok(fin.body.item.state === "cancelled", "finish(cancelled) -> cancelled");
  const cBad = await req("POST", "/api/work/create", { case: CASE, planId: pid, nodeId: "S4", agent: "macro",
    outputs: ["需修正项清单及处理结果"] });
  ok(cBad.status === 400, "create 拒绝无文件路径的输出契约");
  const c2 = await req("POST", "/api/work/create", { case: CASE, planId: pid, nodeId: "S2", agent: "macro", depends: ["S1"] });
  const can2 = await req("POST", "/api/work/cancel", { case: CASE, id: c2.body.item.id, reason: "queued" });
  ok(can2.body.item.state === "cancelled", "cancel queued -> cancelled");
  const c3 = await req("POST", "/api/work/create", { case: CASE, planId: pid, nodeId: "S3", agent: "macro" });
  const cl3 = await req("POST", "/api/work/claim", { case: CASE, owner: "w3" });
  const f3 = await req("POST", "/api/work/finish", { case: CASE, id: cl3.body.item.id, owner: "w3",
    leaseId: cl3.body.item.leaseId, ok: false, error: "wall_time_exceeded: 2000s > 1800s" });
  ok(f3.body.item.failureKind === "wall_timeout", "finish 标记 failureKind=wall_timeout");
  ok(f3.body.item.recovery && f3.body.item.recovery.action === "split", "wall_timeout 生成拆分恢复建议");
  const est = require("./task-estimator").estimate({ name: "估值与三情景", task: "DDM 目标价 三情景 可比",
    outputs: ["a.md", "b.md", "c.md", "d.md"], tier: "strong" });
  ok(est.splitSuggested && est.wallMs >= 45 * 60 * 1000, "task estimator 给出拆分/预算建议");
  await req("POST", "/api/case/delete", { case: CASE, confirm: true }).catch(() => {});
  console.log("\n通过 " + passes.length + " 项，失败 " + fails.length + " 项");
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
