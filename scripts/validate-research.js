"use strict";
/** Deterministic research evidence validator: citations, evidence records, claim sources. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "");
if (!CASE) { console.error("--case required"); process.exit(2); }
const base = path.join(ROOT, "vault", CASE, "research");
const evPath = path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl");
const ids = new Set();
try { for (const line of fs.readFileSync(evPath, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.id) ids.add(String(e.id)); } catch (e) {} } } catch (e) {}
const agents = ["macro", "industry", "stock"];
const issues = [];
function scanText(agent, file, text) {
  if (!text) return;
  const refs = text.match(/\[S\d+\]/g) || [];
  const uniq = [...new Set(refs.map(x => x.replace(/[\[\]]/g, "")))];
  uniq.forEach(id => { if (!ids.has(id)) issues.push({ severity: "high", type: "missing_evidence", agent, file, ref: id }); });
}
for (const agent of agents) {
  const md = path.join(base, agent + ".md");
  const js = path.join(base, agent + ".json");
  try { scanText(agent, path.relative(ROOT, md), fs.readFileSync(md, "utf8")); } catch (e) {}
  try {
    const j = JSON.parse(fs.readFileSync(js, "utf8"));
    const claims = Array.isArray(j.claims) ? j.claims : [];
    claims.forEach((c, i) => {
      const src = String(c.source || c.sources || "");
      const refs = src.match(/S\d+/g) || [];
      if (!refs.length) issues.push({ severity: "medium", type: "claim_without_source", agent, claim: c.id || i, text: String(c.text || "").slice(0, 80) });
      refs.forEach(id => { if (!ids.has(id)) issues.push({ severity: "high", type: "missing_evidence", agent, file: agent + ".json", ref: id }); });
    });
  } catch (e) {}
}
const high = issues.filter(x => x.severity === "high").length;
const out = { ok: high === 0, case: CASE, evidence: ids.size, issues, high, generatedAt: new Date().toISOString() };
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, "validation.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exit(high ? 3 : 0);
