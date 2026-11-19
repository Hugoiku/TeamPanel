#!/usr/bin/env node
"use strict";
/** E2E smoke: 检查主链路 API 是否可用（不调用真实模型）。 */
const http = require("http");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function get(p) { return new Promise((resolve, reject) => http.get(BASE + p, r => { let s = ""; r.on("data", d => s += d); r.on("end", () => { try { resolve({ status: r.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: r.statusCode, body: {} }); } }); }).on("error", reject)); }
const checks = [];
function ok(name, cond, detail) { checks.push({ name, ok: !!cond, detail: detail || "" }); }
(async () => {
  const h = await get("/api/health");
  ok("health", h.status === 200 && h.body.ok, "status " + h.status);
  const cases = await get("/api/cases");
  ok("cases", cases.status === 200 && Array.isArray(cases.body.cases), "n=" + (cases.body.cases || []).length);
  const c = (cases.body.cases || [])[0] && cases.body.cases[0].id;
  const metrics = await get("/api/data/metrics");
  ok("data.metrics", metrics.status === 200 && Array.isArray(metrics.body.metrics), "n=" + (metrics.body.metrics || []).length);
  const plan = await get("/api/data/plan?metric=media.box_office&range=2026-01..2026-10");
  ok("data.plan", plan.status === 200 && Array.isArray(plan.body.sources), "sources=" + (plan.body.sources || []).length);
  const jobs = await get("/api/data/jobs" + (c ? "?case=" + encodeURIComponent(c) : ""));
  ok("data.jobs", jobs.status === 200 && Array.isArray(jobs.body.jobs), "n=" + (jobs.body.jobs || []).length);
  const arc = await get("/api/archive");
  ok("archive", arc.status === 200 && Array.isArray(arc.body.cases), "n=" + (arc.body.cases || []).length);
  if (c) {
    const q = await get("/api/quality?case=" + encodeURIComponent(c));
    ok("quality", q.status === 200 && q.body.case === c, "evidence=" + (q.body.evidence || 0));
    const plans = await get("/api/plans?case=" + encodeURIComponent(c));
    ok("plans", plans.status === 200 && Array.isArray(plans.body.plans), "n=" + (plans.body.plans || []).length);
  }
  const pass = checks.filter(x => x.ok).length;
  console.log(JSON.stringify({ ok: pass === checks.length, pass, total: checks.length, checks }, null, 2));
  process.exit(pass === checks.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
