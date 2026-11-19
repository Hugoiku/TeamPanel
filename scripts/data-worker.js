#!/usr/bin/env node
"use strict";
/**
 * data-worker — 消费 /api/data/jobs 队列。
 * 只负责：claim → 调 collect → 把原始产物与 records 写回。
 * 不负责：语义判断、口径确认、入库；这些由 intake/审计完成。
 *
 *   node scripts/data-worker.js --case c --once
 *   node scripts/data-worker.js --case c --loop
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const health = require("./source-health");
const sourcePolicy = require("./source-policy");
const dataCrossCheck = require("./data-crosscheck");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, res => {
      let s = ""; res.on("data", d => s += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const CASE = arg("case", "");
if (!CASE) { console.error("--case required"); process.exit(2); }

function loadMetrics() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8")).metrics || []; } catch (e) { return []; }
}
function loadSources() {
  const out = [];
  try {
    const dir = path.join(ROOT, "config/sources");
    fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (j.id) out.push(j); } catch (e) {}
    });
  } catch (e) {}
  let registry = [];
  try { registry = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/sources.json"), "utf8")).sources || []; } catch (e) {}
  return { sources: out, registry };
}
function collect(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/collect.js")].concat(args),
    { cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024, env: process.env });
  let json = null;
  try { json = JSON.parse(String(r.stdout || "").trim()); } catch (e) {
    const lines = String(r.stdout || "").trim().split(String.fromCharCode(10)).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) { try { json = JSON.parse(lines[i]); break; } catch (e2) {} }
  }
  return { status: r.status, json, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}
function readRecords(outPath, reg) {
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve(ROOT, outPath), "utf8"));
    const arr = Array.isArray(j.records) ? j.records :
      (Array.isArray(j.data) ? j.data :
      (j && j.result && Array.isArray(j.result.data) ? j.result.data :
      (j && Array.isArray(j.result) ? j.result : null)));
    if (!arr) return null;
    if (!reg || !reg.connector) return arr;
    const pf = reg.periodField || "REPORT_DATE", vf = reg.valueField || "VALUE";
    return arr.map(x => {
      let p = x[pf] || x.TIME || x.DATE || x.period || "";
      p = String(p).replace(/年(\d{1,2})月/, "-$1").replace(/[^0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      if (/^\d{4}-\d{2}/.test(p)) p = p.slice(0, 7);
      const v = Number(x[vf]);
      return { period: p, value: v, unit: reg.unit || x.unit || "" };
    }).filter(x => /^\d{4}-\d{2}$/.test(x.period) && Number.isFinite(x.value));
  } catch (e) {}
  return null;
}
async function runSource(job, sourceId, sources, registry, opts) {
  let args, sourceLabel = sourceId;
  const suffix = (opts && opts.suffix) ? "-" + opts.suffix : "";
  const src = sources.find(x => x.id === sourceId);
  const regSel = (registry || []).find(x => x.id === sourceId);
  // 统一收口：DataJob 的源调用走 broker DataGateway（配额/幂等/契约/快照）。
  if (sourceId === "__url__" && job.url && job.useGateway !== false) {
    const g = await api("POST", "/api/data/gateway", { case: job.case, mode: "raw", url: job.url,
      jobId: job.id, idempotencyKey: job.id + ":url" });
    if (g.status === 200 && g.body && g.body.ok) {
      return { ok: true, result: { out: g.body.out || "", raw: g.body.raw || "", records: [],
        snapshot: g.body.snapshot || null } };
    }
    return { ok: false, error: String((g.body && g.body.error) || ("gateway http " + g.status)).slice(0, 800) };
  }
  if (sourceId !== "__url__" && job.useGateway !== false) {
    const g = await api("POST", "/api/data/gateway", { case: job.case, sourceId,
      metricId: job.metric || "", query: { range: job.range || "" }, jobId: job.id,
      allowPaid: job.allowPaid === true, forceRefresh: job.forceRefresh === true,
      idempotencyKey: job.id + ":" + sourceId });
    if (g.status === 200 && g.body && g.body.ok) {
      return { ok: true, result: { out: g.body.out || "", raw: g.body.raw || "", records: g.body.records || [],
        snapshot: g.body.snapshot || null } };
    }
    return { ok: false, error: String((g.body && g.body.error) || ("gateway http " + g.status)).slice(0, 800) };
  }
  if (!job.url && regSel && regSel.recipeId) {
    const outPath = "runtime/data/raw/" + job.id + "-recipe" + suffix + ".json";
    const cr = spawnSync(process.execPath, [path.join(ROOT, "scripts/connector.js"),
      "--run", "--id", regSel.recipeId, "--out", outPath],
      { cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    let cj = null;
    try { cj = JSON.parse(String(cr.stdout || "").trim()); } catch (e) {}
    if (cr.status === 0 && cj && cj.ok && Array.isArray(cj.records) && cj.records.length) {
      return { ok: true, result: { out: outPath, raw: "", records: cj.records } };
    }
    return { ok: false, error: String((cj && cj.error) || cr.stderr || ("connector exit " + cr.status)).slice(0, 800) };
  }
  if (job.url) {
    args = ["get", job.url, "--out", "runtime/data/raw/" + job.id + ".md"];
    sourceLabel = job.url;
  } else if (src) {
    args = ["source", sourceId, "--out", "runtime/data/raw/" + job.id + suffix + ".json"];
    // 通用 connector 需要按 job 的时间范围取数；source 配置用 {range} 声明即可。
    if (src.vars && src.vars.range !== undefined && job.range) args.push("--var", "range=" + job.range);
  } else {
    const reg = regSel;
    if (reg && reg.configSource && reg.configSource !== "web") {
      args = ["source", reg.configSource, "--out", "runtime/data/raw/" + job.id + suffix + ".json"];
      sourceLabel = reg.configSource;
    } else {
      return { ok: false, error: "source has no direct connector: " + sourceId };
    }
  }
  args.push("--no-need");
  const r = collect(args);
  const j = r.json || {};
  const outPath = j.out || ("runtime/data/raw/" + job.id + ".md");
  const reg = (registry || []).find(x => x.id === sourceId || x.configSource === sourceLabel);
  let records = Array.isArray(j.records) ? j.records : (j.out ? readRecords(j.out, reg || regSel) : null);
  if (!records) records = [];
  records = records.filter(x => x && x.period !== undefined && x.value !== undefined)
    .map(x => ({ period: String(x.period), value: Number(x.value), unit: String(x.unit || "") }))
    .filter(x => Number.isFinite(x.value));
  if (r.status !== 0 || j.ok === false) {
    return { ok: false, error: String(j.error || r.stderr || ("exit " + r.status)).slice(0, 800) };
  }
  if (!records.length) {
    return { ok: false, empty: true, error: "抓取成功但未得到结构化 records，需要模型/审计解析" };
  }
  return { ok: true, result: { out: outPath, raw: j.raw || "", records } };
}

async function crossCheckPrimary(job, metric, chain, primaryId, sources, registry) {
  if (!metric || !metric.crossCheck || metric.crossCheck.enabled === false) return null;
  const candidates = chain.filter(id => id !== primaryId);
  let lastUnavailable = null;
  for (const sid of candidates) {
    const src = sources.find(x => x.id === sid) || registry.find(x => x.id === sid);
    if (!src) continue;
    let h = { available: true };
    try { h = health.getHealth(src); } catch (e) { h = { available: false, reason: String((e && e.message) || e) }; }
    if (h.available === false) { lastUnavailable = { status: "unavailable", sourceId: sid, reason: h.reason || "不可用" }; continue; }
    const rr = await runSource(job, sid, sources, registry, { suffix: "xcheck" });
    if (!rr.ok) {
      if (/40203|积分|权限不足|permission/i.test(String(rr.error || ""))) {
        try { health.markUnavailable(sid, String(rr.error || "").slice(0, 200)); } catch (e) {}
      }
      lastUnavailable = { status: "unavailable", sourceId: sid, reason: String(rr.error || "").slice(0, 300) };
      continue;
    }
    const cmp = dataCrossCheck.compare(metric, job.records || [], rr.result.records);
    return Object.assign({ secondarySource: sid }, cmp);
  }
  return lastUnavailable || { status: "unavailable", reason: "没有可用的交叉校验来源" };
}

async function runOne(job) {
  const { sources, registry } = loadSources();
  // 免费优先的 fallback 链：broker 入队时写入 sourceChain；手工任务退化为单源。
  const chain = job.url ? ["__url__"]
    : (Array.isArray(job.sourceChain) && job.sourceChain.length ? job.sourceChain : [job.sourceId])
      .filter(Boolean).slice(0, 20);
  if (!chain.length) return { status: "failed", error: "no source in chain", records: [] };
  const attempts = [];
  for (const sourceId of chain) {
    if (sourceId !== "__url__") {
      const src = sources.find(x => x.id === sourceId) || registry.find(x => x.id === sourceId);
      if (!src) { attempts.push({ sourceId, status: "missing", error: "未知来源" }); continue; }
      let h = { available: true };
      try { h = health.getHealth(src); } catch (e) { h = { available: false, reason: String((e && e.message) || e) }; }
      if (h.available === false) {
        attempts.push({ sourceId, status: "unavailable", error: h.reason || "不可用", tier: h.tier || "" });
        continue;
      }
      const pc = sourcePolicy.checkSource(src, { allowPaid: job.allowPaid === true });
      if (!pc.ok) {
        attempts.push({ sourceId, status: pc.code, error: pc.reason, tier: pc.tier || "" });
        continue;
      }
    }
    const r = await runSource(job, sourceId, sources, registry);
    if (r.ok) {
      attempts.push({ sourceId, status: "ok" });
      try {
        const psrc = sources.find(x => x.id === sourceId) || registry.find(x => x.id === sourceId) || {};
        const pcost = Number((((psrc.access || {}).cost || {}).perCall) || (psrc.access || {}).costPerCall || 0) || 0;
        await api("POST", "/api/data/source-usage/record", { case: job.case, sourceId, cost: pcost,
          jobId: job.id, status: "ok", by: "data-worker" });
      } catch (e) {}
      const metric = loadMetrics().find(m => m.id === job.metric) || null;
      job.records = r.result.records;
      let crossCheck = null;
      try { crossCheck = await crossCheckPrimary(job, metric, chain, sourceId, sources, registry); } catch (e) {
        crossCheck = { status: "unavailable", reason: String((e && e.message) || e).slice(0, 300) };
      }
      return { status: "extracted", sourceId, sourceChain: chain, sourceAttempts: attempts,
        out: r.result.out, raw: r.result.raw, records: r.result.records, crossCheck,
        snapshot: r.result.snapshot || null };
    }
    attempts.push({ sourceId, status: r.empty ? "empty" : "failed", error: String(r.error || "").slice(0, 500) });
    // Tushare 积分/权限错误：立刻写入健康缓存，后续任务不再反复撞墙。
    if (/40203|积分|权限不足|permission/i.test(String(r.error || ""))) {
      try { health.markUnavailable(sourceId, String(r.error || "").slice(0, 200)); } catch (e) {}
    }
  }
  const err = attempts.map(a => (a.sourceId === "__url__" ? "URL" : a.sourceId) + "：" + (a.error || a.status)).join("；").slice(0, 1000) || "所有来源均不可用";
  const max = Number(job.maxAttempts || 3);
  if ((job.attempts || 0) < max) {
    return { status: "queued", lastError: err, sourceChain: chain, sourceAttempts: attempts, records: [] };
  }
  return { status: "failed", error: err, lastError: err, sourceChain: chain, sourceAttempts: attempts, records: [] };
}
async function notifyUpload(job, error, res) {
  // 原始缺口已存在时不要新建重复缺口：job 失败会回写 item.auto=failed，面板在原缺口上提示即可。
  if (job.needId) return job.needId;
  try {
    const tried = ((res && res.sourceAttempts) || job.sourceAttempts || [])
      .map(a => "  - " + a.sourceId + "：" + (a.error || a.status)).join(String.fromCharCode(10));
    const title = "采集失败，请手动上传数据：" + String(job.metric || job.sourceId || "").slice(0, 80);
    const detail = "采集与重试均失败。" + String.fromCharCode(10) + "job: " + job.id + String.fromCharCode(10) + "source: " + (job.sourceId || job.url || "") + String.fromCharCode(10) + "range: " + (job.range || "") + String.fromCharCode(10) + "尝试过的来源：" + String.fromCharCode(10) + (tried || "  - 无") + String.fromCharCode(10) + "错误：" + String(error || "").slice(0, 500) + String.fromCharCode(10) + "可上传 CSV/Excel 原始文件，或配置免费数据源后重试。";
    const r = await api("POST", "/api/need", { case: CASE, agent: job.agent || "industry",
      kind: "data", title, detail, blocking: true, autoCollect: false, planId: "", stepId: "" });
    const need = r.body && r.body.need;
    if (need && need.id) {
      await api("POST", "/api/data/job/update", { case: CASE, id: job.id, failureNeedId: need.id, by: "data-worker" });
      return need.id;
    }
  } catch (e) {}
  return "";
}
async function tick() {
  const q = await api("GET", "/api/data/jobs?case=" + encodeURIComponent(CASE) + "&status=queued");
  const job = (q.body.jobs || [])[0];
  if (!job) return false;
  const claim = await api("POST", "/api/data/job/claim", { case: CASE, id: job.id, owner: "data-worker" });
  if (claim.status !== 200) return false;
  const cur = claim.body.job;
  let res;
  try { res = await runOne(cur); } catch (e) { res = { status: "failed", error: String(e && e.message || e), records: [] }; }
  await api("POST", "/api/data/job/update", Object.assign({ case: CASE, id: cur.id, by: "data-worker" }, res));
  if (res && res.status === "failed" && !cur.failureNeedId) {
    await notifyUpload(cur, res.error || res.lastError || "", res);
  }
  return true;
}
(async () => {
  if (flag("once")) {
    // 一次 worker 把当前队列尽量排空，避免批量 auto-collect 只处理第一条、其余永远 queued。
    let n = 0;
    while (await tick()) { n += 1; if (n >= 20) break; }
    console.log(JSON.stringify({ ok: true, processed: n }));
    process.exit(0);
  }
  while (true) {
    const did = await tick();
    if (!did) await new Promise(r => setTimeout(r, 3000));
  }
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
