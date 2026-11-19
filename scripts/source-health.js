#!/usr/bin/env node
"use strict";
/**
 * source-health — 数据源能力/可用性检测（免费优先，Tushare 等积分源只作为可选 provider）。
 *
 * 设计目标（开源可用）：
 * - 每个 source 在 config/data/sources.json 里声明 access：free / free-key / token / credit / account；
 * - free 直接可用；free-key/token/credit 必须有凭据，credit 还要探测积分/权限；
 * - 探测结果缓存到 runtime/data/source-health.json，auto-enqueue 与 data-worker 都按此跳过不可用源；
 * - 不可用不是“报错”，而是明确告诉用户：缺什么、去哪申请、还可以上传 CSV。
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.resolve(__dirname, "..");
const HEALTH_FILE = path.join(ROOT, "runtime/data/source-health.json");
const REGISTRY_FILE = path.join(ROOT, "config/data/sources.json");
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } }
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + String.fromCharCode(10)); }
function nowIso() { return new Date().toISOString(); }

function loadRegistry() {
  const j = readJson(REGISTRY_FILE, { sources: [] });
  return Array.isArray(j.sources) ? j.sources : [];
}
function loadHealth() {
  const j = readJson(HEALTH_FILE, null);
  return j && typeof j === "object" && j.sources ? j : { version: 1, checkedAt: "", sources: {} };
}
function saveHealth(h) {
  h.version = 1;
  h.checkedAt = h.checkedAt || nowIso();
  writeJson(HEALTH_FILE, h);
  return h;
}

function tierOf(src) {
  const a = (src && src.access) || {};
  if (a.tier) return String(a.tier);
  if (a.auth === "token") return "token";
  if (a.auth === "account") return "account";
  if (src && src.auth === "token") return "token";
  if (src && src.auth === "account") return "account";
  return "free";
}
function tierLabel(tier) {
  return ({ free: "免费", "free-key": "免费Key", token: "需Token", credit: "需积分", account: "需账号" })[tier] || tier || "未知";
}
function secretPathOf(src) {
  const a = (src && src.access) || {};
  if (!a.secret) return "";
  return path.resolve(ROOT, a.secret);
}
function hasSecret(src, opts) {
  if (opts && opts.hasSecret !== undefined) return !!opts.hasSecret;
  const a = (src && src.access) || {};
  const p = secretPathOf(src);
  if (p && fs.existsSync(p)) {
    let raw = "";
    try { raw = fs.readFileSync(p, "utf8").trim(); } catch (e) {}
    if (raw) {
      const j = readJson(p, null);
      if (j && (j.token || j.api_key || j.key || j.secret)) return true;
      if (j === null) return true; // 非 JSON 的 env 文件也视为已配置
    }
  }
  for (const k of (a.env || [])) if (process.env[k]) return true;
  // 兼容旧路径：Tushare 历史上只放 runtime/secrets/tushare.json
  if (/^tushare/.test(String(src && src.id || ""))) {
    const legacy = path.join(ROOT, "runtime/secrets/tushare.json");
    const j = readJson(legacy, null);
    if (j && j.token) return true;
  }
  return false;
}
function missingReason(src) {
  const a = (src && src.access) || {};
  const parts = [];
  if (a.secret) parts.push("配置文件 " + a.secret);
  if (a.env && a.env.length) parts.push("环境变量 " + a.env.join(" / "));
  const where = parts.length ? parts.join(" 或 ") : "对应凭据";
  const extra = a.homepage ? "；申请/说明见 " + a.homepage : "";
  return "未配置凭据：" + where + extra;
}

/** 纯静态检查：不联网，只看 access 声明与凭据是否存在。 */
function staticCheck(src, opts) {
  const a = (src && src.access) || {};
  const tier = tierOf(src);
  if (tier === "free") return { available: true, tier, reason: "", note: "" };
  if (tier === "account") {
    return { available: false, tier, reason: a.note || "需要账号登录，默认不启用；可上传 CSV 或配置来源" };
  }
  if (!hasSecret(src, opts)) return { available: false, tier, reason: missingReason(src) };
  const note = tier === "credit" ? "可选积分源（需 ≥" + (a.minPoints || 2000) + " 积分）；无积分时使用免费源或上传 CSV" : "";
  return { available: true, tier, reason: "", note };
}

function fresh(cache, ttl) {
  if (!cache || !cache.checkedAt) return false;
  const t = Date.parse(cache.checkedAt);
  return Number.isFinite(t) && (Date.now() - t) < (ttl || DEFAULT_TTL_MS);
}

/** 静态 + 缓存探测结果。缓存里明确不可用（如积分不足）时优先采用。 */
function getHealth(src, opts) {
  const base = staticCheck(src, opts);
  if (!base.available) return base;
  const h = loadHealth();
  const c = h.sources[src.id];
  const ttl = ((src.access || {}).healthTtlMs) || DEFAULT_TTL_MS;
  if (c && fresh(c, ttl)) {
    return Object.assign({}, base, c, { cached: true });
  }
  return base;
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "user-agent": "AlphaDeskSourceDoctor/1.0" },
      timeout: timeoutMs || 10000
    }, res => {
      let s = "";
      res.on("data", d => s += d);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: res.statusCode, body: {}, text: s }); } });
    });
    req.on("timeout", () => { try { req.destroy(new Error("timeout")); } catch (e) {} });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function tushareToken(src) {
  const p = secretPathOf(src);
  const j = p ? readJson(p, null) : null;
  if (j && j.token) return j.token;
  const legacy = readJson(path.join(ROOT, "runtime/secrets/tushare.json"), null);
  if (legacy && legacy.token) return legacy.token;
  return process.env.TUSHARE_TOKEN || "";
}

function fredKey(src) {
  const p = secretPathOf(src);
  const j = p ? readJson(p, null) : null;
  if (j && (j.api_key || j.apiKey || j.key)) return String(j.api_key || j.apiKey || j.key);
  return process.env.FRED_API_KEY || "";
}

async function probeSource(src) {
  const a = (src && src.access) || {};
  const p = a.probe;
  if (!p) return { available: true, reason: "", probe: "none" };
  const started = Date.now();
  try {
    if (p.type === "tushare") {
      const token = tushareToken(src);
      if (!token) return { available: false, reason: missingReason(src), probe: "tushare" };
      const r = await postJson("https://api.tushare.pro",
        { api_name: p.api || "cn_m", token, params: p.params || {}, fields: p.fields || "" }, p.timeoutMs || 12000);
      const j = r.body || {};
      if (j.code === 0) return { available: true, reason: "", probe: "tushare", latencyMs: Date.now() - started };
      if (j.code === 40203) return { available: false, reason: "Tushare 积分/权限不足（需 ≥" + (a.minPoints || 2000) + " 积分）", probe: "tushare", latencyMs: Date.now() - started };
      if (/token/i.test(String(j.msg || ""))) return { available: false, reason: "Tushare token 无效：" + String(j.msg || "").slice(0, 120), probe: "tushare" };
      return { available: false, reason: "Tushare 探测失败：" + String(j.msg || ("code " + j.code)).slice(0, 160), probe: "tushare" };
    }
    if (p.type === "fred") {
      const key = fredKey(src);
      if (!key) return { available: false, reason: missingReason(src), probe: "fred" };
      const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" +
        encodeURIComponent(p.series || "DGS10") + "&api_key=" + encodeURIComponent(key) + "&file_type=json&limit=1";
      const res = await fetch(url, { headers: { "user-agent": "AlphaDeskSourceDoctor/1.0" }, signal: AbortSignal.timeout(p.timeoutMs || 10000) });
      let j = null; try { j = await res.json(); } catch (e) {}
      if (res.ok && j && Array.isArray(j.observations)) return { available: true, reason: "", probe: "fred", latencyMs: Date.now() - started };
      const msg = (j && (j.error_message || j.message)) || ("HTTP " + res.status);
      return { available: false, reason: "FRED 探测失败：" + String(msg).slice(0, 160), probe: "fred", latencyMs: Date.now() - started };
    }
    const method = String(p.method || "GET").toUpperCase();
    const init = { method, headers: { "user-agent": p.userAgent || "Mozilla/5.0 AlphaDeskSourceDoctor" }, signal: AbortSignal.timeout(p.timeoutMs || 8000) };
    if (method !== "GET") init.body = p.body || "";
    const res = await fetch(p.url, init);
    let text = "";
    try { text = await res.text(); } catch (e) {}
    const latencyMs = Date.now() - started;
    if (p.expectStatus && res.status !== p.expectStatus) return { available: false, reason: "HTTP " + res.status, probe: "http", latencyMs };
    if (!p.expectStatus && res.status >= 400) return { available: false, reason: "HTTP " + res.status, probe: "http", latencyMs };
    if (p.contains && text.indexOf(p.contains) < 0) return { available: false, reason: "响应缺少标记：" + p.contains, probe: "http", latencyMs };
    return { available: true, reason: "", probe: "http", latencyMs };
  } catch (e) {
    return { available: false, reason: "探测失败：" + String((e && e.message) || e).slice(0, 160), probe: p.type || "http" };
  }
}

async function refresh(sources, opts) {
  const list = Array.isArray(sources) ? sources : loadRegistry();
  const ids = opts && Array.isArray(opts.ids) && opts.ids.length ? new Set(opts.ids) : null;
  const targets = list.filter(s => !ids || ids.has(s.id));
  const h = loadHealth();
  h.sources = h.sources || {};
  const results = [];
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const src = targets[i++];
      const base = staticCheck(src);
      let r;
      if (!base.available) r = Object.assign({}, base, { probe: "static" });
      else {
        const p = await probeSource(src);
        r = Object.assign({}, base, p, { available: p.available !== false });
      }
      const ts = nowIso();
      const prev = h.sources[src.id] || {};
      r.checkedAt = ts;
      r.lastOkAt = r.available ? ts : (prev.lastOkAt || "");
      r.lastErrorAt = r.available ? (prev.lastErrorAt || "") : ts;
      r.consecutiveFailures = r.available ? 0 : ((prev.consecutiveFailures || 0) + 1);
      h.sources[src.id] = r;
      results.push(Object.assign({ id: src.id, name: src.name || src.id }, r));
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, targets.length)) }, worker));
  h.checkedAt = nowIso();
  saveHealth(h);
  return results;
}

function markUnavailable(id, reason, extra) {
  const h = loadHealth();
  h.sources = h.sources || {};
  const prev = h.sources[id] || {};
  const ts = nowIso();
  h.sources[id] = Object.assign({}, prev, { available: false, reason: String(reason || "").slice(0, 300),
    checkedAt: ts, lastErrorAt: ts, consecutiveFailures: (prev.consecutiveFailures || 0) + 1 }, extra || {});
  h.checkedAt = nowIso();
  saveHealth(h);
}
function markAvailable(id, extra) {
  const h = loadHealth();
  h.sources = h.sources || {};
  const ts = nowIso();
  h.sources[id] = Object.assign({}, h.sources[id] || {}, { available: true, reason: "",
    checkedAt: ts, lastOkAt: ts, consecutiveFailures: 0 }, extra || {});
  h.checkedAt = nowIso();
  saveHealth(h);
}
function healthAll(sources) {
  const list = Array.isArray(sources) ? sources : loadRegistry();
  const h = loadHealth();
  return {
    checkedAt: h.checkedAt || "",
    sources: list.map(src => {
      const r = getHealth(src);
      const a = (src.access || {});
      return {
        id: src.id, name: src.name || src.id, configSource: src.configSource || "",
        available: r.available !== false, tier: r.tier || tierOf(src), tierLabel: tierLabel(r.tier || tierOf(src)),
        reason: r.reason || "", note: r.note || "", probe: r.probe || "", latencyMs: r.latencyMs || 0,
        cached: !!r.cached, checkedAt: r.checkedAt || "",
        lastOkAt: r.lastOkAt || "", lastErrorAt: r.lastErrorAt || "", consecutiveFailures: r.consecutiveFailures || 0,
        access: { tier: a.tier || tierOf(src), minPoints: a.minPoints || 0, secret: a.secret || "", env: a.env || [], homepage: a.homepage || "" },
        structured: src.structured !== false,
        status: src.status || "active",
        coverage: src.coverage || null,
        cost: (a.cost && typeof a.cost === "object") ? a.cost : { perCall: Number(a.costPerCall || 0) || 0 }
      };
    })
  };
}

module.exports = {
  ROOT, HEALTH_FILE, REGISTRY_FILE, DEFAULT_TTL_MS,
  loadRegistry, loadHealth, saveHealth, tierOf, tierLabel,
  staticCheck, getHealth, probeSource, refresh, markUnavailable, markAvailable, healthAll
};
