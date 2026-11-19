"use strict";
/** Audit numeric figures referenced by report sections. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) { console.error("--case required"); process.exit(2); }
const vault = path.join(ROOT, "vault", CASE);
const reportDir = path.join(vault, "reports");
const refs = new Map();
for (const rel of ["master.md", "sections/macro.md", "sections/industry.md", "sections/stock.md", "investor-final.md"]) {
  let txt = ""; try { txt = fs.readFileSync(path.join(reportDir, rel), "utf8"); } catch (e) {}
  for (const m of txt.matchAll(/!\[[^\]]*\]\((figures\/[^)]+)\)/g)) {
    const p = m[1]; if (!refs.has(p)) refs.set(p, []); refs.get(p).push(rel);
  }
}
try { const ex = JSON.parse(fs.readFileSync(path.join(vault, "research", "exhibits.json"), "utf8")); (ex.items || []).forEach(x => { if (!refs.has(x.path)) refs.set(x.path, ["exhibits"]); }); } catch (e) {}
let latestResearch = 0;
try { for (const f of fs.readdirSync(path.join(vault, "research"))) { if (!/\.(md|json)$/.test(f)) continue; const st = fs.statSync(path.join(vault, "research", f)); latestResearch = Math.max(latestResearch, st.mtimeMs); } } catch (e) {}
const items = [], missing = [], stale = [];
for (const [rel, usedBy] of refs) {
  const abs = path.join(vault, rel);
  const item = { path: rel, usedBy, exists: false, bytes: 0, modifiedAt: "", stale: false };
  try { const st = fs.statSync(abs); item.exists = true; item.bytes = st.size; item.modifiedAt = st.mtime.toISOString();
    item.stale = st.mtimeMs < latestResearch - 60000; if (item.stale) stale.push(rel); } catch (e) { missing.push(rel); }
  items.push(item);
}
const out = { ok: missing.length === 0, case: CASE, count: items.length, usable: items.filter(x => x.exists).length,
  missing, stale, items, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(vault, "research", "figures.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
