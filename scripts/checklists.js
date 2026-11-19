#!/usr/bin/env node
"use strict";
/** 查看员工/行业研究清单（必选/可选模块）。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "config/checklists");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function load(id) { return JSON.parse(fs.readFileSync(path.join(DIR, id + ".json"), "utf8")); }
function merge(a, b) {
  const out = [], seen = {};
  [...(a || []), ...(b || [])].forEach(x => { if (x && x.id && !seen[x.id]) { seen[x.id] = 1; out.push(x); } });
  return out;
}
function industryChecklist(industry, type) {
  const j = load("industry");
  const map = load("industry-map");
  let t = type;
  if (!t && industry) {
    for (const [k, words] of Object.entries(map.types || {})) {
      if ((words || []).some(w => String(industry).indexOf(w) >= 0)) { t = k; break; }
    }
  }
  t = t || j.defaultType || "general";
  const pack = (j.types || {})[t] || { label: t, required: [], optional: [] };
  return {
    agent: "industry", industry: industry || "", type: t, typeLabel: pack.label,
    required: merge(j.universal.required, pack.required),
    optional: merge(j.universal.optional, pack.optional)
  };
}
function checklist(agent, industry, type) {
  if (agent === "industry") return industryChecklist(industry, type);
  return load(agent);
}
function markdown(c) {
  const lines = [];
  lines.push("### " + (c.agent === "industry"
    ? ("行业研究" + (c.industry ? " · " + c.industry : "") + " · 类型：" + (c.typeLabel || c.type))
    : c.agent));
  lines.push("");
  lines.push("**必选模块**");
  lines.push("");
  lines.push("| ID | 模块 | 作用 |");
  lines.push("|---|---|---|");
  (c.required || []).forEach(x => lines.push("| " + x.id + " | " + x.name + " | " + x.purpose + " |"));
  lines.push("");
  lines.push("**可选模块**");
  lines.push("");
  lines.push("| ID | 模块 | 作用 |");
  lines.push("|---|---|---|");
  (c.optional || []).forEach(x => lines.push("| " + x.id + " | " + x.name + " | " + x.purpose + " |"));
  lines.push("");
  return lines.join(String.fromCharCode(10));
}
const agent = arg("agent", "");
const industry = arg("industry", "");
const type = arg("type", "");
if (flag("all") || !agent) {
  const all = ["macro", "industry", "stock", "audit", "legal", "trader"].map(a =>
    a === "industry" && industry ? checklist(a, industry, type) : checklist(a));
  if (flag("markdown")) {
    console.log("# 研究清单");
    all.forEach(c => console.log(markdown(c)));
  } else console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}
const c = checklist(agent, industry, type);
if (flag("markdown")) console.log(markdown(c));
else console.log(JSON.stringify(c, null, 2));
