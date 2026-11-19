#!/usr/bin/env node
"use strict";
/** Scope resolver: 意图 → 研究模块 → 4–7 个计划步骤。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const CHECK = path.join(ROOT, "config/checklists");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function load(id) { return JSON.parse(fs.readFileSync(path.join(CHECK, id + ".json"), "utf8")); }
function merge(a, b) {
  const out = [], seen = {};
  [...(a || []), ...(b || [])].forEach(x => { if (x && x.id && !seen[x.id]) { seen[x.id] = 1; out.push(x); } });
  return out;
}
function learnedPacks() {
  const dir = path.join(CHECK, "learned");
  const out = [];
  try {
    fs.readdirSync(dir).filter(f => /\.json$/.test(f)).forEach(f => {
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (j && j.id) out.push(j); } catch (e) {}
    });
  } catch (e) {}
  return out;
}
function inferIndustryType(industry) {
  const txt = String(industry || "");
  const learned = learnedPacks().filter(j => j.status === "active" &&
    (j.keywords || []).some(w => txt.indexOf(w) >= 0));
  if (learned.length) return "learned:" + learned[0].id;
  const map = load("industry-map");
  for (const [k, words] of Object.entries(map.types || {})) {
    if ((words || []).some(w => txt.indexOf(w) >= 0)) return k;
  }
  return "general";
}
function guessIndustry(text) {
  const t = String(text || "");
  const m = t.match(/([A-Za-z0-9一-龥]{2,12})(?:行业|产业|赛道)/);
  if (m) return m[1].replace(/^(我想了解|了解|研究|分析|看看|关于|这个)/, "");
  return "";
}
function intentOf(agent, text, opts) {
  const t = String(text || "");
  const subjectType = opts.subjectType || (agent === "stock" ? "company" : (agent === "industry" ? "industry" : "macro"));
  const depth = opts.depth || (/只看|仅看|只分析|只判断/.test(t) ? "narrow" : (/深度|全面|自上而下|系统/.test(t) ? "deep" : "normal"));
  const deliverable = opts.deliverable || (/简报|快评|速览/.test(t) ? "brief" : "report");
  const industry = opts.industry || guessIndustry(t);
  return { subject: opts.subject || "", subjectType, industry, question: t,
    horizon: opts.horizon || "6~12个月", depth, deliverable };
}
function moduleList(agent, industry, type) {
  if (agent === "industry") {
    if (String(type).indexOf("learned:") === 0) {
      const id = String(type).slice(8);
      const pack = learnedPacks().find(x => x.id === id);
      if (pack) {
        const ex = new Set(pack.exclude || []);
        return { required: (pack.required || []).filter(x => !ex.has(x.id)),
          optional: (pack.optional || []).filter(x => !ex.has(x.id)),
          label: pack.label || id, learned: true, reportSections: pack.reportSections || [] };
      }
    }
    const j = load("industry");
    const pack = j.types[type] || { required: [], optional: [] };
    const ex = new Set(pack.exclude || []);
    return { required: merge(j.universal.required, pack.required).filter(x => !ex.has(x.id)),
      optional: merge(j.universal.optional, pack.optional).filter(x => !ex.has(x.id)),
      label: pack.label || type };
  }
  const j = load(agent);
  return { required: j.required || [], optional: j.optional || [], label: agent };
}
function select(agent, intent, industry, type) {
  const list = moduleList(agent, industry, type);
  const t = intent.question || "";
  const selected = [], excluded = [];
  const add = (m, required, reason) => {
    if (!m || selected.some(x => x.id === m.id)) return;
    selected.push(Object.assign({}, m, { required: !!required, reason: reason || "" }));
  };
  const required = list.required || [];
  if (intent.depth === "narrow") {
    const hints = {
      price: /价格|均价|锗价|涨价|跌价/, inventory: /库存|开工/, supply: /供给|产量|产能/,
      demand: /需求|下游/, competition: /竞争|份额|格局/, valuation: /估值|目标价|PE|PB|DCF/,
      financial: /财务|收入|利润|现金流|毛利/, policy: /政策|管制|监管/, fiscal: /财政|债务|化债/,
      content_pipeline: /内容|票房|电影|剧集|综艺|排播/, ad_cycle: /广告|变现|eCPM/,
      user_metrics: /用户|MAU|DAU|ARPU|会员/, platform_regulation: /平台|监管/,
      market_size_growth: /市场规模|票房|行业规模/, competition_share: /份额|集中度/
    };
    for (const m of [...required, ...(list.optional || [])]) {
      for (const [k, re] of Object.entries(hints)) {
        if (re.test(t) && (m.id.indexOf(k) >= 0 || m.name.indexOf(k) >= 0)) add(m, false, "窄问题命中：" + k);
      }
    }
    if (!selected.length) required.slice(0, 4).forEach(m => add(m, true, "窄问题未命中，保留最小模块"));
  } else {
    required.forEach(m => add(m, true, "通用必选"));
    if (intent.depth === "deep" || /投资价值|风险|自上而下/.test(t)) {
      (list.optional || []).forEach(m => {
        if (/global|overseas|international|export|competitor|governance|consensus|catalyst|scenario|peer/i.test(m.id)) add(m, false, "深度/投资价值相关");
      });
    }
    for (const [id, re] of Object.entries({
      global_trade: /出口|海外|全球|国际|竞争/, technology_substitution: /替代|技术/,
      fiscal: /财政|债务|化债/, valuation: /估值|目标价|投资价值/, governance: /治理|质押|减持/,
      policy: /政策|管制/, risks_counter: /风险/, scenarios_risks: /情景|风险/,
      company_benchmark: /筛选|公司|标的|受益/, peer_history: /筛选|可比|公司/
    })) {
      if (re.test(t)) {
        const hit = [...(list.optional || []), ...(list.required || [])].find(m => m.id === id || m.id.endsWith(id));
        if (hit) add(hit, false, "意图命中：" + id);
      }
    }
  }
  (list.optional || []).forEach(m => { if (!selected.some(x => x.id === m.id)) excluded.push({ id: m.id, reason: "未命中/非必要" }); });
  return { selected, excluded, label: list.label, requiredCount: required.length };
}
function groupsFor(agent) {
  if (agent === "macro") return [
    { id: "S0", name: "范围与数据预检", covers: ["data_quality"] },
    { id: "S1", name: "宏观现状", covers: ["growth", "inflation", "liquidity_credit"] },
    { id: "S2", name: "财政、外部与政策传导", covers: ["fiscal_debt", "external_fx", "policy", "demand_decomposition"] },
    { id: "S3", name: "市场验证与情景", covers: ["market_validation", "scenarios_risks", "real_estate", "inventory_cycle", "employment_income", "global_macro", "positioning", "demographics", "policy_documents", "climate_energy"] }
  ];
  if (agent === "industry") return [
    { id: "S0", name: "范围与数据预检", covers: ["scope_definition", "data_quality"] },
    { id: "S1", name: "供需、内容与用户", covers: ["market_size_growth", "supply_capacity", "demand_structure", "price_mechanism", "inventory_channel", "content_pipeline", "user_metrics", "ai_production", "platform_distribution"] },
    { id: "S2", name: "竞争、成本与变现", covers: ["competition_share", "cost_curve", "value_chain_profit", "global_trade", "capacity_capex", "technology_substitution", "cycle_position", "monetization", "content_cost", "ad_cycle", "subscription", "overseas", "ip_regulation"] },
    { id: "S3", name: "政策、需求与风险", covers: ["policy_regulation", "demand_elasticity", "downstream_scenarios", "risks_counter", "company_benchmark", "customer_concentration", "channel_mix", "esg"] }
  ];
  if (agent === "stock") return [
    { id: "S0", name: "数据与财务", covers: ["data_quality", "segment_mix", "financial_quality", "working_capital", "accounting_quality"] },
    { id: "S1", name: "商业模式与治理", covers: ["business_model", "governance"] },
    { id: "S2", name: "资本开支、催化剂与风险", covers: ["capex_projects", "liquidity", "catalysts_risks", "management", "dividend_buyback", "esg_litigation", "event_calendar"] },
    { id: "S3", name: "估值与情景", covers: ["valuation", "scenarios_target", "consensus", "peer_history"] }
  ];
  return [];
}
function reportSections(agent, selected, type) {
  if (agent === "industry" && String(type || "").indexOf("learned:") === 0) {
    const id = String(type).slice(8);
    const pack = learnedPacks().find(x => x.id === id);
    if (pack && Array.isArray(pack.reportSections) && pack.reportSections.length) {
      const ids = new Set(selected.map(x => x.id));
      return pack.reportSections.map(sec => {
        const hit = (sec.modules || []).filter(x => ids.has(x));
        return hit.length ? Object.assign({}, sec, { modules: hit, impact: sec.impact || "important" }) : null;
      }).filter(Boolean);
    }
  }
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(CHECK, "report-map.json"), "utf8")); } catch (e) {}
  const ids = new Set(selected.map(x => x.id));
  return (map[agent] || []).map(sec => {
    const hit = (sec.modules || []).filter(x => ids.has(x));
    return hit.length ? Object.assign({}, sec, { modules: hit }) : null;
  }).filter(Boolean);
}
function composePlan(agent, selected, intent) {
  if (intent && intent.depth === "narrow") {
    return [{ id: "S0", name: "研究与结论", tier: "strong", covers: selected.map(x => x.id),
      task: "只回答用户指定的窄问题；覆盖模块：" + selected.map(x => x.name).join("、") + "；用 [S#]，缺数据报 need，不扩写完整报告。",
      outputs: ["research/" + agent + ".md"], depends: [] }];
  }
  let groups = groupsFor(agent);
  if (agent === "industry" && intent && String(intent.industryType || "").indexOf("learned:") === 0) {
    groups = [
      { id: "S0", name: "范围与数据预检", covers: ["scope_definition", "data_quality"] },
      { id: "S1", name: "市场与需求", covers: ["market_size_growth", "demand_structure", "downstream_scenarios", "content_pipeline", "user_metrics", "ai_production", "platform_distribution"] },
      { id: "S2", name: "供给、竞争与变现", covers: ["supply_capacity", "competition_share", "cost_curve", "value_chain_profit", "global_trade", "technology_substitution", "cycle_position", "monetization", "content_cost", "ad_cycle", "subscription", "overseas", "ip_regulation"] },
      { id: "S3", name: "政策、风险与公司", covers: ["policy_regulation", "risks_counter", "company_benchmark", "esg"] }
    ];
  }
  const ids = new Set(selected.map(x => x.id));
  const steps = [];
  groups.forEach(g => {
    const covers = g.covers.filter(x => ids.has(x));
    if (!covers.length) return;
    const mods = selected.filter(x => covers.indexOf(x.id) >= 0);
    steps.push({ id: g.id, name: g.name, tier: "strong", covers,
      task: "覆盖模块：" + mods.map(x => x.name).join("、") + "；用 [S#] 取证，缺数据报 need，不编造。",
      outputs: ["research/" + agent + ".md §" + g.name], depends: steps.length ? [steps[steps.length - 1].id] : [] });
  });
  // 未归组模块并入最后一步，避免丢失
  const assigned = new Set(steps.flatMap(s => s.covers));
  const rest = selected.filter(x => !assigned.has(x.id));
  if (rest.length) {
    const last = steps[steps.length - 1];
    if (last) { last.covers = last.covers.concat(rest.map(x => x.id)); last.task += "；另覆盖：" + rest.map(x => x.name).join("、"); }
    else steps.push({ id: "S0", name: "研究与结论", tier: "strong", covers: rest.map(x => x.id),
      task: "覆盖模块：" + rest.map(x => x.name).join("、"), outputs: ["research/" + agent + ".md"], depends: [] });
  }
  return steps.map((s, i) => Object.assign({}, s, { depends: i ? [steps[i - 1].id] : [] }));
}
function listRequired(agent, type) {
  return moduleList(agent, "", type).required || [];
}
function listOptional(agent, type) {
  return moduleList(agent, "", type).optional || [];
}
function applyReview(out, review) {
  const add = (review && review.add) || [];
  const remove = (review && review.remove) || [];
  const available = (out.modules && out.modules.available) || [];
  let selected = (out.modules && out.modules.selected) || [];
  remove.forEach(id => { selected = selected.filter(x => x.id !== id); });
  add.forEach(id => {
    if (selected.some(x => x.id === id)) return;
    const m = available.find(x => x.id === id);
    if (m) selected.push(Object.assign({}, m, { required: false, reason: "model-review" }));
  });
  const intent = out.intent || {};
  out.modules.selected = selected;
  out.modules.excluded = available.filter(m => !selected.some(x => x.id === m.id)).map(m => ({ id: m.id, reason: "model/rule 未选" }));
  out.steps = composePlan(out.agent, selected, intent);
  out.reportSections = reportSections(out.agent, selected, out.intent && out.intent.industryType);
  return out;
}
function screenPlan(text) {
  const t = String(text || "");
  if (!/筛选|相关公司|标的|公司清单|受益标的|哪些公司/.test(t)) return null;
  return {
    needed: true, agent: "stock", mode: "screen", deliverable: "company-list",
    reason: "用户要求从行业中筛选相关公司",
    modules: ["data_quality", "segment_mix", "business_model", "financial_quality", "valuation", "peer_history"],
    steps: [
      { id: "SC0", name: "候选公司池", tier: "fast", depends: [],
        task: "从行业链、上市公司公告、行情数据建立候选公司池；列出公司/代码/主营/与目标行业的收入占比。",
        outputs: ["research/company-screen.md"] },
      { id: "SC1", name: "业务纯度与弹性", tier: "strong", depends: ["SC0"],
        task: "按业务纯度、收入弹性、产能/订单、客户结构给候选公司分层；无法证实的标待验证。",
        outputs: ["research/company-screen.md"] },
      { id: "SC2", name: "财务与估值快筛", tier: "strong", depends: ["SC1"],
        task: "用收入增速、毛利率、现金流、PE/PB/EV 做快筛；只做筛选，不替代深度估值。",
        outputs: ["research/company-screen.md"] },
      { id: "SC3", name: "排序与输出", tier: "fast", depends: ["SC2"],
        task: "输出相关公司清单、排序、入选理由、风险与下一步尽调项；不写目标价。",
        outputs: ["research/company-screen.md", "research/company-screen.json"] }
    ]
  };
}
function resolve(opts) {
  const agent = opts.agent;
  const intent = intentOf(agent, opts.text || "", opts);
  const type = opts.type || (agent === "industry" ? inferIndustryType(intent.industry) : "");
  intent.industryType = type;
  const sel = select(agent, intent, opts.industry || "", type);
  const steps = composePlan(agent, sel.selected, intent);
  const sections = reportSections(agent, sel.selected, type);
  const screen = agent === "industry" ? screenPlan(intent.question) : null;
  return { version: 1, case: opts.case || "", agent, intent: Object.assign({}, intent, { industryType: type }),
    modules: { selected: sel.selected, excluded: sel.excluded, available: merge(listRequired(agent, type), listOptional(agent, type)), label: sel.label },
    reportSections: sections, steps, screen,
    industryUnknown: agent === "industry" && type === "general",
    generatedAt: new Date().toISOString() };
}
function outlineMarkdown(out) {
  const lines = [];
  lines.push("# 研究报告大纲");
  lines.push("");
  lines.push("- case：" + (out.case || ""));
  lines.push("- 角色：" + out.agent);
  lines.push("- 意图：" + (out.intent && out.intent.question || ""));
  lines.push("- 深度：" + (out.intent && out.intent.depth || ""));
  lines.push("");
  lines.push("## 报告章节");
  lines.push("");
  (out.reportSections || []).forEach((sec, i) => {
    lines.push("### " + (i + 1) + ". " + sec.title);
    lines.push("");
    lines.push("覆盖模块：" + (sec.modules || []).join("、"));
    lines.push("");
  });
  lines.push("## 写作约束");
  lines.push("");
  lines.push("- 仅写有证据支持的判断；缺数据报 need，正文不列缺失清单；");
  lines.push("- 正式报告不出现在正文中的“待补/缺失/未取得”；");
  lines.push("- 关键结论必须有 [S#] 或明确标注为判断。");
  return lines.join(String.fromCharCode(10));
}
function writeScope(out) {
  const dir = path.join(ROOT, "runtime/scope"); fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, (out.case || "case") + "-" + out.agent + ".json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  const outline = path.join(dir, (out.case || "case") + "-" + out.agent + "-outline.md");
  fs.writeFileSync(outline, outlineMarkdown(out));
  return p;
}
module.exports = { resolve, writeScope, outlineMarkdown, applyReview };
if (require.main === module) {
  const out = resolve({
    case: arg("case", ""), agent: arg("agent", "macro"), text: arg("text", ""),
    subject: arg("subject", ""), subjectType: arg("subject-type", ""), industry: arg("industry", ""),
    type: arg("type", ""), depth: arg("depth", ""), deliverable: arg("deliverable", ""), horizon: arg("horizon", "")
  });
  const p = flag("write") ? writeScope(out) : "";
  if (flag("markdown")) {
    console.log("# Scope · " + out.agent);
    console.log("");
    console.log("意图：" + JSON.stringify(out.intent));
    console.log("");
    console.log("已选模块：" + out.modules.selected.map(x => x.id).join(", "));
    console.log("");
    console.log("计划：" + out.steps.map(s => s.id + ":" + s.name).join(" | "));
    if (out.reportSections && out.reportSections.length) {
      console.log("");
      console.log("报告章节：" + out.reportSections.map(x => x.title).join(" / "));
    }
  } else console.log(JSON.stringify(Object.assign({ scopeFile: p }, out), null, 2));
}
