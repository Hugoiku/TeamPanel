#!/usr/bin/env node
"use strict";
/**
 * figure-catalog — 通用图表目录：发现 case 内已有图，补标题/归属章节，供报告装配兜底。
 * 只接受 vault/<case>/figures 下的文件；不跨 case，不伪造图。
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const EXT = /\.(svg|png|jpe?g|webp)$/i;
const TITLE_MAP = [
  [/nim/i, "NIM 趋势"], [/npl/i, "不良率趋势"], [/roe/i, "ROE 趋势"],
  [/pb/i, "PB 估值"], [/pe/i, "PE 估值"], [/dividend|yield/i, "股息率"],
  [/credit|spread/i, "信用利差"], [/rate|corridor/i, "利率环境"],
  [/capital|rwa/i, "资本与 RWA"], [/coverage|provision/i, "拨备覆盖率"],
  [/revenue|mix/i, "收入结构"], [/peer|compare/i, "同业对比"],
  [/scenario/i, "三情景"], [/valuation/i, "估值"], [/price/i, "价格"],
  [/mau|user/i, "用户规模"], [/market/i, "市场规模"], [/production/i, "产量"],
  [/margin/i, "利润率"], [/cash/i, "现金流"], [/debt/i, "债务"]
];
function titleFor(file) {
  const base = String(file || "").replace(/\.[^.]+$/, "").replace(/^(fig|macro|industry|stock|cmb|company)[-_]/i, "");
  for (const [re, title] of TITLE_MAP) if (re.test(base)) return title;
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
function placementFor(file) {
  const f = String(file || "").toLowerCase();
  if (/^macro[-_]|macro[-_]/i.test(f)) return "macro";
  if (/industry|peers?/i.test(f)) return "industry";
  if (/^stock[-_]|^cmb[-_]|^company[-_]/i.test(f)) return "company";
  return "figures";
}
function metadata(caseId) {
  const base = path.join(ROOT, "vault", caseId, "research");
  const out = {};
  for (const name of ["exhibits.json", "ai-figures.json", "figure-plan.json", "figure-metadata.json"]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(base, name), "utf8"));
      (j.items || []).forEach(x => {
        const rel = x.path || x.rel;
        if (!rel) return;
        out[rel] = { title: x.title || "", sources: x.sources || x.evidence || [], placement: x.placement || "" };
      });
    } catch (e) {}
  }
  return out;
}
function list(caseId) {
  const base = path.join(ROOT, "vault", caseId, "figures");
  const meta = metadata(caseId);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(base).filter(n => EXT.test(n)).sort(); } catch (e) { return out; }
  const rootReal = path.resolve(ROOT, "vault", caseId);
  for (const name of names) {
    const abs = path.join(base, name);
    let real = "";
    try { real = fs.realpathSync(abs); } catch (e) { continue; }
    if (!real.startsWith(rootReal + path.sep)) continue; // 防 symlink 跨 case
    const rel = "figures/" + name;
    const m = meta[rel] || {};
    const rawTitle = String(m.title || "").trim();
    const title = (rawTitle && !/^[a-z0-9 _-]+$/i.test(rawTitle)) ? rawTitle : titleFor(name);
    out.push({ path: rel, title, placement: placementFor(name),
      sources: Array.isArray(m.sources) ? m.sources : [], bytes: fs.statSync(abs).size });
  }
  return out;
}
function supplement(caseId, existing, target) {
  const used = new Set((existing || []).map(x => x.path));
  const all = list(caseId).filter(x => !used.has(x.path));
  return all.slice(0, Math.max(0, Number(target || 0) - (existing || []).length));
}
module.exports = { list, supplement, titleFor, placementFor };
if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; };
  console.log(JSON.stringify({ ok: true, figures: list(arg("case", "")) }, null, 2));
}
