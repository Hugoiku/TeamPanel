#!/usr/bin/env node
"use strict";
/**
 * skill-install — 安装/卸载数据采集技能包
 *   node scripts/skill-install.js --package data-collect-macro-cn [--dry-run]
 *   node scripts/skill-install.js --uninstall data-collect-macro-cn
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) >= 0; }
const dry = flag("dry-run");
const uninstallId = arg("uninstall", "");
const pkgArg = arg("package", "");
const statePath = path.join(ROOT, "runtime/skills/installed.json");
function readState() { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (e) { return { installed: {} }; } }
function writeState(st) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n"); }
function cfgPath() { return path.join(ROOT, "config/desk.json"); }
function readCfg() { return JSON.parse(fs.readFileSync(cfgPath(), "utf8")); }
function writeCfg(c) { fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2) + "\n"); }
function checkDeps(man) {
  const out = { missing: [], ok: [] };
  const req = (man.requires || {});
  (req.python || []).forEach(m => {
    const r = spawnSync(process.env.PYTHON || "python3", ["-c", "import " + m],
      { encoding: "utf8", env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }) });
    if (r.status === 0) out.ok.push("python:" + m); else out.missing.push("python:" + m);
  });
  (req.env || []).forEach(e => {
    if (e === "TUSHARE_TOKEN") {
      let ok = !!process.env.TUSHARE_TOKEN;
      try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/secrets/tushare.json"), "utf8")); ok = ok || !!j.token; } catch (x) {}
      if (ok) out.ok.push("env:" + e); else out.missing.push("env:" + e);
    } else {
      if (process.env[e]) out.ok.push("env:" + e); else out.missing.push("env:" + e);
    }
  });
  return out;
}
if (uninstallId) {
  const st = readState();
  const cfg = readCfg();
  Object.keys(cfg.skills.assign || {}).forEach(a => {
    cfg.skills.assign[a] = (cfg.skills.assign[a] || []).filter(x => x !== uninstallId);
  });
  delete st.installed[uninstallId];
  if (!dry) { writeCfg(cfg); writeState(st); }
  console.log(JSON.stringify({ ok: true, uninstalled: uninstallId, dryRun: dry }, null, 2));
  process.exit(0);
}
if (!pkgArg) { console.error("需要 --package <id> 或 --uninstall <id>"); process.exit(2); }
const pkgDir = path.isAbsolute(pkgArg) ? pkgArg : path.join(ROOT, "skills", pkgArg);
const manPath = path.join(pkgDir, "manifest.json");
if (!fs.existsSync(manPath)) { console.error("找不到包：" + pkgDir); process.exit(3); }
const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
const deps = checkDeps(man);
const changed = [];
if (!dry) {
  // sources
  const sdir = path.join(ROOT, "config/sources");
  fs.mkdirSync(sdir, { recursive: true });
  (man.sources || []).forEach(f => {
    const src = path.join(pkgDir, "sources", f + ".json");
    const dst = path.join(sdir, f + ".json");
    if (!fs.existsSync(src)) return;
    const same = fs.existsSync(dst) && fs.readFileSync(src, "utf8") === fs.readFileSync(dst, "utf8");
    if (!same) {
      if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + ".bak-" + Date.now());
      fs.copyFileSync(src, dst); changed.push("config/sources/" + f + ".json");
    }
  });
  // scripts
  (man.scripts || []).forEach(f => {
    const src = path.join(pkgDir, "scripts", f);
    const dst = path.join(ROOT, "scripts", f);
    if (!fs.existsSync(src)) return;
    const same = fs.existsSync(dst) && fs.readFileSync(src, "utf8") === fs.readFileSync(dst, "utf8");
    if (!same) {
      if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + ".bak-" + Date.now());
      fs.copyFileSync(src, dst); changed.push("scripts/" + f);
    }
  });
  // assignments
  const cfg = readCfg();
  cfg.skills = cfg.skills || {}; cfg.skills.assign = cfg.skills.assign || {};
  (man.assign || []).forEach(a => {
    const list = cfg.skills.assign[a] = cfg.skills.assign[a] || [];
    if (list.indexOf(man.id) < 0) list.push(man.id);
  });
  writeCfg(cfg);
  const st = readState();
  st.installed[man.id] = { version: man.version, installedAt: new Date().toISOString(),
    sources: man.sources || [], scripts: man.scripts || [], deps };
  writeState(st);
}
console.log(JSON.stringify({ ok: true, package: man.id, version: man.version, dryRun: dry,
  changed, deps, assignedTo: man.assign || [] }, null, 2));
