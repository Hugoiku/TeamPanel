#!/usr/bin/env node
"use strict";
/**
 * test-datatask-restart — DataTask 重启对账：
 * parsing attempt 在 broker 重启后不能永久卡住，必须转 needs_more/needs_human。
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
function startBroker(port, root) {
  return spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"), "--port", String(port), "--root", root],
    { cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env) });
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "runtime/test-datatask-restart-"));
  fs.cpSync(path.join(ROOT, "config"), path.join(tmp, "config"), { recursive: true });
  const port = 8200 + Math.floor(Math.random() * 50);
  let child = startBroker(port, tmp);
  try {
    await waitHealth(port);
    const CASE = "dt-restart";
    const n = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "重启测试缺口", autoCollect: false,
      spec: { items: [{ indicator: "月频值", definition: "测试", source: "test", frequency: "月",
        range: "2026-01至2026-03", unit: "亿元", format: "CSV: period,value" }] } });
    const needId = n.body.need.id;
    const c = await api(port, "POST", "/api/datatask", { case: CASE, needId,
      sources: [{ kind: "url", ref: "https://example.com/data" }] });
    const taskId = c.body.task.id;
    const s = await api(port, "POST", "/api/datatask/start", { case: CASE, id: taskId, dryRun: true });
    assert.strictEqual(s.body.task.status, "parsing", JSON.stringify(s.body));
    child.kill("SIGTERM");
    await sleep(600);
    child = startBroker(port, tmp);
    await waitHealth(port);
    const g = await api(port, "GET", "/api/datatask/get?case=" + CASE + "&id=" + taskId);
    assert.strictEqual(g.status, 200, JSON.stringify(g.body));
    const t = g.body.task;
    assert(["needs_more", "needs_human"].indexOf(t.status) >= 0, JSON.stringify(t));
    assert.strictEqual(t.attempts[0].status, "failed", JSON.stringify(t.attempts));
    assert(/broker restart/.test(t.attempts[0].error || ""), t.attempts[0].error);
    console.log("ALL PASS test-datatask-restart (parsing -> failed on restart, not stuck)");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
