#!/usr/bin/env node
"use strict";
/**
 * fred-series — FRED（St. Louis Fed）免费 API connector
 * 零依赖（Node 22 内置 fetch），stdout 输出一行 JSON。
 *
 *   node scripts/fred-series.js --series DGS10 --range 2026-10-01..2026-11-16
 *
 * API key 来源（按顺序）：process.env.FRED_API_KEY → runtime/secrets/fred.json 的 api_key
 * 免费申请：https://fredaccount.stlouisfed.org/apikeys
 * 没有 key：{"ok":false,"error":"缺少 FRED API key ..."}，exit 1
 *
 * 成功：{"ok":true,"source":"fred:DGS10","range":"...","records":[{"period":"2026-11-14","value":4.1,"unit":"%"}]}，exit 0
 */
const fs = require("fs");
const path = require("path");
const BASE = "https://api.stlouisfed.org/fred/series/observations";
const ROOT = path.resolve(__dirname, "..");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;

function fail(error) {
  const line = JSON.stringify({ ok: false, error: String(error) });
  process.stdout.write(line + "\n");
  process.stderr.write(line + "\n");
  process.exit(1);
}
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith("--")) out[k] = true;
    else { out[k] = nxt; i++; }
  }
  return out;
}
function str(v, d) { return v === undefined || v === true ? d : String(v); }
function pad2(x) { return String(x).padStart(2, "0"); }

function isoDateOf(d) { return d.toISOString().slice(0, 10); }
/** "2026-11" -> "2026-11-30"（该月最后一天；固定拼 -31 会产生不存在的日期） */
function lastDayOfMonth(ym) {
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  return isoDateOf(new Date(Date.UTC(y, mo, 0)));
}
/** 2025-01..2026-10 / 2026-10-01..2026-11-16 -> {mode,start,end}，start/end 均为 YYYY-MM-DD */
function parseRange(raw) {
  const m = String(raw || "").trim().match(/^(\d{4}-\d{2}(?:-\d{2})?)\.\.(\d{4}-\d{2}(?:-\d{2})?)$/);
  if (!m) return null;
  const s = m[1], e = m[2];
  return {
    mode: s.length === 7 && e.length === 7 ? "month" : "day",
    start: s.length === 7 ? s + "-01" : s,
    end: e.length === 7 ? lastDayOfMonth(e) : e,
  };
}
function inRange(period, range) {
  if (!range) return true;
  if (range.mode === "month") {
    const p = period.slice(0, 7);
    return p >= range.start.slice(0, 7) && p <= range.end.slice(0, 7);
  }
  const p = period.length === 7 ? period + "-01" : period;
  return p >= range.start && p <= range.end;
}
function normDate(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}
function num(v) {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s || s === "." || s === "-" || s === "--") return NaN; // FRED 用 "." 表示缺值
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** env 优先，其次 runtime/secrets/fred.json（api_key / apiKey / key） */
function readKey() {
  const env = String(process.env.FRED_API_KEY || "").trim();
  if (env) return { key: env, from: "env" };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/secrets/fred.json"), "utf8"));
    const k = String(j.api_key || j.apiKey || j.key || "").trim();
    if (k) return { key: k, from: "runtime/secrets/fred.json" };
  } catch (e) {}
  return null;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const series = str(a.series, "");
  if (!series) fail("缺少 --series（例如 DGS10）");
  const rangeStr = str(a.range, "");
  const range = rangeStr ? parseRange(rangeStr) : null;
  if (rangeStr && !range) fail("--range 格式不正确：" + rangeStr + "（应为 2026-10-01..2026-11-16）");
  const dateMode = str(a["date-mode"], "daily").toLowerCase() === "monthly" ? "monthly" : "daily";
  const unit = str(a.unit, "%");

  const found = readKey();
  if (!found) {
    fail("缺少 FRED API key：请设置环境变量 FRED_API_KEY，或写入 runtime/secrets/fred.json 的 api_key"
      + "（免费申请 https://fredaccount.stlouisfed.org/apikeys）");
  }

  const qs = new URLSearchParams();
  qs.set("series_id", series);
  qs.set("api_key", found.key);
  qs.set("file_type", "json");
  if (range) {
    qs.set("observation_start", range.start);
    qs.set("observation_end", range.end);
  }

  const res = await fetch(BASE + "?" + qs.toString(), {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (!res.ok || !body || body.error_message) {
    const msg = (body && body.error_message) || ("HTTP " + res.status + ": " + text.slice(0, 200));
    throw new Error("FRED 接口错误：" + msg);
  }
  const obs = Array.isArray(body.observations) ? body.observations : null;
  if (!obs) throw new Error("FRED 响应里没有 observations：" + text.slice(0, 200));

  const records = obs.map(o => {
    const date = normDate(o.date);
    const value = num(o.value);
    if (!date || !Number.isFinite(value)) return null;
    const period = dateMode === "monthly" ? date.slice(0, 7) : date;
    return { period: period, value: value, unit: unit };
  }).filter(Boolean)
    .filter(r => inRange(r.period, range))
    .sort((x, y) => (x.period < y.period ? -1 : x.period > y.period ? 1 : 0));

  process.stdout.write(JSON.stringify({
    ok: true,
    source: "fred:" + series,
    range: rangeStr,
    records: records,
  }) + "\n");
  process.exit(0);
}
main().catch(e => fail((e && e.message) || e));
