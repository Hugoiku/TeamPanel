#!/usr/bin/env node
"use strict";
/**
 * test-budget-reservation — 预算闭环验收（独立临时 broker，不改全局 config）：
 * reserve/release 原子占位、WorkItem claim 预留、finish 释放、WorkItem token 超限失败。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..");

function api(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: "127.0.0.1", port, path: p, method, agent: false,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, res => {
      let s = "";
      res.on("data", d => s += d);
      res.on("end", () => { let j = {}; try { j = s ? JSON.parse(s) : {}; } catch (e) { j = { raw: s }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await api(port, "GET", "/api/health"); if (r.status === 200) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error("临时 broker 未启动");
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "runtime/test-budget-"));
  const cfgSrc = path.join(ROOT, "config");
  fs.cpSync(cfgSrc, path.join(tmp, "config"), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, "config/desk.json"), "utf8"));
  cfg.budgets.maxTokensPerCase = 100000;
  cfg.budgets.defaultWorkReserve = 60000;
  cfg.budgets.reservationTtlMs = 60000;
  fs.writeFileSync(path.join(tmp, "config/desk.json"), JSON.stringify(cfg, null, 2) + "\n");
  const port = 7900 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"), "--port", String(port), "--root", tmp],
    { cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env) });
  try {
    await waitHealth(port);
    const CASE = "budget-test";

    // 1) 原子预留：两笔 60k 只能成功一笔
    const r1 = await api(port, "POST", "/api/budget/reserve", { case: CASE, amount: 60000, owner: "test" });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert(r1.body.reservation && r1.body.reservation.id);
    const r2 = await api(port, "POST", "/api/budget/reserve", { case: CASE, amount: 60000, owner: "test" });
    assert.strictEqual(r2.status, 409);
    assert.strictEqual(r2.body.code, "budget_exceeded");
    const g1 = await api(port, "GET", "/api/budget?case=" + CASE);
    assert.strictEqual(g1.body.reserved, 60000);
    assert.strictEqual(g1.body.available, 40000);
    const rel = await api(port, "POST", "/api/budget/release", { case: CASE, reservationId: r1.body.reservation.id, reason: "test" });
    assert.strictEqual(rel.status, 200);
    assert.strictEqual(rel.body.budget.reserved, 0);
    console.log("PASS 1 reserve blocks overspend and release restores availability");

    // 2) WorkItem claim 预留 30k，finish 释放
    const c1 = await api(port, "POST", "/api/work/create", { case: CASE, nodeId: "S1", agent: "industry",
      task: "t", outputs: [], maxTokens: 30000 });
    const cl1 = await api(port, "POST", "/api/work/claim", { case: CASE, owner: "test", leaseMs: 120000 });
    assert.strictEqual(cl1.status, 200, JSON.stringify(cl1.body));
    assert(cl1.body.item.budgetReservation, "claim 应产生 reservation");
    assert.strictEqual(cl1.body.item.budgetReserved, 30000);
    const g2 = await api(port, "GET", "/api/budget?case=" + CASE);
    assert.strictEqual(g2.body.reserved, 30000);
    const f1 = await api(port, "POST", "/api/work/finish", { case: CASE, id: cl1.body.item.id,
      owner: "test", leaseId: cl1.body.item.leaseId, ok: true, outputs: [] });
    assert.strictEqual(f1.status, 200);
    assert.strictEqual(f1.body.item.state, "done");
    const g3 = await api(port, "GET", "/api/budget?case=" + CASE);
    assert.strictEqual(g3.body.reserved, 0);
    console.log("PASS 2 claim reserves WorkItem budget; finish releases it");

    // 3) 超过 case 余额的 WorkItem 不能被 claim
    const c2 = await api(port, "POST", "/api/work/create", { case: CASE, nodeId: "S2", agent: "industry",
      task: "t2", outputs: [], maxTokens: 200000 });
    const cl2 = await api(port, "POST", "/api/work/claim", { case: CASE, owner: "test", leaseMs: 120000 });
    assert.strictEqual(cl2.status, 200);
    assert.strictEqual(cl2.body.item, null);
    assert.strictEqual(cl2.body.reason, "budget");
    console.log("PASS 3 over-budget WorkItem claim is rejected");

    // 4) WorkItem token 超限：finish 必须 failed + needsReview（独立 case，避免被 S2 排队挡住）
    const CASE4 = "budget-test-workcap";
    await api(port, "POST", "/api/work/create", { case: CASE4, nodeId: "S1", agent: "industry",
      task: "t3", outputs: [], maxTokens: 10 });
    const cl3 = await api(port, "POST", "/api/work/claim", { case: CASE4, owner: "test", leaseMs: 120000 });
    assert.strictEqual(cl3.status, 200);
    assert(cl3.body.item, JSON.stringify(cl3.body));
    await api(port, "POST", "/api/event", { case: CASE4, type: "agent.usage", actor: "industry",
      workId: cl3.body.item.id, totalTokens: 20 });
    const f3 = await api(port, "POST", "/api/work/finish", { case: CASE4, id: cl3.body.item.id,
      owner: "test", leaseId: cl3.body.item.leaseId, ok: true, outputs: [] });
    assert.strictEqual(f3.status, 200);
    assert.strictEqual(f3.body.item.state, "failed");
    assert.strictEqual(f3.body.item.needsReview, true);
    assert(/token budget exceeded/.test(f3.body.item.error || ""), f3.body.item.error);
    const g4 = await api(port, "GET", "/api/budget?case=" + CASE4);
    assert.strictEqual(g4.body.reserved, 0);
    console.log("PASS 4 WorkItem token overrun -> failed + needsReview, reservation released");

    console.log("ALL PASS test-budget-reservation");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
