#!/usr/bin/env node
"use strict";
/** test-data-request — 统一 data.request + source promote（临时 broker） */
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
      let s = ""; res.on("data", d => s += d);
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
  throw new Error("broker not up");
}
(async () => {
  const tmp = fs.mkdtempSync(path.join(ROOT, "runtime/test-data-request-"));
  fs.cpSync(path.join(ROOT, "config"), path.join(tmp, "config"), { recursive: true });
  const port = 8300 + Math.floor(Math.random() * 60);
  const child = spawn(process.execPath, [path.join(ROOT, "runtime/server/broker.js"), "--port", String(port), "--root", tmp],
    { cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env) });
  try {
    await waitHealth(port);
    const CASE = "data-request-test";
    const n1 = await api(port, "POST", "/api/need", { case: CASE, agent: "macro", kind: "data",
      title: "CPI 测试缺口", autoCollect: false,
      spec: { items: [{ indicator: "CPI 同比", definition: "居民消费价格同比", source: "统计局", frequency: "月", range: "2025-01..2026-10", unit: "%", format: "CSV: period,value" }] } });
    const needId = n1.body.need.id;
    const r1 = await api(port, "POST", "/api/data/request", { case: CASE, needId, itemIndex: 0 });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.strictEqual(r1.body.kind, "data_job", JSON.stringify(r1.body));
    assert.strictEqual(r1.body.metric, "macro.cpi");
    assert.strictEqual(r1.body.sourceId, "eastmoney-cpi");
    console.log("PASS 1 data.request chooses DataJob/connector for registered metric");

    const n2 = await api(port, "POST", "/api/need", { case: CASE, agent: "industry", kind: "data",
      title: "未知数据缺口", autoCollect: false,
      spec: { items: [{ indicator: "某未注册指标", definition: "测试", source: "网页", frequency: "年", range: "2025A", unit: "%", format: "CSV: year,value" }] } });
    const r2 = await api(port, "POST", "/api/data/request", { case: CASE, needId: n2.body.need.id, itemIndex: 0,
      url: "https://example.com/data" });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    assert.strictEqual(r2.body.kind, "data_task", JSON.stringify(r2.body));
    console.log("PASS 2 unknown metric + URL falls back to DataTask");

    const promote = await api(port, "POST", "/api/source/promote", { case: CASE, taskId: "DT-test",
      id: "promoted-test-json", name: "测试沉淀源", url: "https://example.com/api",
      metricId: "macro.cpi", kind: "json", periodField: "REPORT_DATE", valueField: "VALUE", unit: "%",
      license: { reportUse: false, redistribute: false } });
    assert.strictEqual(promote.status, 200, JSON.stringify(promote.body));
    assert(fs.existsSync(path.join(tmp, "config/sources/promoted-test-json.json")));
    const reg = JSON.parse(fs.readFileSync(path.join(tmp, "config/data/sources.json"), "utf8"));
    assert(reg.sources.some(s => s.id === "promoted-test-json"));
    const metrics = JSON.parse(fs.readFileSync(path.join(tmp, "config/data/metrics.json"), "utf8"));
    const cpi = metrics.metrics.find(m => m.id === "macro.cpi");
    assert(cpi.sources.indexOf("promoted-test-json") >= 0);
    assert.strictEqual(promote.body.registry.license.reportUse, false);
    console.log("PASS 3 source promote writes source/registry/metric mapping + license");

    const usageRec = await api(port, "POST", "/api/data/source-usage/record", { case: CASE,
      sourceId: "eastmoney-cpi", cost: 2, jobId: "DJ-test", status: "ok" });
    assert.strictEqual(usageRec.status, 200);
    const usageList = await api(port, "GET", "/api/data/source-usage");
    const er = (usageList.body.rows || []).find(x => x.sourceId === "eastmoney-cpi");
    assert(er && er.usedToday >= 2, JSON.stringify(er));
    console.log("PASS 4 source usage record + daily summary");

    const gw = await api(port, "POST", "/api/data/gateway", { case: CASE, sourceId: "eastmoney-cpi",
      metricId: "macro.cpi", query: { range: "2025-01..2026-10" }, jobId: "DJ-test" });
    assert.strictEqual(gw.status, 200, JSON.stringify(gw.body));
    assert(gw.body.ok && (gw.body.records || []).length > 0, JSON.stringify(gw.body).slice(0, 500));
    assert(gw.body.snapshot && gw.body.snapshot.id, "gateway snapshot missing");
    const gw2 = await api(port, "POST", "/api/data/gateway", { case: CASE, sourceId: "eastmoney-cpi",
      metricId: "macro.cpi", query: { range: "2025-01..2026-10" }, jobId: "DJ-test" });
    assert.strictEqual(gw2.body.cached, true, JSON.stringify(gw2.body).slice(0, 300));
    const gw3 = await api(port, "POST", "/api/data/gateway", { case: CASE, sourceId: "eastmoney-cpi",
      metricId: "macro.cpi", query: { range: "2025-01..2026-10" }, jobId: "DJ-test", forceRefresh: true });
    assert.strictEqual(gw3.body.cached, false, JSON.stringify(gw3.body).slice(0, 300));
    console.log("PASS 5 data gateway returns records + snapshot + idempotency/forceRefresh");

    const probe = await api(port, "POST", "/api/data/source-probe", { sourceId: "eastmoney-cpi", metricId: "macro.cpi" });
    assert.strictEqual(probe.status, 200, JSON.stringify(probe.body));
    assert(probe.body.probe && probe.body.probe.ok && probe.body.probe.count > 0, JSON.stringify(probe.body));
    console.log("PASS 6 source probe returns real sample records");

    const matrix = await api(port, "GET", "/api/data/source-matrix");
    const row = (matrix.body.rows || []).find(x => x.id === "eastmoney-cpi");
    assert(row && row.structured === true && (row.metrics || []).indexOf("macro.cpi") >= 0, JSON.stringify(row));
    console.log("PASS 7 source matrix exposes coverage/structured/sampleProbe");

    const policy = require("./source-policy");
    const health = require("./source-health");
    const regSrc = health.loadRegistry();
    const account = regSrc.find(s => s.id === "mysteel");
    const ca = policy.checkSource(account, {});
    assert.strictEqual(ca.code, "needs_credential", JSON.stringify(ca));
    const credit = regSrc.find(s => s.id === "tushare");
    const cc = policy.checkSource(credit, { allowPaid: false });
    assert.strictEqual(cc.code, "needs_paid_approval", JSON.stringify(cc));
    const mof = regSrc.find(s => s.id === "mof");
    const sm = policy.selectSource({ id: "macro.cpi", sources: ["mof"] }, [mof], { requireStructured: true });
    assert(!sm.source && sm.skipped.some(x => x.code === "not_structured"), JSON.stringify(sm));
    console.log("PASS 8 credential/paid policy + non-structured source filtering");
    console.log("ALL PASS test-data-request");
  } finally {
    try { child.kill("SIGTERM"); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error("FAIL", (e && e.stack) || e); process.exit(1); });
