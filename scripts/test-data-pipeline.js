#!/usr/bin/env node
"use strict";
/**
 * test-data-pipeline — 自动采集闭环验收（需要 broker 已启动）：
 *   - 免费源自动采集 → 质量门禁 → S# 证据 → 缺口状态
 *   - 新鲜数据自动关闭；源头滞后的数据进入 quality_pending，不静默关闭
 *
 *   node scripts/test-data-pipeline.js
 *   DESK_BROKER=http://127.0.0.1:7801 node scripts/test-data-pipeline.js
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const CASE = "__tmp_pipeline_" + Date.now().toString(36) + "__";

function fail(msg) { console.error("FAIL " + msg); process.exitCode = 1; }
function pass(msg) { console.log("PASS " + msg); }
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
      title: "自动采集闭环验收", detail: "M1 新鲜 + 社融源头滞后",
      spec: { range: "2025-01..2026-11", items: [
        { indicator: "M1同比", range: "2025-01..2026-10" },
        { indicator: "社融", range: "2025-01..2026-04" }
      ] }, autoCollect: true });
    const needId = need.body.need && need.body.need.id;
    if (!needId) { fail("创建 need 失败：" + JSON.stringify(need.body).slice(0, 200)); return; }

    let n = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
      n = (r.body.needs || []).find(x => x.id === needId);
      if (!n) continue;
      const items = (n.spec && n.spec.items) || [];
      if (items.every(it => it.auto && ["done", "needs_review", "failed", "no_source", "partial"].indexOf(it.auto.status) >= 0)) break;
    }
    if (!n) { fail("need 未生成"); return; }
    const items = (n.spec && n.spec.items) || [];
    const m1 = items.find(x => /M1/.test(x.indicator || ""));
    const tsf = items.find(x => /社融/.test(x.indicator || ""));
    if (!m1 || !tsf) { fail("缺少 M1/社融 item"); return; }

    if (m1.status === "provided" && m1.auto && m1.auto.status === "done") pass("M1 自动采集通过并关闭");
    else fail("M1 未通过：" + JSON.stringify(m1.auto || {}).slice(0, 200));
    if (m1.evidenceId && /^S\d+$/.test(m1.evidenceId)) pass("M1 绑定证据 " + m1.evidenceId);
    else fail("M1 缺少 evidenceId");
    if (m1.dataAsOf === "2026-10" || (m1.auto && m1.auto.dataAsOf === "2026-10")) pass("M1 dataAsOf=2026-10");
    else fail("M1 dataAsOf 不正确：" + (m1.dataAsOf || (m1.auto && m1.auto.dataAsOf)));

    if (tsf.auto && tsf.auto.status === "needs_review") pass("社融源头滞后 → needs_review（未静默关闭）");
    else fail("社融应 needs_review，实际 " + JSON.stringify(tsf.auto || {}).slice(0, 200));
    if (tsf.auto && /数据质量/.test(tsf.auto.reason || "")) pass("社融 reason 含数据质量门禁");
    else fail("社融 reason 缺少质量门禁：" + (tsf.auto && tsf.auto.reason));
    if (n.stage === "quality_pending") pass("need stage=quality_pending");
    else fail("need stage 应为 quality_pending，实际 " + n.stage);

    const evFile = path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl");
    const evs = fs.existsSync(evFile) ? fs.readFileSync(evFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    if (evs.length >= 2) pass("自动采集写入 " + evs.length + " 条 S# 证据");
    else fail("证据数量不足：" + evs.length);
    if (evs.every(e => e.id && e.url && e.sha256 && e.value && e.value.latest)) pass("证据含 url/sha256/latest");
    else fail("证据字段不完整：" + JSON.stringify(evs.map(e => ({ id: e.id, url: !!e.url, sha: !!e.sha256, latest: !!(e.value && e.value.latest) }))));

    const evt = await api("GET", "/api/events?case=" + encodeURIComponent(CASE) + "&limit=500");
    if ((evt.body.events || []).some(e => e.type === "data.job.evidence")) pass("账本记录 data.job.evidence");
    else fail("账本缺少 data.job.evidence");
  } catch (e) {
    fail("异常：" + String((e && e.message) || e));
  } finally {
    try { await api("POST", "/api/case/delete", { case: CASE, confirm: true, by: "test" }); } catch (e) {}
    cleanup();
    console.log(process.exitCode ? "\n结果：FAIL" : "\n结果：PASS");
  }
})();
