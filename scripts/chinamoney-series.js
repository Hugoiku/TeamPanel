#!/usr/bin/env node
"use strict";
/**
 * chinamoney-series — 中国货币网通用序列 connector（SHIBOR、拆借等，免费、无需积分）
 * 零依赖（Node 22 内置 fetch），stdout 输出一行 JSON。
 *
 *   node scripts/chinamoney-series.js --path cm-u-bk-shibor/ShiborHis --field 1W --range 2026-10-01..2026-11-16
 *   node scripts/chinamoney-series.js --path cm-u-bk-shibor/ShiborHis --field 1W --range 2025-01..2026-11
 *
 * 已知接口限制（实测）：单次查询跨自然年或时长接近/超过 1 年时返回空 records；
 * 月末不存在的日期（如 2026-11-31）也会返回空。因此本脚本：
 *   1) month 模式的 end 取该月最后一天（2026-11 → 2026-11-30）；
 *   2) 查询按"不跨自然年、每片最多 6 个月"分片，逐片请求后合并、按 period 去重升序；
 *   3) 单片失败不整体失败，全部失败才 exit 1。
 *
 * 成功：{"ok":true,"source":"chinamoney:<path>","range":"...","shards":{...},"records":[{"period":"2026-11-16","value":1.39,"unit":"%"}]}，exit 0
 * 失败：stdout 与 stderr 各一行 {"ok":false,"error":"..."}，exit 1
 */
const BASE = "https://www.chinamoney.com.cn/ags/ms/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;
const UNIT = "%";
const SHARD_MONTHS = 6;   // 单片最多 6 个月（接口对 ~1 年区间不稳定）
const MAX_SHARDS = 200;   // 防失控上限

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
function isoDate(d) { return d.toISOString().slice(0, 10); }

/** "2026-11" -> "2026-11-30"（该月最后一天） */
function lastDayOfMonth(ym) {
  const y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  return isoDate(new Date(Date.UTC(y, mo, 0)));
}
/** 2025-01..2026-10 / 2026-10-01..2026-11-16 -> {mode,start,end}，start/end 均为 YYYY-MM-DD */
function parseRange(raw) {
  const m = String(raw || "").trim().match(/^(\d{4}-\d{2}(?:-\d{2})?)\.\.(\d{4}-\d{2}(?:-\d{2})?)$/);
  if (!m) return null;
  const s = m[1], e = m[2];
  const mode = s.length === 7 && e.length === 7 ? "month" : "day";
  return {
    mode: mode,
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
  return period >= range.start && period <= range.end;
}
/** "2026-11-16" / "2026/11/16" / "20261116" -> "2026-11-16" */
function normDate(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
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
/** "1W" -> "1W"；"O/N" -> "ON"（货币网字段名差异） */
function pickField(row, field) {
  if (row[field] !== undefined) return row[field];
  const flat = field.replace(/\//g, "");
  if (row[flat] !== undefined) return row[flat];
  const hit = Object.keys(row).find(k => k.replace(/\//g, "").toUpperCase() === flat.toUpperCase());
  return hit === undefined ? undefined : row[hit];
}

function nextDay(iso) {
  const y = Number(iso.slice(0, 4)), mo = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  return isoDate(new Date(Date.UTC(y, mo - 1, d + 1)));
}
function endOfMonthAfter(iso, months) {
  const y = Number(iso.slice(0, 4)), mo = Number(iso.slice(5, 7));
  return isoDate(new Date(Date.UTC(y, mo - 1 + months + 1, 0)));
}
function endOfYear(iso) { return iso.slice(0, 4) + "-12-31"; }

/** 分片：不跨自然年、单片 <= SHARD_MONTHS 个月、不超出 range.end */
function shardWindows(range) {
  const out = [];
  let cur = range.start;
  while (cur <= range.end && out.length < MAX_SHARDS) {
    let end = endOfMonthAfter(cur, SHARD_MONTHS - 1);
    if (end > endOfYear(cur)) end = endOfYear(cur);
    if (end > range.end) end = range.end;
    out.push({ start: cur, end: end });
    if (end >= range.end) break;
    cur = nextDay(end);
  }
  return out;
}

async function fetchShard(pathname, field, dateField, method, shard) {
  const qs = new URLSearchParams();
  qs.set("lang", "CN");
  qs.set("startDate", shard.start);
  qs.set("endDate", shard.end);
  const res = await fetch(BASE + pathname + "?" + qs.toString(), {
    method: method,
    headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 160));
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error("响应不是 JSON：" + text.slice(0, 160)); }
  const arr = Array.isArray(body) ? body
    : (body && Array.isArray(body.records)) ? body.records
    : (body && body.data && Array.isArray(body.data.records)) ? body.data.records
    : null;
  if (!arr) throw new Error("响应里没有 records 数组：" + text.slice(0, 160));
  return arr.map(row => {
    const period = normDate(row[dateField]);
    const value = num(pickField(row, field));
    if (!period || !Number.isFinite(value)) return null;
    return { period: period, value: value, unit: UNIT };
  }).filter(Boolean);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const p = str(a.path, "").replace(/^\/+/, "");
  if (!p) fail("缺少 --path（例如 cm-u-bk-shibor/ShiborHis）");
  const field = str(a.field, "");
  if (!field) fail("缺少 --field（例如 1W）");
  const rangeStr = str(a.range, "");
  let range = rangeStr ? parseRange(rangeStr) : null;
  if (rangeStr && !range) fail("--range 格式不正确：" + rangeStr + "（应为 2026-10-01..2026-11-16 或 2025-01..2026-11）");
  if (!range) {
    const end = new Date();
    range = { mode: "day", start: isoDate(new Date(end.getTime() - 90 * 86400000)), end: isoDate(end) };
  }
  if (range.start > range.end) fail("--range 起点晚于终点：" + rangeStr);
  const dateField = str(a["date-field"], "showDateCN");
  const method = str(a.method, "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const unit = str(a.unit, UNIT);

  const shards = shardWindows(range);
  const seen = new Map();
  let okShards = 0;
  let failedShards = 0;
  let lastError = null;
  const shardErrors = [];
  for (const shard of shards) {
    try {
      const rows = await fetchShard(p, field, dateField, method, shard);
      okShards += 1;
      for (const rec of rows) {
        if (!seen.has(rec.period)) seen.set(rec.period, { period: rec.period, value: rec.value, unit: unit });
      }
    } catch (e) {
      failedShards += 1;
      lastError = e;
      shardErrors.push(shard.start + ".." + shard.end + "：" + ((e && e.message) || e));
    }
  }
  if (!shards.length) throw new Error("区间为空：" + rangeStr);
  if (okShards === 0) {
    throw new Error("全部 " + shards.length + " 个分片请求失败：" + ((lastError && lastError.message) || lastError));
  }

  const records = Array.from(seen.values())
    .filter(r => inRange(r.period, range))
    .sort((x, y) => (x.period < y.period ? -1 : x.period > y.period ? 1 : 0));

  const payload = {
    ok: true,
    source: "chinamoney:" + p,
    range: rangeStr,
    shards: { total: shards.length, ok: okShards, failed: failedShards },
    records: records,
  };
  if (shardErrors.length) payload.shardErrors = shardErrors.slice(0, 5);
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(0);
}
main().catch(e => fail((e && e.message) || e));
