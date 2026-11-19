"use strict";
/** Model-written executive synthesis, then deterministic chapter assembly. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "");
if (!CASE) { console.error("--case required"); process.exit(2); }
const vault = path.join(ROOT, "vault", CASE);
const outRel = arg("out", "reports/final-draft.md");
const sections = {};
for (const r of ["macro", "industry", "stock"]) {
  try {
    sections[r] = fs.readFileSync(path.join(vault, "reports", "sections", r + ".md"), "utf8")
      .replace(/^\s*-\s*本轮修订.*$/gm, "")
      .replace(/受众：内部投研/g, "受众：投资者")
      .slice(0, 12000);
  } catch (e) {}
}
let brief = ""; try { brief = fs.readFileSync(path.join(vault, "research", "case-brief.md"), "utf8"); } catch (e) {}
let review = null; try { review = JSON.parse(fs.readFileSync(path.join(vault, "research", "cross-review.json"), "utf8")); } catch (e) {}
const prompt = [
  "你是投研团队的首席研究员。请基于给定材料，写一份统一的总论，不要逐篇复述。",
  "只输出 Markdown 正文，结构：## 投资结论摘要；## 核心假设与证伪条件；## 关键分歧与未决问题。",
  "硬约束：只能使用给定材料中的事实和数字；每个数字必须保留原有 [S#] 引用；不得新增数字、来源、公司或结论；不得写内部装配说明、token、日志、门禁。",
  "不同报告口径冲突时，必须明确写出分歧，不得静默二选一。",
  "篇幅 1200-2200 字；不要 JSON，不要代码块。",
  "## 共享 Case Brief", brief.slice(0, 2500),
  "## 交叉复核问题", JSON.stringify(review ? (review.issues || []).slice(0, 10) : []).slice(0, 2000),
  "## 宏观材料", sections.macro || "（缺失）",
  "## 行业材料", sections.industry || "（缺失）",
  "## 个股材料", sections.stock || "（缺失）"
].join(String.fromCharCode(10));
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const semCfg = (desk.models || {}).semantic || ((desk.models || {}).planner || {}).default || (desk.models || {}).default || {};
const cfg = { provider: process.env.SEMANTIC_PROVIDER || semCfg.provider || "opencode-go",
  model: process.env.SEMANTIC_MODEL || semCfg.model || "deepseek-v4.1-flash" };
const patch = path.join(ROOT, "runtime/profiles/final-report.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "final-report");
fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], {
  cwd: ROOT, encoding: "utf8", timeout: 45000, maxBuffer: 16 * 1024 * 1024,
  env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
let text = "";
String(r.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
if (!text || text.length < 500) {
  // 模型不可用时，用研究 JSON 的 stance/summary/claims 生成确定性总论，保证最终稿仍有统一摘要。
  const jsons = {};
  for (const a of ["macro", "industry", "stock"]) {
    try { jsons[a] = JSON.parse(fs.readFileSync(path.join(vault, "research", a + ".json"), "utf8")); } catch (e) {}
  }
  const lines = ["## 投资结论摘要", ""];
  if (jsons.macro && (jsons.macro.stance || jsons.macro.key_risk)) {
    lines.push("- 宏观：" + String(jsons.macro.stance || "").slice(0, 300) +
      (jsons.macro.key_risk ? "；关键风险：" + String(jsons.macro.key_risk).slice(0, 160) : ""));
  }
  if (jsons.industry && (jsons.industry.direction || jsons.industry.summary)) {
    lines.push("- 行业：" + String(jsons.industry.direction || jsons.industry.summary || "").slice(0, 350));
  }
  if (jsons.stock) {
    lines.push("- 个股：" + String(jsons.stock.sector_view || "").slice(0, 220) +
      (jsons.stock.rating ? "；评级 " + jsons.stock.rating : "") +
      (jsons.stock.target_range ? "；目标区间 " + JSON.stringify(jsons.stock.target_range) : ""));
  }
  lines.push("", "## 核心假设与证伪条件", "");
  (jsons.macro && jsons.macro.claims || []).slice(0, 3).forEach(c => lines.push("- " + String(c.text || "").slice(0, 260) + (c.source ? " [" + c.source + "]" : "")));
  lines.push("", "## 关键分歧与未决问题", "");
  lines.push("- 本摘要由研究 JSON 的 stance/summary/claims 生成；分歧与证伪条件以各章节和 cross-review 为准。");
  text = lines.join(String.fromCharCode(10));
  console.log(JSON.stringify({ ok: true, fallback: true, reason: "model empty/short" }));
}
const evIds = new Set();
try { for (const line of fs.readFileSync(path.join(vault, "evidence", "sources.jsonl"), "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.id) evIds.add(String(e.id)); } catch (e) {} } } catch (e) {}
const refs = [...new Set((text.match(/\[S\d+\]/g) || []).map(x => x.replace(/[\[\]]/g, "")))];
const missing = refs.filter(id => !evIds.has(id));
if (missing.length) { console.log(JSON.stringify({ ok: false, error: "synthesized summary has missing citations", missing: missing.slice(0, 10) })); process.exit(4); }
function body(md) {
  const ls = String(md || "").split(String.fromCharCode(10));
  if (ls[0] && ls[0][0] === "#") ls.shift();
  if (ls[0] && ls[0][0] === ">") ls.shift();
  return ls.filter(l => !/^\s*-\s*本轮修订/.test(l)).join(String.fromCharCode(10)).trim();
}
let reportLabel = CASE;
try { const sp = JSON.parse(fs.readFileSync(path.join(ROOT, "vault", CASE, "research/sector-pack.json"), "utf8")); if (sp && sp.label) reportLabel = sp.label; } catch (e) {}
const chapterText = ["# " + reportLabel + "研究报告", "", "> 由 macro / industry / stock 三份底稿综合生成；执行摘要由模型综合，章节保留原始 [S#]。", "", text.trim(), "",
  "## 三、宏观环境", "", body(sections.macro) || "（待补）", "",
  "## 四、行业景气与竞争", "", body(sections.industry) || "（待补）", "",
  "## 五、公司分析与估值", "", body(sections.stock) || "（待补）", ""].join(String.fromCharCode(10));
// 图表：章节可能被截断，从 master.md 补齐未包含的 figure 引用。
let figures = [];
try {
  const master = fs.readFileSync(path.join(vault, "reports", "master.md"), "utf8");
  figures = [...new Set((master.match(/!\[[^\]]*\]\(figures\/[^)]+\)/g) || []))];
} catch (e) {}
const included = new Set((chapterText.match(/!\[[^\]]*\]\(figures\/[^)]+\)/g) || []));
const missingFigs = figures.filter(f => !included.has(f));
const final = chapterText + (missingFigs.length ? String.fromCharCode(10) + "## 图表" + String.fromCharCode(10) + String.fromCharCode(10) + missingFigs.join(String.fromCharCode(10) + String.fromCharCode(10)) + String.fromCharCode(10) : "");
const abs = path.join(vault, outRel);
fs.mkdirSync(path.dirname(abs), { recursive: true });
fs.writeFileSync(abs, final + String.fromCharCode(10));
console.log(JSON.stringify({ ok: true, out: outRel, chars: final.length, citations: refs.length, model: cfg.provider + "/" + cfg.model }));
