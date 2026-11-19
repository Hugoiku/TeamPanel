#!/usr/bin/env node
"use strict";
/**
 * restore — 从 backup 目录恢复。
 *   node scripts/restore.js --backup backup/xxx [--apply] [--verify-only]
 * 默认只校验并打印计划；--apply 才写入。
 * 恢复前请停止 broker（脚本会检查 runtime/broker.pid）。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.indexOf("--" + k) >= 0;
const DIR = path.resolve(ROOT, arg("backup", ""));
const APPLY = flag("apply");
if (!DIR || !fs.existsSync(DIR)) { console.error("需要 --backup <dir>"); process.exit(2); }
const man = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
const bad = [];
for (const f of (man.files || [])) {
  const abs = path.join(DIR, f.path);
  if (!fs.existsSync(abs)) { bad.push({ path: f.path, error: "missing" }); continue; }
  if (f.sha256 && sha(abs) !== f.sha256) bad.push({ path: f.path, error: "sha mismatch" });
}
if (bad.length) { console.log(JSON.stringify({ ok: false, error: "backup corrupted", bad: bad.slice(0, 20) }, null, 2)); process.exit(1); }
let brokerAlive = false;
try {
  const pid = parseInt(fs.readFileSync(path.join(ROOT, "runtime/broker.pid"), "utf8"), 10);
  if (pid) { try { process.kill(pid, 0); brokerAlive = true; } catch (e) {} }
} catch (e) {}
const plan = { backup: DIR, createdAt: man.createdAt, files: (man.files || []).length,
  totalBytes: man.totalBytes || 0, brokerAlive, apply: APPLY };
if (!APPLY || flag("verify-only")) { console.log(JSON.stringify({ ok: true, verified: true, plan }, null, 2)); process.exit(0); }
if (brokerAlive) { console.log(JSON.stringify({ ok: false, error: "broker 仍在运行，请先停止" }, null, 2)); process.exit(1); }
(man.items || []).forEach(rel => {
  const src = path.join(DIR, rel); if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  fs.cpSync(src, path.join(ROOT, rel), { recursive: true, force: true });
});
console.log(JSON.stringify({ ok: true, restored: true, backup: DIR }, null, 2));
