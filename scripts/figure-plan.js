"use strict";
/** Model plans non-numeric figures for a report. Does not generate images. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const vault = path.join(ROOT, "vault", CASE);
let report = "";
for (const rel of ["reports/final-draft.md", "reports/master.md"]) { try { report = fs.readFileSync(path.join(vault, rel), "utf8"); if (report.trim()) break; } catch (e) {} }
if (!report.trim()) { console.log(JSON.stringify({ ok: false, error: "no report markdown" })); process.exit(3); }
const prompt = [
  "你是投研报告的配图规划器。只规划非数字图：概念示意、产业链、流程、封面；数字图表已由 chart.js 生成，不要重复。",
  "只输出 JSON：{\"items\":[{\"id\":\"F1\",\"title\":\"短标题\",\"kind\":\"diagram|cover|illustration\",\"prompt\":\"生图提示词\",\"reason\":\"为什么值得配图\",\"estimatedCost\":1}]}",
  "只选真正能帮助理解的信息，最多 3 张；没有必要时输出 {\"items\":[]}；不要为装饰而生图。",
  "报告：", report.slice(0, 12000)
].join(String.fromCharCode(10));
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const cfg = (desk.models || {}).semantic || ((desk.models || {}).planner || {}).default || (desk.models || {}).default || {};
const patch = path.join(ROOT, "runtime/profiles/figure-plan.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "figure-plan"); fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
function callOnce() {
  const rr = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], { cwd: ROOT, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
  let tt = ""; String(rr.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") tt = j.text; } catch (e) {} });
  let oo = null; try { const m = tt.match(/\{[\s\S]*\}/); oo = m ? JSON.parse(m[0]) : null; } catch (e) {}
  return oo;
}
let out = callOnce();
if (!out || !Array.isArray(out.items)) out = callOnce();
if (!out || !Array.isArray(out.items)) { const p = path.join(ROOT, "runtime/figure-plans"); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, CASE + ".json"), JSON.stringify({ ok: false, case: CASE, error: "model empty/invalid", items: [] }, null, 2)); console.log(JSON.stringify({ ok: false, error: "model empty/invalid" })); process.exit(4); }
const items = out.items.slice(0, 3).map((x, i) => ({ id: String(x.id || ("F" + (i + 1))), title: String(x.title || "").slice(0, 80), kind: ["diagram","cover","illustration"].indexOf(x.kind) >= 0 ? x.kind : "diagram", prompt: String(x.prompt || "").slice(0, 1200), reason: String(x.reason || "").slice(0, 300),
  placement: ["summary","industry","company","macro","risks","metrics","figures","appendix"].indexOf(x.placement) >= 0 ? x.placement : "figures", estimatedCost: 1 }));
const dir = path.join(ROOT, "runtime/figure-plans"); fs.mkdirSync(dir, { recursive: true });
const data = { ok: true, case: CASE, report: "reports/final-report.docx", items, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(dir, CASE + ".json"), JSON.stringify(data, null, 2));
console.log(JSON.stringify({ ok: true, items: items.length }));
