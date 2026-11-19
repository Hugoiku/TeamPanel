#!/usr/bin/env node
"use strict";
/**
 * backup — 单用户生产备份：账本/vault/配置/运行数据。
 *   node scripts/backup.js --out backup/2026... [--keep 5] [--include-raw] [--dry-run]
 * 默认不备份 runtime/secrets（凭据单独保管），不备份 runtime/data/raw（体积大）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.indexOf("--" + k) >= 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = path.resolve(ROOT, arg("out", path.join("backup", stamp)));
const DRY = flag("dry-run");
const INCLUDE_RAW = flag("include-raw");
const KEEP = Math.max(1, parseInt(arg("keep", "5"), 10) || 5);
const ITEMS = ["runtime/ledger", "vault", "config", "runtime/data", "runtime/agent-loops", "runtime/work", "runtime/auto-runs"];
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function walk(root, rel, out) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const full = path.join(root, e.name), r = path.join(rel, e.name);
    if (e.isDirectory()) {
      if (!INCLUDE_RAW && /(^|\/)runtime\/data\/raw($|\/)/.test(r)) continue;
      walk(full, r, out);
    } else if (e.isFile()) {
      if (/(^|\/)runtime\/secrets($|\/)/.test(r)) continue;
      const st = fs.statSync(full);
      const item = { path: r, bytes: st.size };
      if (st.size <= 20 * 1024 * 1024) item.sha256 = sha(full);
      out.push(item);
    }
  }
}
const files = [];
ITEMS.forEach(rel => { const abs = path.join(ROOT, rel); if (fs.existsSync(abs)) walk(abs, rel, files); });
const manifest = { version: 1, createdAt: new Date().toISOString(), root: ROOT, includeRaw: INCLUDE_RAW,
  items: ITEMS, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0), count: files.length };
if (DRY) {
  console.log(JSON.stringify({ ok: true, dryRun: true, out: OUT, count: manifest.count, totalBytes: manifest.totalBytes }, null, 2));
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
ITEMS.forEach(rel => {
  const src = path.join(ROOT, rel); if (!fs.existsSync(src)) return;
  if (!INCLUDE_RAW && rel === "runtime/data") {
    fs.mkdirSync(path.join(OUT, rel), { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === "raw") continue;
      fs.cpSync(path.join(src, name), path.join(OUT, rel, name), { recursive: true });
    }
  } else fs.cpSync(src, path.join(OUT, rel), { recursive: true });
});
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
const base = path.dirname(OUT);
try {
  const olds = fs.readdirSync(base).map(n => path.join(base, n)).filter(p => fs.statSync(p).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  olds.slice(KEEP).forEach(p => { if (p !== OUT) fs.rmSync(p, { recursive: true, force: true }); });
} catch (e) {}
console.log(JSON.stringify({ ok: true, out: OUT, count: manifest.count, totalBytes: manifest.totalBytes }, null, 2));
