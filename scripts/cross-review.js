"use strict";
/** Cross-review briefs: missing briefs, scope leakage, external assumptions. */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "");
const SEMANTIC = process.argv.indexOf("--semantic") >= 0;
if (!CASE) { console.error("--case required"); process.exit(2); }
const base = path.join(ROOT, "vault", CASE, "research");
const roles = ["macro", "industry", "stock"];
const briefs = {}, headings = {}, issues = [];
for (const r of roles) {
  try { briefs[r] = JSON.parse(fs.readFileSync(path.join(base, "brief-" + r + ".json"), "utf8")); } catch (e) {}
  try { headings[r] = fs.readFileSync(path.join(base, r + ".md"), "utf8").split(String.fromCharCode(10)).filter(x => /^#{1,6}\s/.test(x)).map(x => x.replace(/^#+\s*/, "")); } catch (e) { headings[r] = []; }
}
for (const r of roles) {
  if (headings[r].length && !briefs[r]) issues.push({ type: "missing_brief", from: r, severity: "high", message: "有底稿但没有 brief" });
  if (!briefs[r]) continue;
  const deps = briefs[r].inputsFrom || [];
  deps.forEach(d => { if (!briefs[d]) issues.push({ type: "missing_dependency_brief", from: r, to: d, severity: "medium", message: "引用了 " + d + " 的输入但没有 brief" }); });
}
function hasHead(r, re) { return (headings[r] || []).some(h => re.test(h)); }
if (briefs.stock) {
  if (hasHead("stock", /^(宏观|行业)/)) issues.push({ type: "scope_leak", from: "stock", severity: "medium", message: "个股报告出现宏观/行业章节；应改为关键外部假设" });
}
if (briefs.industry) {
  if (hasHead("industry", /(目标价|评级|个股估值)/)) issues.push({ type: "scope_leak", from: "industry", severity: "medium", message: "行业报告出现目标价/评级/个股估值" });
}
if (briefs.macro) {
  if (hasHead("macro", /(个股估值|目标价|个股评级)/)) issues.push({ type: "scope_leak", from: "macro", severity: "medium", message: "宏观报告出现个股估值/评级" });
}
let semantic = null;
try {
  semantic = JSON.parse(fs.readFileSync(path.join(base, "cross-review-semantic.json"), "utf8"));
  (semantic.issues || []).forEach(x => issues.push(x));
} catch (e) {}
if (SEMANTIC && !semantic && Object.keys(briefs).length) {
  const sr = spawnSync(process.execPath, [path.join(ROOT, "scripts/semantic-review.js"), "--case", CASE],
    { cwd: ROOT, encoding: "utf8", timeout: 200000, maxBuffer: 32 * 1024 * 1024 });
  let sj = null; try { sj = JSON.parse(String(sr.stdout || "").trim()); } catch (e) {}
  if (sj && Array.isArray(sj.issues)) { semantic = sj; sj.issues.forEach(x => issues.push(x)); }
}
const out = { version: 1, case: CASE, generatedAt: new Date().toISOString(),
  briefs: Object.keys(briefs), issues, high: issues.filter(x => x.severity === "high").length,
  semantic: semantic ? { issues: semantic.issues.length, high: semantic.high } : null };
fs.writeFileSync(path.join(base, "cross-review.json"), JSON.stringify(out, null, 2));
const lines = ["# 交叉审阅", "", "- case：" + CASE, "- brief：" + (out.briefs.join(" / ") || "无"), ""];
if (!issues.length) lines.push("未发现结构性问题。");
issues.forEach(x => lines.push("- [" + x.severity + "] " + x.type + "：" + x.message + (x.from ? "（" + x.from + "）" : "")));
fs.writeFileSync(path.join(base, "cross-review.md"), lines.join(String.fromCharCode(10)));
console.log(JSON.stringify({ ok: true, issues: issues.length, high: out.high, out: path.relative(ROOT, path.join(base, "cross-review.json")) }, null, 2));
