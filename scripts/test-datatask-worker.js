#!/usr/bin/env node
"use strict";
/**
 * test-datatask-worker — 真实 worker 文件解析验收（临时 broker + 临时 vault）：
 * 文件来源 → datatask-worker → CSV 表格 → 候选 → gate → confirm。
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
(async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "runtime/test-datatask-worker-"));
  fs.cpSync(path.join(ROOT, "config"), path.join(tmp, "config"), { recursive: true });
  const port = 8100 + Math.floor(Math.random() * 60);
  const child = spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"), "--port", String(port), "--root", tmp],
    { cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env) });
  try {
    await waitHealth(port);
    const CASE = "dt-worker-file";
    const n = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "文件测试缺口", autoCollect: false,
      spec: { items: [{ indicator: "月频测试值", definition: "测试", source: "test", frequency: "月",
        range: "2026-01至2026-03", unit: "亿元", format: "CSV: period,value" }] } });
    assert.strictEqual(n.status, 200, JSON.stringify(n.body));
    const needId = n.body.need.id;
    fs.mkdirSync(path.join(tmp, "vault", CASE, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "vault", CASE, "uploads", "test.csv"), "period,value\n2026-01,1\n2026-02,2\n2026-03,3\n");
    const c = await api(port, "POST", "/api/datatask", { case: CASE, needId,
      sources: [{ kind: "file", ref: "uploads/test.csv" }] });
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    const id = c.body.task.id;
    const s = await api(port, "POST", "/api/datatask/start", { case: CASE, id });
    assert.strictEqual(s.status, 200, JSON.stringify(s.body));
    assert.strictEqual(s.body.task.status, "parsing");
    let t = null;
    for (let i = 0; i < 80; i++) {
      await sleep(400);
      const g = await api(port, "GET", "/api/datatask/get?case=" + CASE + "&id=" + id);
      t = g.body.task;
      if (t && ["ready_for_review", "needs_more", "needs_human", "failed"].indexOf(t.status) >= 0) break;
    }
    assert(t, "worker 未回传任务");
    assert.strictEqual(t.status, "ready_for_review", JSON.stringify(t.coverage));
    assert.strictEqual(t.candidates.length, 3, JSON.stringify(t.candidates));
    assert.deepStrictEqual(t.candidates.map(x => x.period).sort(), ["2026-01", "2026-02", "2026-03"]);
    const cf = await api(port, "POST", "/api/datatask/confirm", { case: CASE, id });
    assert.strictEqual(cf.status, 200, JSON.stringify(cf.body));
    assert.strictEqual(cf.body.task.status, "closed");
    console.log("ALL PASS test-datatask-worker (file -> worker -> candidates -> gate -> confirm)");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
