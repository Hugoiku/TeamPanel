"use strict";
/** Model-generated research questions/hypotheses for the shared case brief (async, non-blocking). */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
let brief = null; try { brief = JSON.parse(fs.readFileSync(path.join(base, "case-brief.json"), "utf8")); } catch (e) {}
if (!brief) { console.log(JSON.stringify({ ok: false, error: "case-brief.json missing" })); process.exit(2); }
let mission = ""; try { mission = fs.readFileSync(path.join(ROOT, "vault", CASE, "mission.md"), "utf8").slice(0, 2000); } catch (e) {}
const prompt = [
  "你是投研团队的 Lead。基于 case brief，提出三个角色共用的研究假设，不要写固定模板，也不要替员工下结论。",
  "只输出 JSON：{\"questions\":[\"...\"],\"hypotheses\":[{\"id\":\"H1\",\"text\":\"...\",\"falsifier\":\"...\"}],\"metrics\":[{\"name\":\"...\",\"definition\":\"...\",\"window\":\"...\"}],\"boundaries\":[\"...\"]}",
  "要求：问题必须是这次研究真正需要回答的；假设必须可证伪；指标必须说明口径/时间窗；边界必须说明哪些不做。最多 5 个假设、8 个指标。",
  "case brief：" + JSON.stringify(brief).slice(0, 6000),
  "mission：" + mission
].join(String.fromCharCode(10));
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const cfg = ((desk.models || {}).planner || {}).default || (desk.models || {}).default || { provider: "opencode-go", model: "deepseek-v4.1-flash" };
const patch = path.join(ROOT, "runtime/profiles/case-brief.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "case-brief"); fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], { cwd: ROOT, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
let text = ""; String(r.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
let out = null; try { const m = text.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; } catch (e) {}
if (!out) { fs.writeFileSync(path.join(base, "case-brief-model.json"), JSON.stringify({ ok: false, error: "model empty/invalid" }, null, 2)); console.log(JSON.stringify({ ok: false, error: "model empty/invalid" })); process.exit(3); }
const data = { ok: true, case: CASE, generatedAt: new Date().toISOString(), model: cfg.provider + "/" + cfg.model,
  questions: (out.questions || []).slice(0, 8).map(String), hypotheses: (out.hypotheses || []).slice(0, 5),
  metrics: (out.metrics || []).slice(0, 8), boundaries: (out.boundaries || []).slice(0, 8).map(String) };
fs.writeFileSync(path.join(base, "case-brief-model.json"), JSON.stringify(data, null, 2));
const nl = String.fromCharCode(10); let md = "# 模型生成的研究假设" + nl + nl;
data.questions.forEach(q => { md += "- 研究问题：" + q + nl; });
data.hypotheses.forEach(h => { md += "- 假设 " + (h.id || "") + "：" + (h.text || "") + (h.falsifier ? "；证伪：" + h.falsifier : "") + nl; });
data.metrics.forEach(m => { md += "- 指标：" + (m.name || "") + "｜" + (m.definition || "") + "｜" + (m.window || "") + nl; });
data.boundaries.forEach(b => { md += "- 边界：" + b + nl; });
fs.writeFileSync(path.join(base, "case-brief-model.md"), md);
console.log(JSON.stringify({ ok: true, hypotheses: data.hypotheses.length, metrics: data.metrics.length }));
