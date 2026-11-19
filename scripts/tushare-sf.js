#!/usr/bin/env node
"use strict";
/**
 * tushare-sf — 社会融资规模月度序列（Tushare sf_month）
 *   node scripts/tushare-sf.js --range 2025-01..2026-10
 * 输出 { ok, records:[{period:"YYYY-MM", value, unit}], ... }，供 data-worker 消费。
 */
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const range = String(arg("range", "2025-01..2026-10"));
const m = range.match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
const start = m ? m[1] + m[2] : "202501";
const end = m ? m[3] + m[4] : "202610";
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/tushare_any.js"),
  "--api", "sf_month", "--params", JSON.stringify({ start_m: start, end_m: end }),
  "--fields", "month,inc_month,inc_cumval,stk_endval"],
  { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
let j = null;
try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
if (!j || j.ok === false || !Array.isArray(j.items)) {
  console.log(JSON.stringify({ ok: false, error: (j && j.error) || String(r.stderr || "").slice(0, 300), records: [] }));
  process.exit(0);
}
const records = j.items.map(row => {
  const month = String(row[0] || "");
  const period = month.length >= 6 ? month.slice(0, 4) + "-" + month.slice(4, 6) : "";
  return { period, value: Number(row[1]), unit: "亿元" };
}).filter(x => /^\d{4}-\d{2}$/.test(x.period) && Number.isFinite(x.value));
console.log(JSON.stringify({ ok: true, source: "tushare-sf-month", range, records }));
