#!/usr/bin/env node
"use strict";
/**
 * eastmoney-series — 东方财富数据中心通用序列 connector
 * 零依赖（Node 22 内置 fetch），stdout 输出一行 JSON。
 *
 *   node scripts/eastmoney-series.js --report RPT_ECONOMY_CURRENCY_SUPPLY \
 *     --period-field REPORT_DATE --value-field CURRENCY_SAME --unit % \
 *     --date-mode monthly --range 2025-01..2026-10
 *
 * 成功：{"ok":true,"source":"eastmoney:<report>","range":"...","records":[{"period","value","unit"}]}，exit 0
 * 失败：stdout 与 stderr 各一行 {"ok":false,"error":"..."}，exit 1（data-worker 据此走 fallback）
 */
const BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";
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
function int(v, d, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return d;
  return Math.min(hi, Math.max(lo, n));
}
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
function beforeStart(period, range) {
  if (!range) return false;
  if (range.mode === "month") return period.slice(0, 7) < range.start.slice(0, 7);
  return (period.length === 7 ? period + "-01" : period) < range.start;
}

/** 支持 "2026-10-01 00:00:00" / "2026年10月份" / "202610"(01) / "2026/10/01" / 13 位毫秒时间戳 */
function normPeriod(raw, dateMode) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})年(\d{1,2})月/);
  if (m) { const y = m[1], mo = pad2(m[2]); return dateMode === "daily" ? y + "-" + mo + "-01" : y + "-" + mo; }
  m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/);
  if (m) {
    const y = m[1], mo = pad2(m[2]);
    if (dateMode === "daily") return y + "-" + mo + "-" + pad2(m[3] || "01");
    return y + "-" + mo;
  }
  m = s.match(/^(\d{6})(\d{2})?$/);
  if (m) {
    const y = m[1].slice(0, 4), mo = m[1].slice(4, 6);
    if (dateMode === "daily") return y + "-" + mo + "-" + (m[2] || "01");
    return y + "-" + mo;
  }
  if (/^\d{13}$/.test(s)) {
    const d = new Date(Number(s));
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear(), mo = pad2(d.getUTCMonth() + 1);
      return dateMode === "daily" ? y + "-" + mo + "-" + pad2(d.getUTCDate()) : y + "-" + mo;
    }
  }
  return "";
}
function num(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim().replace(/,/g, "");
  if (!s || s === "-" || s === "--" || s === ".") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
/** --filter 'FIELD=VALUE' 或 JSON 对象；按原始行字段等值过滤 */
function parseFilter(raw) {
  const s = str(raw, "").trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    let o;
    try { o = JSON.parse(s); } catch (e) { fail("--filter 不是合法 JSON：" + s); }
    if (!o || typeof o !== "object" || Array.isArray(o)) fail("--filter JSON 必须是对象");
    return o;
  }
  const i = s.indexOf("=");
  if (i <= 0) fail("--filter 需要 FIELD=VALUE 或 JSON 对象");
  const o = {}; o[s.slice(0, i)] = s.slice(i + 1);
  return o;
}
function matchFilter(row, filter) {
  if (!filter) return true;
  return Object.keys(filter).every(k => String(row[k]) === String(filter[k]));
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 200));
  try { return JSON.parse(text); } catch (e) { throw new Error("响应不是 JSON：" + text.slice(0, 200)); }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const report = str(a.report, "");
  if (!report) fail("缺少 --report（例如 RPT_ECONOMY_CURRENCY_SUPPLY）");
  const valueField = str(a["value-field"], "");
  if (!valueField) fail("缺少 --value-field（例如 CURRENCY_SAME）");
  const periodField = str(a["period-field"], "REPORT_DATE");
  const unit = str(a.unit, "");
  const dateMode = str(a["date-mode"], "monthly").toLowerCase() === "daily" ? "daily" : "monthly";
  const rangeStr = str(a.range, "");
  const range = rangeStr ? parseRange(rangeStr) : null;
  if (rangeStr && !range) fail("--range 格式不正确：" + rangeStr + "（应为 2025-01..2026-10 或 2026-10-01..2026-11-16）");
  const sortColumn = str(a["sort-column"], periodField);
  const pageSize = int(a["page-size"], 100, 1, 1000);
  const maxPages = int(a["max-pages"], 5, 1, 50);
  const filter = parseFilter(a.filter);
  let extra = {};
  if (a.extra !== undefined && a.extra !== true) {
    try { extra = JSON.parse(String(a.extra)); } catch (e) { fail("--extra 必须是 JSON 对象"); }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) fail("--extra 必须是 JSON 对象");
  }

  const rows = [];
  let totalPages = 1;
  for (let page = 1; page <= maxPages; page++) {
    const qs = new URLSearchParams();
    qs.set("reportName", report);
    qs.set("columns", "ALL");
    qs.set("pageSize", String(pageSize));
    qs.set("pageNumber", String(page));
    qs.set("sortColumns", sortColumn);
    qs.set("sortTypes", "-1");
    for (const k of Object.keys(extra)) {
      if (extra[k] !== undefined && extra[k] !== null) qs.set(k, String(extra[k]));
    }
    const body = await getJson(BASE + "?" + qs.toString());
    if (!body || body.success === false || !body.result) {
      throw new Error((body && body.message) || ("报表无数据或报表名不存在：" + report));
    }
    const data = Array.isArray(body.result.data) ? body.result.data : [];
    totalPages = Number(body.result.pages) > 0 ? Number(body.result.pages) : page;
    for (const row of data) {
      if (!matchFilter(row, filter)) continue;
      const period = normPeriod(row[periodField], dateMode);
      const value = num(row[valueField]);
      if (!period || !Number.isFinite(value)) continue;
      rows.push({ period: period, value: value, unit: unit });
    }
    if (page >= totalPages || !data.length) break;
    if (range) {
      const oldest = data.map(r => normPeriod(r[periodField], dateMode)).filter(Boolean).sort()[0];
      if (oldest && beforeStart(oldest, range)) break; // 倒序：已翻到区间之前
    }
  }

  const records = rows.filter(r => inRange(r.period, range))
    .sort((x, y) => (x.period < y.period ? -1 : x.period > y.period ? 1 : 0));
  process.stdout.write(JSON.stringify({
    ok: true,
    source: "eastmoney:" + report,
    range: rangeStr,
    records: records,
  }) + "\n");
  process.exit(0);
}
main().catch(e => fail((e && e.message) || e));
