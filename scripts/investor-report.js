"use strict";
/** Compile an investor-facing report according to a report profile. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
const PROFILE_ARG = process.argv[process.argv.indexOf("--profile") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
let sectorPack = null; try { sectorPack = JSON.parse(fs.readFileSync(path.join(base, "sector-pack.json"), "utf8")); } catch (e) {}
const claims = JSON.parse(fs.readFileSync(path.join(base, "claims.json"), "utf8"));
let catalystData = { items: [] };
try { catalystData = JSON.parse(fs.readFileSync(path.join(base, "catalysts.json"), "utf8")); } catch (e) {}
try { const ex = JSON.parse(fs.readFileSync(path.join(base, "exhibits.json"), "utf8")); claims.figures = [...new Set([...(claims.figures||[]), ...(ex.items||[]).map(x=>x.path)])]; } catch (e) {}
let aiFigures = [];
try { aiFigures = (JSON.parse(fs.readFileSync(path.join(base, "ai-figures.json"), "utf8")).items || []); } catch (e) {}
const figureTitles = {}, figureSources = {};
try { const ex = JSON.parse(fs.readFileSync(path.join(base, "exhibits.json"), "utf8")); (ex.items || []).forEach(x => { if (x.path) { figureTitles[x.path] = x.title || ""; figureSources[x.path] = x.sources || []; } }); } catch (e) {}
try {
  const lines = fs.readFileSync(path.join(ROOT, "vault", CASE, "reports", "master.md"), "utf8").split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/!\[([^\]]*)\]\((figures\/[^)]+)\)/);
    if (!m) continue;
    figureTitles[m[2]] = m[1] || figureTitles[m[2]] || "";
    if (!(figureSources[m[2]] || []).length) {
      const ctx = lines.slice(Math.max(0, i - 2), i).join(" ");
      const refs = [...new Set((ctx.match(/S\d+/g) || []))];
      if (refs.length) figureSources[m[2]] = refs;
    }
  }
} catch (e) {}
aiFigures.forEach(x => { if (x.rel) figureTitles[x.rel] = x.title || figureTitles[x.rel] || ""; });
let figureNo = 0;
function fig(path, forcedNo) {
  figureNo = forcedNo || (figureNo + 1);
  let title = figureTitles[path] || String(path).split("/").pop().replace(/\.svg$/i, "");
  title = String(title).replace(/^图\s*\d+\s*[:：]?\s*/, "").replace(/[\[\]]/g, "");
  const src = (figureSources[path] || []).length ? (String.fromCharCode(10) + String.fromCharCode(10) + "*来源：" + figureSources[path].join(" ") + "*") : "";

  return "![" + title + "](" + path + ")" + src;
}
let profile = { type: "mixed", label: "综合报告", sections: ["summary","industry","company","macro","risks","metrics","figures","appendix"] };
try { const p = JSON.parse(fs.readFileSync(path.join(base, "report-profile.json"), "utf8")); if (p && Array.isArray(p.sections)) profile = p; } catch (e) {}
if (profile.type === "auto") { try { const st = JSON.parse(fs.readFileSync(path.join(base, "report-structure.json"), "utf8")); if (st && Array.isArray(st.order) && st.order.length) profile = Object.assign({}, profile, { sections: st.order }); } catch (e) {} }
if (PROFILE_ARG) { try { profile = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "report-profiles", PROFILE_ARG + ".json"), "utf8")); } catch (e) {} }
const clean = s => String(s || "").replace(/本轮修订[\s\S]*?(?=\n|$)/g, "").replace(/\b(v\d+|R1|本版|本稿假设|门控|token|manifest)\b/g, "").trim();
function fmtClaim(x, cap, showConf) {
  let t = clean(x.text || x);
  const kind = x.kind === "forecast" ? "【机构预测】" : (x.kind === "assumption" ? "【模型假设】" : "");
  const inText = t.match(/\[S\d+\]/g) || [];
  const body = t.replace(/\[S\d+\]/g, "").trim();
  const refs = inText.length ? " " + inText.join("") : (x.source ? " [" + String(x.source).split(/[;,/]/).map(s => s.trim()).filter(Boolean).join("][") + "]" : "");
  let cut = body;
  if (cap && body.length > cap) {
    const window = body.slice(0, cap + 40);
    const idx = Math.max(window.lastIndexOf("。"), window.lastIndexOf("；"));
    cut = idx > 20 ? window.slice(0, idx + 1) : body; // 不截断句子，找不到边界就保留全文
  }
  const conf = typeof x.confidence === "number" ? (x.confidence >= 0.85 ? "高" : (x.confidence >= 0.7 ? "中" : "低")) : "";
  return "- " + kind + cut + (showConf && conf ? "（置信度：" + conf + "）" : "") + refs;
}
const bullets = (arr) => (arr || []).slice(0, 4).map(x => fmtClaim(x, 0, true)).join(String.fromCharCode(10));
const judge = (x) => { const t = clean(x); return /\[S\d+/.test(t) ? t : "【判断】" + t; };
const cn = n => ["一","二","三","四","五","六","七","八","九","十"][n-1] || String(n);
let n = 0; const H = t => { n += 1; return "## " + cn(n) + "、" + t; };
const b = {};
const first = s => { const t = clean(s); const m = t.match(/^[^。]+。/); return (m ? m[0] : t).slice(0, 90); };
const valMethod = (claims.stock.valuation && claims.stock.valuation.method) || "dcf";
const valResult = claims.stock.valuation && claims.stock.valuation.methodResult;
const valOk = !valResult || valResult.status === "ok";
const targetDisplay = valOk ? ((claims.stock && claims.stock.target) || null) : null;
b.summary = [H("投资摘要"), "", "**" + clean(claims.thesis || claims.industry.stance) + "**", "",
  "| 维度 | 结论 |", "|---|---|",
  "| 行业 | " + first(claims.industry.stance).replace(/\|/g, " ") + " |",
  "| 公司 | " + first(claims.stock.stance).replace(/\|/g, " ") + (claims.stock.rating ? "；评级 " + clean(claims.stock.rating) : "") + " |",
  "| 估值 | " + (targetDisplay ? "目标区间 " + JSON.stringify(targetDisplay) : "暂不设目标价，给估值方法与触发条件") + " |", ""];
const facts = [...(claims.industry.claims || []), ...(claims.stock.claims || [])].filter(x => /[0-9]/.test(x.text || "")).slice(0, 3);
if (facts.length) { b.summary.push("### 三个关键数字", ""); facts.forEach(x => b.summary.push(fmtClaim(x))); b.summary.push(""); }
const watch = (claims.industry.watchItems || []).slice(0, 3);
if (watch.length) { b.summary.push("### 观察信号", ""); watch.forEach(x => b.summary.push("- " + clean(x).slice(0, 100))); b.summary.push(""); }
const topRisks = [claims.macro.risks, ...(claims.industry.risks || []), ...(claims.stock.risks || [])].filter(Boolean).slice(0, 3);
if (topRisks.length) { b.summary.push("### 主要风险", ""); topRisks.forEach(x => b.summary.push("- " + clean(x).slice(0, 100))); b.summary.push(""); }
b.summary.push("### 预测与假设", "");
if (claims.industry.forecastBasis && claims.industry.forecastBasis.marketSize) {
  const f = claims.industry.forecastBasis;
  b.summary.push("- 2026E 市场规模 " + f.marketSize + " 亿元为【机构预测】" + ((f.evidence || []).length ? " [" + f.evidence.join("][") + "]" : "") + "，不是本报告模型预测；宽窄口径不可相加。");
}
if (claims.stock.valuation && claims.stock.valuation.dcf) {
  b.summary.push("- DCF 的 WACC 11%、永续增长 3%、终值 FCF 利润率 15% 为【模型假设】，不是事实；结果仅作价值下限参照。");
}
b.summary.push("### 投委会速览", "");
var price = (claims.stock && claims.stock.price) || null;
var dcf0 = (claims.stock && claims.stock.valuation && claims.stock.valuation.dcf) || {};
b.summary.push("- 建议：**" + clean((claims.stock && claims.stock.rating) || "中性") + "**；时间窗：12 个月。");
if (price) b.summary.push("- 现价：" + price + " 元；DCF 下限：" + (dcf0.per_share || "—") + " 元；DCF 相对现价：" + (claims.stock.dcfUpside != null ? claims.stock.dcfUpside + "%" : "—") + "。");
b.summary.push("- 目标价：" + (targetDisplay ? JSON.stringify(targetDisplay) : "不设目标价；估值参数/主方法输入不可回溯，详见估值章节。"));
b.summary.push("", "### 什么信号改变判断", "");
const falsifiers = (claims.stock && claims.stock.falsifiers) || (claims.industry && claims.industry.falsifiers) || [];
if (falsifiers.length) falsifiers.slice(0, 4).forEach(x => b.summary.push("- " + clean(x)));
else if ((claims.industry && claims.industry.watchItems || []).length) claims.industry.watchItems.slice(0, 4).forEach(x => b.summary.push("- " + clean(x)));
else b.summary.push("- 关键变量出现方向性变化，或核心假设被证伪。");
b.summary.push("", "<!-- pagebreak -->", "<!-- toc -->", "");
b.industry = [H("行业：景气向上，利润向下"), "", "**【判断】**" + clean(claims.industry.stance), "",
  "### 关键结论", "", bullets(claims.industry.claims), "", "### 需要跟踪的缺口", ""];
(claims.industry.gaps || []).slice(0, 3).forEach(g => b.industry.push("- " + clean(g).slice(0, 240)));
b.industry.push("");
b.company = [H("公司：收入高增，利润尚未兑现"), "", "**【判断】**" + clean(claims.stock.stance), "", bullets(claims.stock.claims), ""];
if (claims.stock.rating) b.company.push("**评级：" + clean(claims.stock.rating) + "**" + (targetDisplay ? "；目标区间 " + JSON.stringify(targetDisplay) : "；不设目标价") + "。", "");
if ((claims.stock.ratingTriggers || []).length) { b.company.push("### 评级触发条件", ""); claims.stock.ratingTriggers.slice(0, 2).forEach(x => b.company.push("- " + clean(x))); b.company.push(""); }
if ((claims.stock.picks || []).length) { b.company.push("### 覆盖标的", ""); claims.stock.picks.forEach(x => b.company.push("- **" + x.name + "**（" + x.code + "）｜" + x.rating + "：" + x.one_liner)); b.company.push(""); }
if (valMethod !== "dcf") {
  b.company.push("### 估值结论：" + clean(valMethod), "");
  if (valResult && valResult.status === "ok" && valResult.perShare != null) {
    b.company.push("- 估值结果：**" + valResult.perShare + " 元/股**。");
    if (valResult.equity != null) b.company.push("- 对应权益价值：" + valResult.equity + " 亿元。");
    if (valResult.range) b.company.push("- 区间：" + valResult.range[0] + "–" + valResult.range[1] + " 元/股。");
    if (valResult.method === "comps" || valResult.method === "ev_sales") {
      b.company.push("", "| 指标 | 数值 |", "|---|---|", "| 估值指标 | " + (valResult.metric || "—") + " |", "| 倍数 | " + (valResult.multiple || "—") + "x |", "| 净现金 | " + (valResult.netCash != null ? valResult.netCash : "—") + " 亿元 |", "| 股本 | " + (valResult.shares || "—") + " 亿股 |", "");
      if (Array.isArray(valResult.peers) && valResult.peers.length) {
        b.company.push("### 可比公司", "", "| 公司 | 倍数 |", "|---|---|");
        valResult.peers.forEach(p => b.company.push("| " + clean(p.name || "—") + " | " + (p.multiple != null ? p.multiple + "x" : "—") + " |"));
        b.company.push("");
      }
    } else if (valResult.method === "nav") {
      b.company.push("", "| 项目 | 数值 |", "|---|---|", "| 资产 | " + (valResult.assets || "—") + " |", "| 负债 | " + (valResult.liabilities || "—") + " |", "| 权益 | " + (valResult.equity || "—") + " |", "");
    } else if (valResult.method === "ddm") {
      b.company.push("", "| 项目 | 数值 |", "|---|---|", "| 股息 | " + (valResult.dividend || "—") + " |", "| 要求回报率 | " + (valResult.requiredReturn || "—") + " |", "");
    } else if (valResult.method === "sotp" && Array.isArray(valResult.segments)) {
      b.company.push("", "| 分部 | 价值 |", "|---|---|");
      valResult.segments.forEach(sg => b.company.push("| " + clean(sg.name || "分部") + " | " + (sg.value != null ? sg.value : "—") + " |"));
      b.company.push("");
    }
    if (claims.stock.valuation && claims.stock.valuation.inputMeta) {
      var meta = claims.stock.valuation.inputMeta; var metaParts = [];
      const qn = { observed: "观测", derived: "派生", proxy: "代理", assumption: "假设", analyst: "人工", missing: "缺失" };
      Object.keys(meta).forEach(function (k) { if (meta[k] && meta[k].source) metaParts.push(k + "=" + meta[k].source + (meta[k].quality ? "（" + (qn[meta[k].quality] || meta[k].quality) + "）" : "")); });
      if (metaParts.length) b.company.push("- 输入来源：" + metaParts.join("；") + "。");
      if ((claims.stock.valuation.inputWarnings || []).length) b.company.push("- 输入数据警告：" + claims.stock.valuation.inputWarnings.join("；") + "。");
    }
    if ((valResult.method === "comps" || valResult.method === "ev_sales") && (claims.stock.picks || []).length) {
      b.company.push("", "### 可比公司参照", "", "| 公司 | 评级 | 说明 |", "|---|---|---|");
      claims.stock.picks.slice(0, 5).forEach(x => b.company.push("| " + clean(x.name) + " | " + clean(x.rating) + " | " + clean(x.one_liner).slice(0, 80) + " |"));
      b.company.push("");
    }
  } else {
    b.company.push("- 输入不足：" + ((valResult && valResult.missing) || []).join("、") + "；不输出目标价。");
  }
  b.company.push("", "*方法输出不是目标价；目标价仍需可回溯的完整模型与分析师确认。*", "");
} else if (claims.stock.valuation && claims.stock.valuation.dcf) {
  const d = claims.stock.valuation.dcf; if (claims.stock && claims.stock.financials && Object.keys(claims.stock.financials).length) {
  b.company.push("### 财务快照", "", "| 字段 | 数值 | 来源 |", "|---|---|---|");
  Object.keys(claims.stock.financials).forEach(k => { const x = claims.stock.financials[k]; b.company.push("| " + clean(k) + " | " + (x.value != null ? x.value + (x.unit || "") : "—") + " | " + clean(x.source || "") + " |"); });
  b.company.push("");
}
b.company.push("### 估值锚", "");
  if (claims.stock.valuation && claims.stock.valuation.method) b.company.push("- 估值方法：**" + clean(claims.stock.valuation.method) + "**" + (claims.stock.valuation.methodResult && claims.stock.valuation.methodResult.status !== "ok" ? "（缺少输入：" + ((claims.stock.valuation.methodResult.missing || []).join("、")) + "）" : "") + "。");
  b.company.push("- 【模型假设】DCF 价值下限参照：**" + d.per_share + " 元/股**（" + d.ev_yi + " 亿 EV，" + d.equity_yi + " 亿权益）。");
  if (d.implied_terminal_margin_at_price) b.company.push("- 现价隐含终值 FCF 利润率约 **" + (d.implied_terminal_margin_at_price * 100).toFixed(1) + "%**，高于基准 15%，说明估值已计入利润率修复预期。");
  b.company.push("- 以上 DCF 基于本稿假设：WACC 11%、永续增长 3%、终值 FCF 利润率 15%；属模型假设，不是事实或目标价。");
  b.company.push("- 该结果依赖本稿假设，不是目标价；不给买入/卖出区间。", "");
  const sens3 = d.terminal_margin_sensitivity || {};
  if (sens3["20pct"] || sens3["10pct"]) {
    b.company.push("### 估值三档（非目标价）", "", "| 乐观 | 基准 | 压力 |", "|---|---|---|");
    b.company.push("| " + (sens3["20pct"] || "—") + " 元 | " + (d.per_share || "—") + " 元 | " + (sens3["10pct"] || "—") + " 元 |");
    b.company.push("", "乐观/压力对应终值 FCF 利润率 20%/10%，均为模型假设；基准 15%。不是目标价。", "");
  }
  const ss = (claims.stock.valuation || {}).scenario_sensitivity || {};
  if (ss.scenario_1_clearance || ss.scenario_2_status_quo) {
    b.company.push("### 情景假设（未赋概率）", "", "| 情景 | 触发条件 | 收入方向 | DCF 参考 |", "|---|---|---|---|");
    if (ss.scenario_1_clearance) b.company.push("| 情景一：监管出清 | " + clean(ss.scenario_1_clearance.rating_trigger || "").slice(0, 60) + " | " + clean(ss.scenario_1_clearance.revenue || "").slice(0, 80) + " | " + JSON.stringify(ss.scenario_1_clearance.dcf_per_share_ref || []) + " |");
    if (ss.scenario_2_status_quo) b.company.push("| 情景二：现状延续 | " + clean(ss.scenario_2_status_quo.rating_trigger || "").slice(0, 60) + " | " + clean(ss.scenario_2_status_quo.revenue || "").slice(0, 80) + " | " + JSON.stringify(ss.scenario_2_status_quo.dcf_per_share_ref || []) + " |");
    b.company.push("", "*情景为未确认区间假设，不赋概率、不预设时点；不是目标价。*", "");
  }
}
b.macro = [H("宏观背景"), "", "**" + clean(claims.macro.stance) + "**", "", bullets((claims.macro.claims || []).slice(0, 3)), ""];
b.risks = [H("催化剂与风险"), ""];
if ((claims.stock.catalysts || []).length) { b.risks.push("### 催化剂", ""); claims.stock.catalysts.slice(0, 4).forEach(x => b.risks.push("- " + clean(x))); b.risks.push(""); }
let pastCatalysts = [];
if ((catalystData.items || []).length) {
  function catTable(title, arr) {
    if (!arr.length) return;
    b.risks.push("### " + title, "", "| 时间/窗口 | 事件 | 状态 | 核验 | 来源 |", "|---|---|---|---|---|");
    arr.slice(0, 8).forEach(x => b.risks.push("| " + clean(x.date) + " | " + clean(x.event).slice(0, 55) + " | " + clean(x.status || "判断") + " | " + (x.verified ? "已核验" : (x.basis === "derived" ? "判断" : "待核验")) + " | " + ((x.sources || []).join(" ") || "判断") + " |"));
    b.risks.push("");
  }
  const cat = catalystData.items || [];
  catTable("未来 6–12 个月：进行中 / 待发生", cat.filter(x => x.status === "进行中" || x.status === "待发生"));
  catTable("判断类：评级触发与观察指标", cat.filter(x => x.status === "判断"));
  pastCatalysts = cat.filter(x => x.status === "已发生");
}
if ((claims.industry.watchItems || []).length) { b.risks.push("### 观察信号", ""); claims.industry.watchItems.slice(0, 3).forEach(x => b.risks.push("- " + clean(x).slice(0, 120))); b.risks.push(""); }
if (claims.macro.risks || (claims.stock.risks || []).length || (claims.industry.risks || []).length) b.risks.push("### 风险", "");
if (claims.macro.risks) b.risks.push("- " + judge(claims.macro.risks));
(claims.industry.risks || []).slice(0, 3).forEach(x => b.risks.push("- " + judge(x)));
(claims.stock.risks || []).slice(0, 4).forEach(x => b.risks.push("- " + judge(x)));
b.risks.push("");
b.metrics = [H("观察指标与证伪条件"), ""];
(claims.stock && claims.stock.ratingTriggers || []).slice(0, 4).forEach(x => b.metrics.push("- " + clean(x)));
(claims.industry && claims.industry.watchItems || []).slice(0, 4).forEach(x => b.metrics.push("- " + clean(x)));
if (sectorPack && (sectorPack.reviewChecks || []).length) b.metrics.push("- 关键复核：" + clean(sectorPack.reviewChecks.join("、")));
b.metrics.push("");
const numericFigures = [];
try { const ex = JSON.parse(fs.readFileSync(path.join(base, "exhibits.json"), "utf8")); (ex.items || []).forEach(x => numericFigures.push({ path: x.path, placement: x.placement || "figures" })); } catch (e) {}
(claims.figures || []).forEach(f => { if (!numericFigures.some(x => x.path === f)) numericFigures.push({ path: f, placement: String(f).includes("macro-") ? "macro" : "figures" }); });
const unplaced = [];
numericFigures.forEach(f => {
  const target = b[f.placement] || null;
  if (target) target.push("", "{{FIG:" + f.path + "}}", "");
  else unplaced.push(f.path);
});
b.figures = unplaced.length ? [H("图表"), ""] : null;
(unplaced || []).forEach(f => b.figures.push("{{FIG:" + f + "}}", ""));
b.appendix = [H("附录：口径与证据"), "", "- 本报告不构成投资建议；数据与引用见证据池。", "- 口径、单位与数据日期以证据记录为准。", ""];
if (sectorPack && (sectorPack.reviewChecks || []).length) b.appendix.push("- 行业复核要点：" + clean(sectorPack.reviewChecks.join("、")), "");
if (pastCatalysts.length) {
  b.appendix.push("### 已发生政策背景", "", "| 时间/窗口 | 事件 | 核验 | 来源 |", "|---|---|---|---|");
  pastCatalysts.slice(0, 8).forEach(x => b.appendix.push("| " + clean(x.date) + " | " + clean(x.event).slice(0, 55) + " | " + (x.verified ? "已核验" : "待核验") + " | " + ((x.sources || []).join(" ") || "判断") + " |"));
}
// 配图位置由模型的 placement 决定；未知 placement 回落到图表章节。
aiFigures.forEach(f => {
  const target = b[f.placement] || b.figures;
  if (target) target.push("", "{{FIG:" + f.rel + "}}", "");
});
const refsByPlacement = {};
[...numericFigures.map(x => ({ path: x.path, placement: x.placement })), ...aiFigures.map(x => ({ path: x.rel, placement: x.placement }))].forEach(x => {
  if (!x.path) return;
  (refsByPlacement[x.placement || "figures"] = refsByPlacement[x.placement || "figures"] || []).push(x.path);
});
Object.keys(refsByPlacement).forEach(k => {
  if (!b[k]) return;
  const refs = [...new Set(refsByPlacement[k])];
  if (!refs.length) return;
  b[k].splice(1, 0, "（本节图表：" + refs.map(p0 => "{{FIGREF:" + p0 + "}}").join("、") + "）", "");
});
let evidenceCount = 0; try { evidenceCount = fs.readFileSync(path.join(ROOT, "vault", CASE, "evidence/sources.jsonl"), "utf8").split(String.fromCharCode(10)).filter(x => x.trim()).length; } catch (e) {}
const L = ["# " + CASE + " · 投资研究报告", "",
  "> 面向投资者｜本报告区分事实、判断、机构预测与模型假设。", "",
  "| 数据截止 | 报告生成 | 报告结构 | 行业包 | 证据 |", "|---|---|---|---|---|",
  "| 2026-11-10 | " + new Date().toISOString().slice(0, 10) + " | " + (profile.type || "mixed") + " | " + (sectorPack ? sectorPack.label : "通用") + " | " + evidenceCount + " 条 |", ""];
b.sector = [];
if (sectorPack && sectorPack.id && sectorPack.id !== "default") {
  b.sector = [H("行业研究框架"), ""];
  b.sector.push("| 维度 | 内容 |", "|---|---|");
  b.sector.push("| 行业包 | " + clean(sectorPack.label || sectorPack.id) + " |");
  if ((sectorPack.kpis || []).length) b.sector.push("| 核心 KPI | " + clean(sectorPack.kpis.join("、")) + " |");
  if ((sectorPack.valuationMethods || []).length) b.sector.push("| 建议估值方法 | " + clean(sectorPack.valuationMethods.join(" / ")) + " |");
  if ((sectorPack.reviewChecks || []).length) b.sector.push("| 关键复核 | " + clean(sectorPack.reviewChecks.join("、")) + " |");
  if ((sectorPack.reportSections || []).length) b.sector.push("| 建议章节 | " + clean(sectorPack.reportSections.join(" → ")) + " |");
  try { const iv = JSON.parse(fs.readFileSync(path.join(base, "industry-valuation.json"), "utf8")); if (iv && iv.psMedian) b.sector.push("| 行业估值 | PS 中位数 " + Number(iv.psMedian).toFixed(2) + "x，区间 " + Number(iv.psMin || 0).toFixed(1) + "–" + Number(iv.psMax || 0).toFixed(1) + "x |"); } catch (e) {}
  b.sector.push("");
  const kpiRows = (claims.industry && claims.industry.variables) || [];
  if (kpiRows.length) {
    b.sector.push("### 行业关键指标", "", "| KPI | 说明 | 跟踪 | 来源 |", "|---|---|---|---|");
    kpiRows.slice(0, 6).forEach(x => b.sector.push("| " + clean(x.name || "") + " | " + clean(x.why || "").slice(0, 80) + " | " + clean(x.monitor || "").slice(0, 80) + " | " + ((x.evidence || []).join(" ") || "待补") + " |"));
    b.sector.push("");
  }
}
(profile.sections || []).forEach(k => { if (b[k] && b[k].length) L.push(...b[k]); });
L.push("", "- consensus 一致预期：当前未接入，报告不提供市场一致预期对比。");
L.push("", "免责声明：本报告仅供研究参考，不构成投资建议。");
const figNoMap = {};
let fn = 0;
L.forEach(line => { for (const m of line.matchAll(/\{\{FIG:([^}]+)\}\}/g)) { if (!figNoMap[m[1]]) figNoMap[m[1]] = ++fn; } });
const rendered = L.map(line => line
  .replace(/\{\{FIG:([^}]+)\}\}/g, (_, p0) => fig(p0, figNoMap[p0]) || "")
  .replace(/\{\{FIGREF:([^}]+)\}\}/g, (_, p0) => figNoMap[p0] ? "见图" + figNoMap[p0] : ""));
const out = rendered.join(String.fromCharCode(10)).replace(new RegExp(String.fromCharCode(10) + "{3,}", "g"), String.fromCharCode(10) + String.fromCharCode(10)).trim() + String.fromCharCode(10);
const abs = path.join(ROOT, "vault", CASE, "reports", "investor-final.md"); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, out);
console.log(JSON.stringify({ ok: true, out: "reports/investor-final.md", profile: profile.type || "mixed", sections: (profile.sections||[]).length, chars: out.length, figures: (claims.figures || []).length }));
