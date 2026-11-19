#!/usr/bin/env node
"use strict";
/**
 * test-datatask-flow — DataTask 端到端验收（临时 broker）：
 * 创建 → 策略 → start(dryRun) → finish → gate → confirm 事务 → need 关闭；
 * 以及 needs_more → waive → 关闭；attemptKey 去重。
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
  for (let i = 0; i < 80; i++) {
    try { const r = await api(port, "GET", "/api/health"); if (r.status === 200) return; } catch (e) {}
    await sleep(150);
  }
  throw new Error("临时 broker 未启动");
}
function spec() {
  return { items: [
    { indicator: "测试月频指标", definition: "月频测试值", source: "test", frequency: "月", range: "2026-01至2026-03", unit: "亿元", format: "CSV: period,value" },
    { indicator: "测试文本规则", definition: "规则说明", source: "test", frequency: "一次性确认", range: "现行", unit: "%", format: "文本说明" }
  ] };
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "runtime/test-datatask-"));
  fs.cpSync(path.join(ROOT, "config"), path.join(tmp, "config"), { recursive: true });
  const port = 8000 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"), "--port", String(port), "--root", tmp],
    { cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env) });
  try {
    await waitHealth(port);
    const CASE = "datatask-test";

    // 1) 建 need + DataTask
    const n1 = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "测试数据缺口", spec: spec(), autoCollect: false });
    assert.strictEqual(n1.status, 200, JSON.stringify(n1.body));
    const needId = n1.body.need.id;
    const c1 = await api(port, "POST", "/api/datatask", { case: CASE, needId,
      sources: [{ kind: "url", ref: "https://example.com/data" }] });
    assert.strictEqual(c1.status, 200, JSON.stringify(c1.body));
    assert.strictEqual(c1.body.task.status, "ready");
    assert.strictEqual(c1.body.task.contract.items.length, 2);
    const taskId = c1.body.task.id;
    const nq1 = await api(port, "GET", "/api/needs?case=" + CASE);
    const needQ1 = (nq1.body.needs || []).find(x => x.id === needId);
    assert.strictEqual(needQ1.stage, "datatask_ready", JSON.stringify(needQ1));
    assert.strictEqual(needQ1.queue, "human");

    // 2) 策略：内网 URL 被拒绝
    const CASE_BAD = "datatask-policy";
    const nBad = await api(port, "POST", "/api/need", { case: CASE_BAD, agent: "industry", kind: "data",
      title: "测试策略缺口", spec: spec(), autoCollect: false });
    const cBad = await api(port, "POST", "/api/datatask", { case: CASE_BAD, needId: nBad.body.need.id,
      sources: [{ kind: "url", ref: "http://127.0.0.1/secret" }] });
    assert.strictEqual(cBad.status, 400, JSON.stringify(cBad.body));

    // 3) start dryRun → finish → ready_for_review
    const s1 = await api(port, "POST", "/api/datatask/start", { case: CASE, id: taskId, dryRun: true });
    assert.strictEqual(s1.status, 200, JSON.stringify(s1.body));
    assert.strictEqual(s1.body.task.status, "parsing");
    const attemptId = s1.body.task.attempts[0].id;
    const nq2 = await api(port, "GET", "/api/needs?case=" + CASE);
    const needQ2 = (nq2.body.needs || []).find(x => x.id === needId);
    assert.strictEqual(needQ2.stage, "datatask_running", JSON.stringify(needQ2));
    assert.strictEqual(needQ2.queue, "auto");
    const records = [
      { itemIndex: 0, name: "测试月频指标", value: "1", period: "2026-01", unit: "亿元", sourceUrl: "https://example.com/data", confidence: 0.9, locator: { page: 1, tableRow: 2 } },
      { itemIndex: 0, name: "测试月频指标", value: "2", period: "2026-02", unit: "亿元", sourceUrl: "https://example.com/data", confidence: 0.9, locator: { page: 1, tableRow: 3 } },
      { itemIndex: 0, name: "测试月频指标", value: "3", period: "2026-03", unit: "亿元", sourceUrl: "https://example.com/data", confidence: 0.9, locator: { page: 1, tableRow: 4 } },
      { itemIndex: 1, name: "测试文本规则", value: "20%", period: "现行", unit: "%", sourceUrl: "https://example.com/rule", confidence: 0.9, locator: { page: 1 } }
    ];
    const f1 = await api(port, "POST", "/api/datatask/attempt/finish", { case: CASE, id: taskId, attemptId, ok: true, records });
    assert.strictEqual(f1.status, 200, JSON.stringify(f1.body));
    assert.strictEqual(f1.body.task.status, "ready_for_review", JSON.stringify(f1.body.task.coverage));
    assert.notStrictEqual(f1.body.task.coverage.gate, "fail");
    assert.strictEqual(f1.body.task.candidates.length, 4);
    const nq3 = await api(port, "GET", "/api/needs?case=" + CASE);
    const needQ3 = (nq3.body.needs || []).find(x => x.id === needId);
    assert.strictEqual(needQ3.stage, "datatask_review", JSON.stringify(needQ3));
    assert.strictEqual(needQ3.queue, "human");

    // 4) confirm → 事务写入 → need 关闭
    const cf = await api(port, "POST", "/api/datatask/confirm", { case: CASE, id: taskId });
    assert.strictEqual(cf.status, 200, JSON.stringify(cf.body));
    assert.strictEqual(cf.body.task.status, "closed");
    const needs = await api(port, "GET", "/api/needs?case=" + CASE);
    const need = (needs.body.needs || []).find(x => x.id === needId);
    assert.strictEqual(need.status, "answered");
    const evFile = path.join(tmp, "vault", CASE, "evidence/sources.jsonl");
    const evs = fs.readFileSync(evFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.strictEqual(evs.length, 2, "应写入 2 条证据");
    assert(evs.every(e => e.writeBatchId && e.taskId === taskId), JSON.stringify(evs));
    assert(evs.some(e => Array.isArray(e.records) && e.records.length === 3), JSON.stringify(evs.map(e => ({ id: e.id, records: (e.records || []).length }))));
    console.log("PASS 1 create -> start -> finish -> gate -> confirm -> need closed, evidence batch written");

    // 5) needs_more -> waive -> closed
    const n2 = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "测试缺口2", spec: spec(), autoCollect: false });
    const need2 = n2.body.need.id;
    const c2 = await api(port, "POST", "/api/datatask", { case: CASE, needId: need2,
      sources: [{ kind: "url", ref: "https://example.com/data2" }] });
    const task2 = c2.body.task.id;
    const s2 = await api(port, "POST", "/api/datatask/start", { case: CASE, id: task2, dryRun: true });
    const a2 = s2.body.task.attempts[0].id;
    const f2 = await api(port, "POST", "/api/datatask/attempt/finish", { case: CASE, id: task2, attemptId: a2, ok: true,
      records: [
        { itemIndex: 0, value: "1", period: "2026-01", unit: "亿元", sourceUrl: "https://example.com/data2", confidence: 0.9, locator: { page: 1 } },
        { itemIndex: 0, value: "2", period: "2026-02", unit: "亿元", sourceUrl: "https://example.com/data2", confidence: 0.9, locator: { page: 1 } },
        { itemIndex: 0, value: "3", period: "2026-03", unit: "亿元", sourceUrl: "https://example.com/data2", confidence: 0.9, locator: { page: 1 } }
      ] });
    assert.strictEqual(f2.body.task.status, "needs_more", JSON.stringify(f2.body.task.coverage));
    const w = await api(port, "POST", "/api/datatask/waive", { case: CASE, id: task2, itemIndex: 1, reason: "规则不适用" });
    assert.strictEqual(w.status, 200, JSON.stringify(w.body));
    assert.strictEqual(w.body.task.status, "ready_for_review", JSON.stringify(w.body.task.coverage));
    const cf2 = await api(port, "POST", "/api/datatask/confirm", { case: CASE, id: task2 });
    assert.strictEqual(cf2.status, 200, JSON.stringify(cf2.body));
    assert.strictEqual(cf2.body.task.status, "closed");
    const needs2 = await api(port, "GET", "/api/needs?case=" + CASE);
    assert.strictEqual((needs2.body.needs || []).find(x => x.id === need2).status, "answered");
    console.log("PASS 2 needs_more -> waive -> ready -> confirm -> closed");

    // 6) 同一来源/策略不能无限重试
    const n3 = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "测试缺口3", spec: spec(), autoCollect: false });
    const c3 = await api(port, "POST", "/api/datatask", { case: CASE, needId: n3.body.need.id,
      sources: [{ kind: "url", ref: "https://example.com/data3" }] });
    const task3 = c3.body.task.id;
    const s3 = await api(port, "POST", "/api/datatask/start", { case: CASE, id: task3, dryRun: true });
    const a3 = s3.body.task.attempts[0].id;
    await api(port, "POST", "/api/datatask/attempt/finish", { case: CASE, id: task3, attemptId: a3, ok: true, records: [] });
    const s4 = await api(port, "POST", "/api/datatask/start", { case: CASE, id: task3, dryRun: true });
    assert.strictEqual(s4.status, 409, JSON.stringify(s4.body));
    assert(/同一来源/.test(s4.body.error || ""), s4.body.error);
    console.log("PASS 3 same source/strategy retry rejected");

    // 4) 子集任务：只补第 1 项，任务可关闭，need 仍 pending 等第 2 项
    const CASE_SUB = "datatask-subset";
    const n4b = await api(port, "POST", "/api/need", { case: CASE_SUB, agent: "industry", kind: "data",
      title: "子集任务缺口", spec: spec(), autoCollect: false });
    const need4 = n4b.body.need.id;
    const c4b = await api(port, "POST", "/api/datatask", { case: CASE_SUB, needId: need4, itemIndexes: [0],
      sources: [{ kind: "url", ref: "https://example.com/subset" }] });
    const task4 = c4b.body.task.id;
    const s4b = await api(port, "POST", "/api/datatask/start", { case: CASE_SUB, id: task4, dryRun: true });
    const a4 = s4b.body.task.attempts[0].id;
    const f4b = await api(port, "POST", "/api/datatask/attempt/finish", { case: CASE_SUB, id: task4, attemptId: a4, ok: true,
      records: [
        { itemIndex: 0, value: "1", period: "2026-01", unit: "亿元", sourceUrl: "https://example.com/subset", confidence: 0.9, locator: { page: 1 } },
        { itemIndex: 0, value: "2", period: "2026-02", unit: "亿元", sourceUrl: "https://example.com/subset", confidence: 0.9, locator: { page: 1 } },
        { itemIndex: 0, value: "3", period: "2026-03", unit: "亿元", sourceUrl: "https://example.com/subset", confidence: 0.9, locator: { page: 1 } }
      ] });
    assert.strictEqual(f4b.body.task.status, "ready_for_review", JSON.stringify(f4b.body.task.coverage));
    const cf4b = await api(port, "POST", "/api/datatask/confirm", { case: CASE_SUB, id: task4 });
    assert.strictEqual(cf4b.status, 200, JSON.stringify(cf4b.body));
    assert.strictEqual(cf4b.body.task.status, "closed");
    const needs4 = await api(port, "GET", "/api/needs?case=" + CASE_SUB);
    const need4v = (needs4.body.needs || []).find(x => x.id === need4);
    if (!need4v) console.log("DEBUG needs4", JSON.stringify(needs4.body).slice(0, 1000));
    assert.strictEqual(need4v.status, "pending", JSON.stringify(need4v));
    assert.strictEqual(need4v.spec.items[0].status, "provided");
    assert(!need4v.spec.items[1].status || need4v.spec.items[1].status === "pending");
    console.log("PASS 4 subset task closed while need remains pending for other items");

    // 5) 单 item 多文件：files 数组必须保留
    const nf = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "多文件测试缺口", autoCollect: false,
      spec: { items: [{ indicator: "多文件指标", definition: "测试", source: "test", frequency: "年度", range: "2025A", unit: "%", format: "CSV: year,value" }] } });
    const nfid = nf.body.need.id;
    const pf = await api(port, "POST", "/api/need/item/provide", { case: CASE, id: nfid, index: 0,
      value: "文件：2 个", files: ["uploads/a.csv", "uploads/b.xlsx"], by: "you" });
    assert.strictEqual(pf.status, 200, JSON.stringify(pf.body));
    assert.strictEqual(pf.body.item.files.length, 2, JSON.stringify(pf.body.item));
    assert.strictEqual(pf.body.item.file, "uploads/a.csv");
    console.log("PASS 5 item provide keeps multiple files");

    console.log("ALL PASS test-datatask-flow");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
