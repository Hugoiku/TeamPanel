#!/usr/bin/env node
"use strict";
/**
 * tushare-series — 通用 Tushare 序列 connector
 *   node scripts/tushare-series.js --api cn_m --range 2025-01..2026-10 --date-mode monthly  *     --fields month,m1_yoy --period-field month --value-field m1_yoy --unit %
 * 输出 { ok, records:[{period,value,unit}] }，供 data-worker 消费。
 */
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const api = arg("api", "");
const range = String(arg("range", ""));
const dateMode = arg("date-mode", "monthly");
const fields = arg("fields", "");
const periodField = arg("period-field", "");
const valueField = arg("value-field", "");
const unit = arg("unit", "");
const filterField = arg("filter-field", "");
const filterValue = arg("filter-value", "");
const paramsRaw = arg("params", "");
function rangeParts() {
  const m = range.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?\.\.(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return { startM: "202501", endM: "202610", startD: "20250101", endD: "20261031" };
  const startM = m[1] + m[2], endM = m[4] + m[5];
  const startD = m[1] + m[2] + (m[3] || "01");
  const lastDay = (y, mo) => String(new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate()).padStart(2, "0");
  const endD = m[4] + m[5] + (m[6] || lastDay(m[4], m[5]));
  return { startM, endM, startD, endD };
}
const rp = rangeParts();
let params = {};
try { params = paramsRaw ? JSON.parse(paramsRaw) : {}; } catch (e) { params = {}; }
if (dateMode === "monthly") {
  if (params.start_m === undefined) params.start_m = rp.startM;
  if (params.end_m === undefined) params.end_m = rp.endM;
} else {
  if (params.start_date === undefined) params.start_date = rp.startD;
  if (params.end_date === undefined) params.end_date = rp.endD;
}
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/tushare_any.js"),
  "--api", api, "--params", JSON.stringify(params), "--fields", fields],
  { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
let j = null;
try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
if (!j || j.ok === false || !Array.isArray(j.items)) {
  console.log(JSON.stringify({ ok: false, error: (j && j.error) || String(r.stderr || "").slice(0, 300), records: [] }));
  process.exit(0);
}
const cols = Array.isArray(j.fields) ? j.fields : [];
const pi = periodField ? cols.indexOf(periodField) : 0;
const vi = valueField ? cols.indexOf(valueField) : (cols.length > 1 ? 1 : 0);
const fi = filterField ? cols.indexOf(filterField) : -1;
function normPeriod(x) {
  const s = String(x || "").replace(/[^0-9]/g, "");
  if (s.length >= 8) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  if (s.length >= 6) return s.slice(0, 4) + "-" + s.slice(4, 6);
  return "";
}
const records = j.items.map(row => {
  if (fi >= 0 && filterValue && String(row[fi]) !== filterValue) return null;
  const period = normPeriod(row[pi]);
  const value = Number(row[vi]);
  if (!period || !Number.isFinite(value)) return null;
  return { period, value, unit };
}).filter(Boolean);
console.log(JSON.stringify({ ok: true, source: "tushare-" + api, range, records }));
