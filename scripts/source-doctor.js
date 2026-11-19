#!/usr/bin/env node
"use strict";
/**
 * source-doctor — 数据源体检 CLI。
 *   node scripts/source-doctor.js --list            查看静态 + 缓存结果
 *   node scripts/source-doctor.js --refresh         联网探测所有来源（free/credit）
 *   node scripts/source-doctor.js --refresh --id mofcom-tsf
 */
const h = require("./source-health");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
(async () => {
  const sources = h.loadRegistry();
  if (flag("refresh")) {
    const id = arg("id", "");
    const ids = id ? [id] : [];
    const results = await h.refresh(sources, { ids });
    console.log(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), results }, null, 2));
    return;
  }
  const all = h.healthAll(sources);
  console.log(JSON.stringify({ ok: true, checkedAt: all.checkedAt, sources: all.sources }, null, 2));
})().catch(e => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
