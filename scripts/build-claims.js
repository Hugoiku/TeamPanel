"use strict";
/** Build investor claims from role briefs/research JSON. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(base, p), "utf8")); } catch (e) { return d; } };
const briefs = { macro: read("brief-macro.json", {}), industry: read("brief-industry.json", {}), stock: read("brief-stock.json", {}) };
const jsons = { macro: read("macro.json", {}), industry: read("industry.json", {}), stock: read("stock.json", {}) };
// 估值唯一来源：分析师确认的 investment-model.json 优先于 stock.json 的历史 DCF。
let financials = null; try { financials = JSON.parse(fs.readFileSync(path.join(base, "financials.json"), "utf8")); } catch (e) {}
let investmentModel = null;
try { investmentModel = JSON.parse(fs.readFileSync(path.join(base, "investment-model.json"), "utf8")); } catch (e) {}
try {
  const vm = JSON.parse(fs.readFileSync(path.join(base, "valuation.json"), "utf8"));
  if (jsons.stock.valuation && vm) { jsons.stock.valuation.method = vm.method || "dcf"; jsons.stock.valuation.methodResult = vm.result || null; jsons.stock.valuation.methodResults = vm.results || null; jsons.stock.valuation.inputMeta = vm.inputMeta || null; jsons.stock.valuation.inputWarnings = vm.inputWarnings || null; }
} catch (e) {}
if (investmentModel && investmentModel.computed && jsons.stock.valuation) {
  const v = jsons.stock.valuation;
  v.dcf = Object.assign({}, v.dcf || {}, {
    ev_yi: investmentModel.computed.ev,
    equity_yi: investmentModel.computed.equity,
    per_share: investmentModel.computed.perShare,
    modelSource: "investment-model.json",
    assumptions: { revenue2026e: investmentModel.revenue2026e, growth: investmentModel.growth,
      fcfMargins: investmentModel.fcfMargins, terminalMargin: investmentModel.terminalMargin,
      wacc: investmentModel.wacc, g: investmentModel.g, netCash: investmentModel.netCash, shares: investmentModel.shares }
  });
}
const clean = s => String(s || "").replace(/本轮修订[\s\S]*?(?=\n|$)/g, "").replace(/\b(v\d+|R1|本版|本稿假设|门控|token)\b/g, "").trim();
const claims = a => (briefs[a].keyClaims || []).slice(0, 5).map((c, i) => ({ id: a[0].toUpperCase() + (i + 1), text: clean(c.text), source: c.source || "", confidence: c.confidence || 0.7,
  kind: /本稿假设|WACC|DCF/.test(String(c.text || "")) ? "assumption" : (/2026E|2027E|预计|预测|测算/.test(String(c.text || "")) ? "forecast" : "fact") }));
const iv = jsons.industry.industryView || jsons.industry.industry_view || {};
const out = {
  case: CASE, generatedAt: new Date().toISOString(),
  thesis: clean(jsons.stock.sector_view || briefs.stock.stance || briefs.industry.stance || ""),
  macro: { stance: clean(briefs.macro.stance || jsons.macro.stance), claims: claims("macro"), risks: clean(jsons.macro.key_risk || "") },
  industry: (() => {
    const fbClaims = (iv.keyVariables || []).slice(0, 5).map((x, i) => ({
      id: "I" + (i + 1), text: clean([x.name, x.value, x.direction].filter(Boolean).join("：")),
      source: (x.evidence || []).join(","), confidence: x.confidence || 0.7, kind: "fact"
    }));
    const baseClaims = claims("industry");
    return {
      stance: clean(briefs.industry.stance || jsons.industry.direction || iv.direction || jsons.industry.summary),
      claims: baseClaims.length ? baseClaims : (fbClaims.length ? fbClaims : [clean(jsons.industry.summary)].filter(Boolean).map((t, i) => ({ id: "I" + (i + 1), text: t, source: [...new Set((String(t).match(/S\d+/g) || []))].join(";"), confidence: 0.7, kind: "fact" }))),
      variables: (jsons.industry.keyVariables || iv.keyVariables || []).slice(0, 5).map(x => ({ name: clean(x.name), why: clean(x.why || x.direction), monitor: clean(x.monitor || x.name), evidence: x.evidence || [] })),
      watchItems: (jsons.industry.keyVariables || iv.keyVariables || []).slice(0, 4).map(x => clean(x.monitor || x.name)),
      risks: (jsons.industry.risks || iv.inferences || []).slice(0, 5).map(x => typeof x === "string" ? clean(x) : clean(x.name + "：" + x.detail) + ((x.evidence || []).length ? " [" + x.evidence.join("][") + "]" : "")),
    gaps: (briefs.industry.dataGaps || []).slice(0, 3).map(clean),
      forecastBasis: (() => { const ms = jsons.industry.market_size || {}; return { marketSize: Number(ms.total_2026e_yi) || null,
        aiSize: Number(ms.ai_drama_2026e_yi) || null, evidence: ms.evidence || [],
        note: "2026E 市场规模为机构预测，不是本报告模型预测；宽窄口径不可相加" }; })()
    };
  })(),
  stock: { stance: clean(briefs.stock.stance || jsons.stock.sector_view), claims: claims("stock"), rating: jsons.stock.rating || briefs.stock.stance || "", target: jsons.stock.target_range || null,
    ratingTriggers: (jsons.stock.catalysts || []).length ? [] : (() => {
      const ss = (jsons.stock.valuation || {}).scenario_sensitivity || {};
      const out = [];
      const up = ss.scenario_1_clearance && ss.scenario_1_clearance.rating_trigger;
      const down = ss.scenario_2_status_quo && ss.scenario_2_status_quo.rating_trigger;
      if (up) out.push("上调触发：" + clean(up));
      if (down) out.push("下调触发：" + clean(down));
      return out;
    })(),
    catalysts: (jsons.stock.catalysts || []).slice(0, 5).map(clean),
    picks: (jsons.stock.picks || []).slice(0, 6).map(x => ({ name: clean(x.name), code: x.code, rating: clean(x.rating), one_liner: clean(x.one_liner) })),
    valuation: jsons.stock.valuation || null,
    financials: financials && financials.fields ? financials.fields : null,
    price: investmentModel ? investmentModel.price : null,
    dcfUpside: investmentModel && investmentModel.computed ? investmentModel.computed.upsideDcf : null,
    risks: (jsons.stock.risks || []).slice(0, 5).map(x => clean(x.name + "：" + x.detail) + ((x.evidence || []).length ? " [" + x.evidence.join("][") + "]" : "")) },
  valuation: { dcf: jsons.stock.dcf || jsons.stock.valuation || null },
  figures: []
};
try { const f = JSON.parse(fs.readFileSync(path.join(base, "figures.json"), "utf8")); out.figures = (f.items || []).filter(x => x.exists).map(x => x.path); } catch (e) {}
fs.writeFileSync(path.join(base, "claims.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: true, claims: out.macro.claims.length + out.industry.claims.length + out.stock.claims.length, figures: out.figures.length }));
