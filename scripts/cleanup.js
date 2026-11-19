#!/usr/bin/env node
"use strict";
// cleanup — 清理工作区/缓存/运行日志
//   node scripts/cleanup.js [--days 7] [--work] [--cache] [--runs] [--dry-run]
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) >= 0; }
const days = Math.max(1, parseInt(arg("days", "7"), 10) || 7);
const cutoff = Date.now() - days * 86400000;
const dry = flag("dry-run");
const all = !flag("work") && !flag("cache") && !flag("runs");
let removed = 0, bytes = 0;
function rm(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      fs.readdirSync(p).forEach(f => rm(path.join(p, f)));
      if (!dry) fs.rmdirSync(p);
    } else { bytes += st.size; if (!dry) fs.unlinkSync(p); }
    removed += 1;
  } catch (e) {}
}
function scan(dir, older) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < older) rm(p);
    } catch (e) {}
  });
}
if (all || flag("work")) scan(path.join(ROOT, "runtime/work"), cutoff);
if (all || flag("cache")) scan(path.join(ROOT, "runtime/cache/collect"), cutoff);
if (all || flag("runs")) scan(path.join(ROOT, "runtime/agent-runs"), cutoff);
console.log(JSON.stringify({ ok: true, days, dryRun: dry, removed, bytes }));
