#!/usr/bin/env node
"use strict";
/**
 * data-gateway — 数据采集统一执行层（v1）。
 *   policy/quota 由 broker 路由负责；本模块负责幂等、执行、契约校验、快照。
 *   所有 DataJob / 探针都从这里取数，不再各自 spawn collect。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const dataQuality = require("./data-quality");
const ROOT = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(ROOT, "runtime/data/gateway-idempotency.json");
const SNAP_DIR = path.join(ROOT, "runtime/data/gateway");
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } }
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + String.fromCharCode(10)); }
function hash(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function loadSources() {
  const sources = [];
  try {
    const dir = path.join(ROOT, "config/sources");
    fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
      try { const j = readJson(path.join(dir, f), null); if (j && j.id) sources.push(j); } catch (e) {}
    });
  } catch (e) {}
  let registry = [];
  try { registry = readJson(path.join(ROOT, "config/data/sources.json"), { sources: [] }).sources || []; } catch (e) {}
  return { sources, registry };
}
function parseRecords(payload, reg) {
  let arr = Array.isArray(payload.records) ? payload.records :
    (Array.isArray(payload.data) ? payload.data :
    (payload && payload.result && Array.isArray(payload.result.data) ? payload.result.data :
    (payload && Array.isArray(payload.result) ? payload.result : null)));
  if (!arr) return [];
  if (!reg || !reg.connector) return arr;
  const pf = reg.periodField || "REPORT_DATE", vf = reg.valueField || "VALUE";
  return arr.map(x => {
    let p = x[pf] || x.TIME || x.DATE || x.period || "";
    p = String(p).replace(/年(\d{1,2})月/, "-$1").replace(/[^0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (/^\d{4}-\d{2}/.test(p)) p = p.slice(0, 7);
    const v = Number(x[vf]);
    return { period: p, value: v, unit: reg.unit || x.unit || "" };
  }).filter(x => /^\d{4}-\d{2}/.test(x.period) && Number.isFinite(x.value));
}
function run(cmd, args, opts) {
  return new Promise(resolve => {
    const o = opts || {};
    let cp;
    try { cp = spawn(cmd, args, { cwd: ROOT, env: o.env || process.env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolve({ status: -1, stdout: "", stderr: String(e && e.message || e) }); }
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => { try { cp.kill("SIGTERM"); } catch (e) {} }, o.timeout || 180000);
    cp.stdout.on("data", d => { stdout += d; if (stdout.length > (o.maxBuffer || 64 * 1024 * 1024)) { try { cp.kill("SIGKILL"); } catch (e) {} } });
    cp.stderr.on("data", d => { stderr += d; if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024); });
    cp.on("error", e => { if (done) return; done = true; clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(e && e.message || e) }); });
    cp.on("close", code => { if (done) return; done = true; clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}
async function execute(sourceId, query, job) {
  const { sources, registry } = loadSources();
  if (query && query.mode === "raw" && query.url) {
    const out = path.join(ROOT, "runtime/data/gateway/raw-" + Date.now().toString(36) + ".md");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await run(process.execPath, [path.join(ROOT, "scripts/collect.js"), "get", String(query.url), "--out", out], { timeout: 60000 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
    if (r.status !== 0 || !j || j.ok === false) return { ok: false, error: String((j && j.error) || r.stderr || ("collect exit " + r.status)).slice(0, 800), out };
    return { ok: true, out: j.out || out, raw: j.raw || "", records: [], rawMode: true, sourceId: "__url__" };
  }
  if (query && query.mode === "web_agent") {
    const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const out = path.join(ROOT, "runtime/data/gateway/web-agent-" + Date.now().toString(36) + ".json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = [path.join(ROOT, "scripts/web_agent.py"), "--url", String(query.url || ""),
      "--goal", String(query.goal || ""), "--max-steps", String(query.maxSteps || 10),
      "--max-pages", String(query.maxPages || 5), "--out", out];
    const r = await run(py, args, { timeout: 180000,
      env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }) });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) { try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop()); } catch (e2) {} }
    if (!j || j.ok === false) return { ok: false, error: String((j && j.error) || r.stderr || ("web_agent exit " + r.status)).slice(0, 800), out, webAgent: j };
    return { ok: true, out, raw: "", records: [], webAgent: j, sourceId: "__url__" };
  }
  const src = sources.find(s => s.id === sourceId) || sources.find(s => s.id === ((registry.find(r => r.id === sourceId) || {}).configSource));
  const reg = registry.find(r => r.id === sourceId || r.configSource === (src && src.id)) || {};
  const out = path.join(ROOT, "runtime/data/raw/gw-" + Date.now().toString(36) + "-" + hash(sourceId + JSON.stringify(query || {})).slice(0, 8) + ".json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let args = [];
  if (query && query.url) args = ["get", query.url, "--out", out];
  else if (reg.recipeId) {
    const cr = await run(process.execPath, [path.join(ROOT, "scripts/connector.js"), "--run", "--id", reg.recipeId, "--out", out], { timeout: 120000 });
    let cj = null; try { cj = JSON.parse(String(cr.stdout || "").trim()); } catch (e) {}
    if (cr.status !== 0 || !cj || !cj.ok) return { ok: false, error: String((cj && cj.error) || cr.stderr || ("connector exit " + cr.status)).slice(0, 800), out };
    return { ok: true, out, raw: "", records: cj.records || [], sourceId: src ? src.id : sourceId };
  } else if (src) {
    args = ["source", src.id, "--out", out];
    if (src.vars && src.vars.range !== undefined && query && query.range) args.push("--var", "range=" + query.range);
  } else return { ok: false, error: "source not found: " + sourceId, out };
  args.push("--no-need");
  const r = await run(process.execPath, [path.join(ROOT, "scripts/collect.js")].concat(args), { timeout: 180000 });
  let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop()); } catch (e) {}
  if (r.status !== 0 || (j && j.ok === false)) return { ok: false, error: String((j && j.error) || r.stderr || ("exit " + r.status)).slice(0, 800), out };
  const payload = readJson(j && j.out ? path.resolve(ROOT, j.out) : out, null);
  const records = payload ? parseRecords(payload, reg) : [];
  return { ok: records.length > 0, out: (j && j.out) || out, raw: (j && j.raw) || "",
    records, sourceId: src ? src.id : sourceId,
    error: records.length ? "" : "抓取成功但未得到结构化 records，需要模型/审计解析" };
}
function validate(metric, records) {
  if (!metric) return { ok: true, issues: [] };
  try {
    const q = dataQuality.check(metric, records, {});
    return { ok: !!q.ok, issues: (q.issues || []).slice(0, 8), quality: q };
  } catch (e) { return { ok: false, issues: [String(e && e.message || e)] }; }
}
async function request(opts) {
  const o = opts || {};
  const sourceId = String(o.sourceId || "").slice(0, 80);
  const metricId = String(o.metricId || "").slice(0, 80);
  const key = o.idempotencyKey || hash([o.case || "", metricId, sourceId, JSON.stringify(o.query || {})].join("|"));
  const cache = readJson(CACHE_FILE, {});
  const now = Date.now();
  const freq = String((o.metric && o.metric.frequency) || "").toLowerCase();
  const ttl = o.forceRefresh === true ? 0 : (freq === "daily" ? 60 * 60 * 1000 : (freq === "monthly" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
  if (!o.forceRefresh && ttl > 0 && cache[key] && cache[key].at && now - new Date(cache[key].at).getTime() < ttl) {
    return Object.assign({}, cache[key].result, { cached: true, idempotencyKey: key });
  }
  const ex = await execute(sourceId, o.query || {}, o);
  if (!ex.ok) return { ok: false, sourceId, error: ex.error, out: ex.out, records: [], webAgent: ex.webAgent || null, idempotencyKey: key };
  const metric = o.metric || null;
  if (o.query && (o.query.mode === "raw" || o.query.mode === "web_agent")) {
    const snapshot = { id: "GS" + Date.now().toString(36), at: new Date().toISOString(), sourceId: "__url__",
      metricId: "", out: ex.out, raw: ex.raw || "", records: 0,
      sha256: (() => { try { return hash(fs.readFileSync(path.resolve(ROOT, ex.out))); } catch (e) { return ""; } })() };
    const result = { ok: true, sourceId: "__url__", records: [], out: ex.out, raw: ex.raw || "",
      webAgent: ex.webAgent || null, snapshot, idempotencyKey: key, cached: false };
    cache[key] = { at: new Date().toISOString(), result };
    try { writeJson(CACHE_FILE, cache); writeJson(path.join(SNAP_DIR, snapshot.id + ".json"), snapshot); } catch (e) {}
    return result;
  }
  const v = validate(metric, ex.records);
  if (!v.ok) return { ok: false, sourceId, error: "contract validation failed: " + (v.issues.join("; ") || "unknown"), out: ex.out,
    records: ex.records, quality: v.quality, idempotencyKey: key };
  const snapshot = { id: "GS" + Date.now().toString(36), at: new Date().toISOString(), sourceId,
    metricId, out: ex.out, raw: ex.raw, records: ex.records.length,
    sha256: (() => { try { return hash(fs.readFileSync(path.resolve(ROOT, ex.out))); } catch (e) { return ""; } })() };
  const result = { ok: true, sourceId, records: ex.records, out: ex.out, raw: ex.raw,
    snapshot, quality: v.quality || null, idempotencyKey: key, cached: false };
  cache[key] = { at: new Date().toISOString(), result };
  try {
    const keys = Object.keys(cache);
    if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete cache[k]);
    writeJson(CACHE_FILE, cache);
    writeJson(path.join(SNAP_DIR, snapshot.id + ".json"), snapshot);
  } catch (e) {}
  return result;
}
module.exports = { request, execute, parseRecords, validate, hash };
