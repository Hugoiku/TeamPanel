"use strict";
/** Build a structured research brief from research/<agent>.json + md headings. */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
const CASE = arg("case", ""), AGENT = arg("agent", "");
if (!CASE || !AGENT) { console.error("--case --agent required"); process.exit(2); }
const base = path.join(ROOT, "vault", CASE, "research");
const mdPath = path.join(base, AGENT + ".md"), jsonPath = path.join(base, AGENT + ".json");
let j = null, md = "";
try { j = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch (e) {}
try { md = fs.readFileSync(mdPath, "utf8"); } catch (e) {}
const headings = md.split(String.fromCharCode(10)).filter(x => /^#{1,6}\s/.test(x)).map(x => x.replace(/^#+\s*/, ""));
const claims = (j && j.claims || []).slice(0, 12).map(c => ({ id: c.id, text: c.text, source: c.source || "", confidence: c.confidence }));
function assumptionsOf(x) {
  const out = [];
  if (!x) return out;
  const ka = x.key_assumptions || x.keyAssumptions;
  if (Array.isArray(ka)) ka.forEach(a => out.push(typeof a === "string" ? a : (a.text || a.name || JSON.stringify(a))));
  else if (ka && typeof ka === "object") Object.keys(ka).forEach(k => out.push(k + ": " + JSON.stringify(ka[k])));
  const as = x.assumptions;
  if (as && typeof as === "object") Object.keys(as).forEach(k => {
    if (k === "forecast" || k === "dcf_sensitivity") return;
    out.push(k + ": " + JSON.stringify(as[k]));
  });
  return out.slice(0, 10);
}
const brief = {
  version: 1, role: AGENT, case: CASE,
  sourceVersion: (j && j.version) || 0,
  horizon: (j && j.horizon) || "",
  stance: (j && (j.stance || j.direction || j.rating)) || "",
  keyClaims: claims,
  keyAssumptions: assumptionsOf(j),
  inputsFrom: AGENT === "stock" ? ["macro", "industry"] : (AGENT === "industry" ? ["macro", "stock"] : ["industry", "stock"]),
  dataGaps: ((j && (j.gaps || j.needs)) || []).slice(0, 8),
  reportSections: headings.slice(0, 20),
  boundaries: AGENT === "stock" ? ["不含宏观/行业完整章节", "仅使用外部关键假设"] :
    (AGENT === "industry" ? ["不含个股评级/目标价", "仅使用宏观外部假设"] : ["不含个股估值", "仅给宏观含义"]),
  generatedAt: new Date().toISOString()
};
const out = path.join(base, "brief-" + AGENT + ".json");
fs.writeFileSync(out, JSON.stringify(brief, null, 2));
console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, out), brief: Object.assign({}, brief, { keyClaims: brief.keyClaims.length, keyAssumptions: brief.keyAssumptions.length }) }, null, 2));
