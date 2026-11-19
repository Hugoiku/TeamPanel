#!/usr/bin/env node
"use strict";
/** G-COVERAGE：检查 scope 报告章节是否在底稿中出现。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
const CASE = arg("case", "");
const AGENT = arg("agent", "");
if (!CASE || !AGENT) { console.error("--case --agent required"); process.exit(2); }
const scopePath = path.join(ROOT, "runtime/scope", CASE + "-" + AGENT + ".json");
const mdPath = path.join(ROOT, "vault", CASE, "research", AGENT + ".md");
let scope = null;
try { scope = JSON.parse(fs.readFileSync(scopePath, "utf8")); } catch (e) {}
if (!scope) {
  console.log(JSON.stringify({ ok: false, error: "scope not found", scopePath }, null, 2)); process.exit(flag("strict") ? 1 : 0);
}
let md = ""; try { md = fs.readFileSync(mdPath, "utf8"); } catch (e) {}
const headings = md.split(String.fromCharCode(10)).filter(l => /^#{1,6}\s/.test(l)).join(String.fromCharCode(10));
const sections = (scope.reportSections || []).map(s => {
  const words = [s.title].concat(s.keywords || []);
  const covered = words.some(w => w && headings.indexOf(w) >= 0) ||
    (s.modules || []).some(m => md.indexOf(m) >= 0);
  return { id: s.id, title: s.title, modules: s.modules, impact: s.impact || "important", covered };
});
const missing = sections.filter(s => !s.covered).map(s => s.title);
const criticalMissing = sections.filter(s => !s.covered && s.impact === "critical").map(s => s.title);
const importantMissing = sections.filter(s => !s.covered && s.impact === "important").map(s => s.title);
const minorMissing = sections.filter(s => !s.covered && s.impact === "minor").map(s => s.title);
const ok = missing.length === 0;
const formal = criticalMissing.length === 0;
const modules = {};
sections.forEach(sec => (sec.modules || []).forEach(id => {
  modules[id] = { id, status: sec.covered ? "covered" : "gap",
    evidenceLevel: "unknown", section: sec.title };
}));
try {
  const outDir = path.join(ROOT, "vault", CASE, "research");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "checklist.json"), JSON.stringify({
    case: CASE, agent: AGENT, updatedAt: new Date().toISOString(),
    sections, modules, ready: ok, formal, criticalMissing, importantMissing, minorMissing
  }, null, 2));
} catch (e) {}
console.log(JSON.stringify({ ok, case: CASE, agent: AGENT, md: mdPath, sections, missing,
  covered: sections.length - missing.length, total: sections.length,
  formal, criticalMissing, importantMissing, minorMissing }, null, 2));
process.exit(flag("strict") && !ok ? 1 : 0);
