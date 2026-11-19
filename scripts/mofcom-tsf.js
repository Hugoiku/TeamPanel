#!/usr/bin/env node
"use strict";
/**
 * mofcom-tsf — 商务部数据中心 · 社会融资规模增量（免费、无需积分）
 * 零依赖（Node 22 内置 fetch），stdout 输出一行 JSON。
 *
 *   node scripts/mofcom-tsf.js --range 2025-01..2026-10
 *   node scripts/mofcom-tsf.js --range 2025-01..2026-10 --value-field tiosfs --unit 亿元
 *
 * 成功：{"ok":true,"source":"mofcom:tsf","range":"...","records":[{"period":"2026-04","value":6245,"unit":"亿元"}]}，exit 0
 * 失败：stdout 与 stderr 各一行 {"ok":false,"error":"..."}，exit 1
 */
const URL_TSF = "https://data.mofcom.gov.cn/datamofcom/front/gnmy/shrzgmQuery";
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
/** "202604" / "2026-04" / "2026-04-01" -> "2026-04" */
function normMonth(raw) {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})[-/.]?(\d{2})(?:[-/.]?(\d{2}))?$/);
  if (m) {
    const mo = m[2];
    if (Number(mo) < 1 || Number(mo) > 12) return "";
    return m[1] + "-" + mo;
  }
  m = s.match(/^(\d{4})年(\d{1,2})月/);
  if (m) return m[1] + "-" + pad2(m[2]);
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

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const rangeStr = str(a.range, "");
  const range = rangeStr ? parseRange(rangeStr) : null;
  if (rangeStr && !range) fail("--range 格式不正确：" + rangeStr + "（应为 2025-01..2026-10）");
  const dateField = str(a["date-field"], "date");
  const valueField = str(a["value-field"], "tiosfs");
  const unit = str(a.unit, "亿元");

  const res = await fetch(URL_TSF, {
    method: "POST",
    headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + text.slice(0, 200));
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error("响应不是 JSON：" + text.slice(0, 200)); }

  let arr = null;
  if (Array.isArray(body)) arr = body;
  else if (body && Array.isArray(body.data)) arr = body.data;
  else if (body && Array.isArray(body.records)) arr = body.records;
  if (!arr) throw new Error("响应结构不是数组：" + text.slice(0, 200));
  if (!arr.length) throw new Error("社融接口返回空数组");

  const records = arr.map(row => {
    const period = normMonth(row[dateField]);
    const value = num(row[valueField]);
    if (!period || !Number.isFinite(value)) return null;
    return { period: period, value: value, unit: unit };
  }).filter(Boolean)
    .filter(r => inRange(r.period, range))
    .sort((x, y) => (x.period < y.period ? -1 : x.period > y.period ? 1 : 0));

  process.stdout.write(JSON.stringify({
    ok: true,
    source: "mofcom:tsf",
    range: rangeStr,
    records: records,
  }) + "\n");
  process.exit(0);
}
main().catch(e => fail((e && e.message) || e));
