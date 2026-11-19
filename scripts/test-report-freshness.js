#!/usr/bin/env node
"use strict";
/**
 * test-report-freshness — 报告数据新鲜度门禁验收（需要 broker 已启动）。
 *   1) 自动采集出过期项 → /api/report/freshness 有 stale
 *   2) 签发返回 409 data_stale
 *   3) acceptStale + reason 后不再被 data_stale 拦截（继续走到审计/法务门禁）
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const CASE = "__tmp_freshness_" + Date.now().toString(36) + "__";
function pass(m) { console.log("PASS " + m); }
function fail(m) { console.error("FAIL " + m); process.exitCode = 1; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j || {} };
}
function cleanup() {
  try { fs.rmSync(path.join(ROOT, "vault", CASE), { recursive: true, force: true }); } catch (e) {}
  try {
    for (const f of fs.readdirSync(path.join(ROOT, "runtime/data/jobs"))) {
      const p = path.join(ROOT, "runtime/data/jobs", f);
      try { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j.case === CASE) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}
(async () => {
  try {
    const h = await api("GET", "/api/health");
    if (!h.body || !h.body.ok) { console.log("SKIP broker 未启动：" + BASE); return; }
    await api("POST", "/api/case", { case: CASE, name: CASE, uniqueId: false });
    const need = await api("POST", "/api/need", { case: CASE, agent: "macro", kind: "data", blocking: false,
      title: "新鲜度门禁验收", detail: "M1 新鲜 + 社融过期",
      spec: { range: "2025-01..2026-11", items: [
        { indicator: "M1同比", range: "2025-01..2026-10" },
        { indicator: "社融", range: "2025-01..2026-04" }
      ] }, autoCollect: true });
    const needId = need.body.need && need.body.need.id;
    if (!needId) { fail("创建 need 失败"); return; }
    let n = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
      n = (r.body.needs || []).find(x => x.id === needId);
      if (n && ((n.spec && n.spec.items) || []).some(it => it.auto && it.auto.dataAsOf)) break;
    }
    const fresh = await api("GET", "/api/report/freshness?case=" + encodeURIComponent(CASE));
    const items = fresh.body.items || [];
    const stale = fresh.body.stale || [];
    if (items.length >= 2) pass("freshness 返回 " + items.length + " 项 dataAsOf");
    else fail("freshness 项不足：" + items.length);
    if (stale.some(x => /社融/.test(x.indicator || ""))) pass("社融被标记 stale");
    else fail("社融未被标记 stale：" + JSON.stringify(stale));

    // 造一个最终报告文件 + manifest，让签发门禁能走到 freshness 检查
    const repDir = path.join(ROOT, "vault", CASE, "reports");
    fs.mkdirSync(repDir, { recursive: true });
    fs.writeFileSync(path.join(repDir, "final-report.docx"), Buffer.from("dummy docx"));
    fs.writeFileSync(path.join(repDir, "final-manifest.json"), JSON.stringify({ version: 1, case: CASE }, null, 2));

    const sign = await api("POST", "/api/report/sign", { case: CASE, path: "reports/final-report.docx", by: "test" });
    if (sign.status === 409 && sign.body.code === "data_stale") pass("签发被 data_stale 拦截");
    else fail("签发未被 data_stale 拦截：" + sign.status + " " + JSON.stringify(sign.body).slice(0, 200));
    if ((sign.body.staleItems || []).some(x => /社融/.test(x.indicator || ""))) pass("409 返回过期项明细");
    else fail("409 缺少过期项明细");

    const sign2 = await api("POST", "/api/report/sign", { case: CASE, path: "reports/final-report.docx", by: "test",
      acceptStale: true, reason: "验收测试：已知社融滞后，报告会标注数据截至" });
    if (sign2.status === 409 && sign2.body.code !== "data_stale") pass("acceptStale 后不再被 data_stale 拦截（继续到审计/法务门禁）");
    else if (sign2.status === 200) pass("acceptStale 后签发成功");
    else fail("acceptStale 后仍异常：" + sign2.status + " " + JSON.stringify(sign2.body).slice(0, 200));
  } catch (e) {
    fail("异常：" + String((e && e.message) || e));
  } finally {
    try { await api("POST", "/api/case/delete", { case: CASE, confirm: true, by: "test" }); } catch (e) {}
    cleanup();
    console.log(process.exitCode ? "\n结果：FAIL" : "\n结果：PASS");
  }
})();
