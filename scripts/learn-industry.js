#!/usr/bin/env node
"use strict";
/** 未知行业研究框架：生成草案 / 审核启用 / 列表。 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "config/checklists/learned");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function slug(s) { return String(s || "industry").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || ("industry-" + Date.now().toString(36)); }
function draft(industry, text, caseId, reason) {
  const base = slug(industry);
  const id = base.length > 2 ? base : "industry-" + Date.now().toString(36);
  return {
    id, label: String(industry || "未命名行业"), status: "draft",
    keywords: [String(industry || ""), String(industry || "").replace(/行业$/, "")],
    required: [
      { id: "scope_definition", name: "行业定义与范围", purpose: "产品、上下游、统计口径" },
      { id: "market_size_growth", name: "市场规模与增速", purpose: "总量、增长、细分结构" },
      { id: "demand_structure", name: "需求结构", purpose: "下游、驱动因素、弹性" },
      { id: "supply_capacity", name: "供给与产能", purpose: "参与者、产能、进入壁垒" },
      { id: "competition_share", name: "竞争格局", purpose: "份额、集中度、玩家" },
      { id: "policy_regulation", name: "政策与监管", purpose: "准入、内容/数据/出口监管" },
      { id: "risks_counter", name: "风险与反证", purpose: "需求、技术、政策、竞争" },
      { id: "data_quality", name: "数据与口径", purpose: "来源、频率、单位、样本" }
    ],
    optional: [
      { id: "cost_curve", name: "成本结构", purpose: "成本曲线与降本路径" },
      { id: "technology_substitution", name: "技术与替代", purpose: "技术路线与替代品" },
      { id: "global_trade", name: "全球与出海", purpose: "海外供给/需求/竞争" },
      { id: "company_benchmark", name: "公司筛选", purpose: "相关标的、业务纯度、弹性" },
      { id: "downstream_scenarios", name: "下游情景", purpose: "不同增速下的供需" },
      { id: "esg", name: "ESG", purpose: "合规、能耗、治理" }
    ],
    reportSections: [
      { id: "industry_scope", title: "行业定义与空间", modules: ["scope_definition", "market_size_growth", "demand_structure"], impact: "important" },
      { id: "supply_competition", title: "供给与竞争", modules: ["supply_capacity", "competition_share", "cost_curve", "technology_substitution"], impact: "critical" },
      { id: "policy_risk", title: "政策、全球与风险", modules: ["policy_regulation", "global_trade", "risks_counter", "downstream_scenarios", "esg"], impact: "important" },
      { id: "company_screen", title: "相关公司筛选", modules: ["company_benchmark"], impact: "important" }
    ],
    provenance: { case: caseId || "", reason: reason || "unknown industry draft", createdAt: new Date().toISOString(), source: "industry-learn" }
  };
}
if (flag("list")) {
  const list = fs.readdirSync(DIR).filter(f => /\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));
  console.log(JSON.stringify({ ok: true, packs: list }, null, 2));
  process.exit(0);
}
if (flag("approve")) {
  const id = arg("id", "");
  const p = path.join(DIR, id + ".json");
  if (!fs.existsSync(p)) { console.error("draft not found"); process.exit(2); }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.status = "active"; j.approvedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
  console.log(JSON.stringify({ ok: true, id, status: "active" }));
  process.exit(0);
}
if (flag("draft")) {
  const industry = arg("industry", "");
  if (!industry) { console.error("--industry required"); process.exit(2); }
  const j = draft(industry, arg("text", ""), arg("case", ""), arg("reason", ""));
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, j.id + ".json"), JSON.stringify(j, null, 2));
  console.log(JSON.stringify({ ok: true, draft: j }, null, 2));
  process.exit(0);
}
console.error("use --draft / --approve / --list");
process.exit(2);
