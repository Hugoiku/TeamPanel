"use strict";
/** Deterministic numeric/evidence consistency checks. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) { console.error("--case required"); process.exit(2); }
const base = path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl");
const rows = [];
try { for (const line of fs.readFileSync(base, "utf8").split(String.fromCharCode(10))) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch (e) {} } } catch (e) {}
const issues = [];
const byField = {};
function nums(v) { return [...String(v == null ? "" : v).matchAll(/(\d[\d,.]*)\s*(亿元|亿美元|%|万部|万台|倍|元\/秒|万元)/g)].map(m => m[1].replace(/,/g, "") + m[2]); }
rows.forEach(r => {
  const key = String(r.field || "").replace(/[（(].*?[）)]/g, "").replace(/[\s，。；、：:]/g, "").slice(0, 60);
  if (!key) return;
  (byField[key] = byField[key] || []).push(r);
});
Object.keys(byField).forEach(k => {
  const list = byField[k];
  if (list.length < 2) return;
  const values = {};
  list.forEach(r => nums(r.value).forEach(n => { values[n] = (values[n] || []).concat(r.id); }));
  const uniq = Object.keys(values);
  if (uniq.length > 1) issues.push({ severity: "medium", type: "numeric_conflict", field: k, values: values });
  const ids = list.map(r => r.id);
  if (new Set(ids).size !== ids.length) issues.push({ severity: "low", type: "duplicate_evidence", field: k, ids });
});
const high = issues.filter(x => x.severity === "high").length;
const out = { ok: high === 0, case: CASE, evidence: rows.length, issues, high, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(ROOT, "vault", CASE, "research", "consistency.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
