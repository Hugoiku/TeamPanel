#!/usr/bin/env node
"use strict";
/** Build cross-case archive manifest/index for reuse. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const VAULT = path.join(ROOT, "vault");
const OUT = path.join(ROOT, "runtime/archive");
function walk(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach(name => {
    const abs = path.join(dir, name), rel = base ? base + "/" + name : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { if (name === "history" || name === "_trash") return; out.push(...walk(abs, rel)); return; }
    out.push({ path: rel, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
  });
  return out;
}
function readJsonl(p) {
  try { return fs.readFileSync(p, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch (e) { return []; }
}
const rows = [];
fs.mkdirSync(OUT, { recursive: true });
fs.readdirSync(VAULT).forEach(caseId => {
  if (caseId === "_trash" || caseId.startsWith(".")) return;
  const dir = path.join(VAULT, caseId);
  if (!fs.statSync(dir).isDirectory()) return;
  const mission = (() => { try { return fs.readFileSync(path.join(dir, "mission.md"), "utf8").slice(0, 2000); } catch (e) { return ""; } })();
  const evidence = readJsonl(path.join(dir, "evidence/sources.jsonl"));
  const files = walk(dir, "");
  const reports = files.filter(f => /^reports\/.*\.(docx|md)$/.test(f.path)).map(f => f.path);
  const research = files.filter(f => /^research\/.*\.(md|json)$/.test(f.path)).map(f => f.path);
  const manifest = { case: caseId, mission: mission.slice(0, 500), files, evidence: evidence.length,
    reports, research, updatedAt: new Date().toISOString() };
  const md = path.join(OUT, caseId.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".manifest.json");
  fs.writeFileSync(md, JSON.stringify(manifest, null, 2));
  rows.push(manifest);
});
rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ updatedAt: new Date().toISOString(), cases: rows }, null, 2));
console.log(JSON.stringify({ ok: true, cases: rows.length, index: "runtime/archive/index.json" }, null, 2));
