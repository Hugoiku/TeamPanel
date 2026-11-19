"use strict";
/** Detect duplicate evidence without destructive merge. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const p = path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl");
const rows = [];
try { for (const line of fs.readFileSync(p, "utf8").split(String.fromCharCode(10))) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch (e) {} } } catch (e) {}
const groups = {};
rows.forEach(r => {
  const url = String(r.url || "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const field = String(r.field || "").replace(/[（(].*?[）)]/g, "").replace(/[\s，。；、：:]/g, "").slice(0, 50);
  const key = url + "|" + field;
  (groups[key] = groups[key] || []).push(r.id);
});
const duplicates = Object.keys(groups).filter(k => groups[k].length > 1).map(k => ({ key: k, ids: groups[k] }));
const byId = {}; rows.forEach(r => { byId[r.id] = r; });
const tierRank = { official: 0, "market-api": 1, media: 2 };
const suggestions = duplicates.map(g => {
  const rs = g.ids.map(id => byId[id]).filter(Boolean);
  const keep = rs.slice().sort((a, b) => (tierRank[a.source_tier] ?? 9) - (tierRank[b.source_tier] ?? 9) || String(a.id).localeCompare(String(b.id)))[0];
  return { key: g.key, keep: keep && keep.id, aliases: g.ids.filter(id => !keep || id !== keep.id),
    reason: "同 URL/field；保留来源层级最高、ID 最早的一条，其余作为别名，不自动删除" };
});
const out = { ok: duplicates.length === 0, case: CASE, evidence: rows.length, duplicateGroups: duplicates.length,
  duplicates, suggestions, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(ROOT, "vault", CASE, "research", "evidence-duplicates.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
