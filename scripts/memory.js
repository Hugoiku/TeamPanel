#!/usr/bin/env node
"use strict";
/**
 * memory — 案件记忆索引：build / search / state / checkpoint
 *   node scripts/memory.js build --case case-2026-003
 *   node scripts/memory.js search --case case-2026-003 --q "锗价 库存" [--k 5]
 *   node scripts/memory.js state --case case-2026-003 --agent macro
 *   node scripts/memory.js state --case case-2026-003 --agent macro --set <state.json>
 *   node scripts/memory.js checkpoint --case case-2026-003 --agent macro --state <state.json>
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const CMD = process.argv[2] || "search";
const CASE = arg("case", "default");
const MEM_DIR = path.join(ROOT, "runtime/memory", CASE);
const INDEX = path.join(MEM_DIR, "index.json");
function loadIndex() { try { return JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch (e) { return { case: CASE, files: [], kb: [], evidence: [] }; } }
function strip(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function summaryOf(text) {
  const noFm = String(text || "").replace(/^---[\s\S]*?---\n?/, "");
  const title = (noFm.match(/^#\s+(.+)$/m) || [])[1] || "";
  return { title: strip(title).slice(0, 80), summary: strip(noFm).slice(0, 400) };
}
function refsOf(text) { const s = new Set(); (String(text || "").match(/\[S\d+\]/g) || []).forEach(x => s.add(x.replace(/[\[\]]/g, ""))); return Array.from(s); }
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f), st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(md|json|jsonl|csv|txt)$/i.test(f) && st.size < 2e6) out.push(p);
  });
  return out;
}
if (CMD === "build") {
  const vault = path.join(ROOT, "vault", CASE);
  const files = walk(vault, []).filter(p => p.indexOf(path.join("memory")) < 0).map(p => {
    const rel = path.relative(vault, p).split(path.sep).join("/");
    const text = fs.readFileSync(p, "utf8");
    const sm = summaryOf(text);
    return { path: rel, version: null, title: sm.title, summary: sm.summary, refs: refsOf(text), bytes: fs.statSync(p).size };
  });
  // 文件版本（来自 broker 账本，可选）
  const ledger = path.join(ROOT, "runtime/ledger/events.jsonl");
  const versions = {};
  try {
    fs.readFileSync(ledger, "utf8").trim().split("\n").forEach(l => {
      let e; try { e = JSON.parse(l); } catch (x) { return }
      if (e.case === CASE && e.type === "file.written" && e.path) versions[e.path] = Math.max(versions[e.path] || 0, e.v || 0);
    });
  } catch (e) {}
  files.forEach(f => { if (versions[f.path]) f.version = versions[f.path]; });
  const kb = [];
  const kbRoot = path.join(ROOT, "runtime/kb");
  if (fs.existsSync(kbRoot)) fs.readdirSync(kbRoot).forEach(a => {
    const dir = path.join(kbRoot, a);
    if (!fs.statSync(dir).isDirectory()) return;
    walk(dir, []).forEach(p => {
      const text = fs.readFileSync(p, "utf8"); const sm = summaryOf(text);
      kb.push({ agent: a, slug: path.basename(p, ".md"), title: sm.title, summary: sm.summary, refs: refsOf(text) });
    });
  });
  const evidence = [];
  const evFile = path.join(vault, "evidence/sources.jsonl");
  if (fs.existsSync(evFile)) fs.readFileSync(evFile, "utf8").trim().split("\n").forEach(l => {
    let e; try { e = JSON.parse(l); } catch (x) { return }
    evidence.push({ id: e.id, field: strip(e.field).slice(0, 80), value: JSON.stringify(e.value).slice(0, 120), url: e.url });
  });
  fs.mkdirSync(MEM_DIR, { recursive: true });
  const idx = { case: CASE, builtAt: new Date().toISOString(), files, kb, evidence };
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2));
  console.log(JSON.stringify({ ok: true, index: path.relative(ROOT, INDEX), files: files.length, kb: kb.length, evidence: evidence.length }));
  process.exit(0);
}
if (CMD === "search") {
  const q = String(arg("q", "")).toLowerCase().split(/\s+/).filter(Boolean);
  const k = parseInt(arg("k", "5"), 10);
  const idx = loadIndex();
  function score(item) {
    const hay = (item.path || "") + " " + (item.title || "") + " " + (item.summary || "") + " " + (item.refs || []).join(" ");
    const low = hay.toLowerCase(); let s = 0;
    q.forEach(w => { const n = low.split(w).length - 1; if (n) s += n * ((item.title || "").toLowerCase().indexOf(w) >= 0 ? 3 : 1); });
    return s;
  }
  const hits = [];
  idx.files.forEach(f => { const s = score(f); if (s > 0) hits.push(Object.assign({ kind: "file" }, f, { score: s })); });
  idx.kb.forEach(f => { const s = score(f); if (s > 0) hits.push(Object.assign({ kind: "kb", path: f.agent + "/" + f.slug }, f, { score: s })); });
  idx.evidence.forEach(e => { const s = score(e); if (s > 0) hits.push(Object.assign({ kind: "evidence" }, e, { score: s })); });
  hits.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({ q: q.join(" "), hits: hits.slice(0, k) }, null, 2));
  process.exit(0);
}
if (CMD === "state") {
  const agent = arg("agent", "");
  if (!agent) { console.error("需要 --agent"); process.exit(2); }
  const dir = path.join(MEM_DIR, agent);
  const file = path.join(dir, "state.json");
  const set = arg("set", "");
  if (set) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(set, file); console.log(JSON.stringify({ ok: true, state: path.relative(ROOT, file) })); process.exit(0); }
  if (!fs.existsSync(file)) { console.log(JSON.stringify({ ok: true, state: null })); process.exit(0); }
  process.stdout.write(fs.readFileSync(file, "utf8"));
  process.exit(0);
}
if (CMD === "checkpoint") {
  const agent = arg("agent", "");
  const stateFile = arg("state", "");
  if (!agent || !stateFile) { console.error("需要 --agent 与 --state"); process.exit(2); }
  const dir = path.join(MEM_DIR, agent); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "state.json");
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  let incoming = {}; try { incoming = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) {}
  const next = Object.assign({}, prev, incoming, { checkpointSeq: (prev.checkpointSeq || 0) + 1, checkpointAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(JSON.stringify({ ok: true, state: path.relative(ROOT, file), seq: next.checkpointSeq }));
  process.exit(0);
}
console.error("用法: memory.js build|search|state|checkpoint ...");
process.exit(2);
