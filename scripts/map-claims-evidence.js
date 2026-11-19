"use strict";
/** Map claims to exact evidence snippets by cited source + numeric tokens. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
const claims = JSON.parse(fs.readFileSync(path.join(base, "claims.json"), "utf8"));
const all = [...(claims.macro.claims || []), ...(claims.industry.claims || []), ...(claims.stock.claims || [])];
const records = {};
function flat(v, p, out) {
  if (!v || out.length > 160) return;
  if (typeof v === "object") { for (const k of Object.keys(v)) flat(v[k], p ? p + "." + k : k, out); return; }
  const s = String(v); if (!s) return;
  if (s.length <= 180) { out.push((p || "value") + "=" + s); return; }
  // 长文本按句/分号切段，保留数字所在句，不丢财政等文字型证据。
  String(s).split(/[。；;]/).map(x => x.trim()).filter(Boolean).forEach((seg, i) => {
    if (seg.length <= 240) out.push((p || "value") + "#" + (i + 1) + "=" + seg);
  });
}
try { for (const l of fs.readFileSync(path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl"), "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const x = JSON.parse(l); if (!x.id) continue; const arr = []; flat(x.value != null ? x.value : (x.text || x.title || ""), x.field || "value", arr); records[x.id] = { field: x.field || "", lines: arr }; } catch (e) {} } } catch (e) {}
const out = [];
all.forEach(c => {
  const refs = [...new Set([...(String(c.source || "").match(/S\d+/g) || []), ...(String(c.text || "").match(/S\d+/g) || [])])];
  const nums = [...new Set((String(c.text || "").match(/[-+]?\d+(?:\.\d+)?/g) || []).filter(x => x.length >= 2))].slice(0, 8);
  const snippets = [];
  refs.forEach(id => {
    const r = records[id]; if (!r) return;
    const hits = r.lines.filter(line => nums.some(n => line.includes(n)));
    (hits.length ? hits : r.lines).slice(0, 5).forEach(line => snippets.push({ source: id, field: r.field, text: line.slice(0, 240) }));
  });
  out.push({ id: c.id, text: String(c.text || "").slice(0, 300), refs, numbers: nums, snippets, mapped: snippets.length > 0 });
});
const data = { ok: true, case: CASE, claims: out.length, mapped: out.filter(x => x.mapped).length, claimsEvidence: out, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(base, "claim-evidence.json"), JSON.stringify(data, null, 2));
console.log(JSON.stringify({ ok: true, claims: data.claims, mapped: data.mapped }));
