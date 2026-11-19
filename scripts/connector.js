"use strict";
/** Connector recipe runner: JSON path / HTML table -> records. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "config/connectors");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function read(id) { return JSON.parse(fs.readFileSync(path.join(DIR, id + ".json"), "utf8")); }
function write(j) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, j.id + ".json"), JSON.stringify(j, null, 2)); }
function strip(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function tables(html) {
  const out = [], re = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rows = [], rr = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let r;
    while ((r = rr.exec(m[1]))) {
      const cells = [], cr = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi; let c;
      while ((c = cr.exec(r[1]))) cells.push(strip(c[1]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out;
}
function normPeriod(v) {
  let s = String(v || "");
  let m = s.match(/(20\d{2})\s*[年\/-]\s*(\d{1,2})/);
  if (m) return m[1] + "-" + String(m[2]).padStart(2, "0");
  m = s.match(/(20\d{2})(\d{2})/); if (m) return m[1] + "-" + m[2];
  return s.slice(0, 7);
}
function num(v) { const n = Number(String(v || "").replace(/[,%\s]/g, "")); return Number.isFinite(n) ? n : null; }
function getPath(obj, p) { return String(p || "").split(".").filter(Boolean).reduce((a, k) => a == null ? undefined : a[k], obj); }
function extractJson(j, r) {
  const arr = getPath(j, r.dataPath || "data");
  if (!Array.isArray(arr)) throw new Error("dataPath is not array");
  const pf = r.periodField || "period", vf = r.valueField || "value";
  return arr.map(x => ({ period: normPeriod(x[pf]), value: num(x[vf]), unit: r.unit || "" }))
    .filter(x => /^\d{4}-\d{2}$/.test(x.period) && x.value !== null);
}
function extractHtml(html, r) {
  const ts = tables(html);
  const t = ts[Number(r.tableIndex || 0)];
  if (!t) throw new Error("table not found");
  const hi = t.findIndex(row => row.some(c => String(c).indexOf(r.periodColumn || "") >= 0));
  const header = hi >= 0 ? t[hi] : t[0];
  const start = hi >= 0 ? hi + 1 : 1;
  const pi = header.findIndex(c => String(c).indexOf(r.periodColumn || "") >= 0);
  const vi = header.findIndex(c => String(c).indexOf(r.valueColumn || "") >= 0);
  const pIdx = pi >= 0 ? pi : Number(r.periodIndex || 0), vIdx = vi >= 0 ? vi : Number(r.valueIndex || 1);
  const out = [];
  for (const row of t.slice(start)) {
    const p = normPeriod(row[pIdx]), v = num(row[vIdx]);
    if (/^\d{4}-\d{2}$/.test(p) && v !== null) out.push({ period: p, value: v, unit: r.unit || "" });
  }
  return out;
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 AlphaDeskConnector" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}
async function run(r) {
  const body = await fetchText(r.url);
  if (r.type === "json") return extractJson(JSON.parse(body), r);
  return extractHtml(body, r);
}
(async () => {
  if (flag("list")) {
    const list = fs.readdirSync(DIR).filter(f => /\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));
    console.log(JSON.stringify({ ok: true, recipes: list }, null, 2)); return;
  }
  if (flag("draft")) {
    const id = arg("id", ""), url = arg("url", "");
    if (!id || !url) { console.error("--id --url required"); process.exit(2); }
    const j = { id, source: arg("source", ""), type: arg("type", "html-table"), url,
      tableIndex: Number(arg("table-index", "0")), periodColumn: arg("period-col", ""), valueColumn: arg("value-col", ""),
      periodIndex: Number(arg("period-index", "0")), valueIndex: Number(arg("value-index", "1")),
      unit: arg("unit", ""), status: "draft", createdAt: new Date().toISOString() };
    write(j); console.log(JSON.stringify({ ok: true, recipe: j }, null, 2)); return;
  }
  if (flag("approve")) {
    const j = read(arg("id", "")); j.status = "active"; j.approvedAt = new Date().toISOString(); write(j);
    console.log(JSON.stringify({ ok: true, id: j.id, status: "active" })); return;
  }
  if (flag("run") || flag("validate")) {
    const r = read(arg("id", ""));
    const records = await run(r);
    const out = arg("out", "");
    if (out) { fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true }); fs.writeFileSync(path.resolve(ROOT, out), JSON.stringify({ recipe: r.id, records }, null, 2)); }
    console.log(JSON.stringify({ ok: true, id: r.id, records: records.length, sample: records.slice(0, 3), out: out || "" }, null, 2));
    return;
  }
  console.error("use --list / --draft / --validate / --approve / --run"); process.exit(2);
})().catch(e => { console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1); });
