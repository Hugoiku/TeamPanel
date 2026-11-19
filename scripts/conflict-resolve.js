"use strict";
/** Model proposes resolution options for high-priority semantic conflicts. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const deskPolicy = desk.policy || {};
let sem = null; try { sem = JSON.parse(fs.readFileSync(path.join(base, "cross-review-semantic.json"), "utf8")); } catch (e) {}
let round = 1; try { round = Number(JSON.parse(fs.readFileSync(path.join(base, "semantic-rounds.json"), "utf8")).round || 1); } catch (e) {}
const maxRounds = Number((deskPolicy || {}).maxConflictRounds || 2);
const force = process.argv.indexOf("--force") >= 0;
const blocked = !force && round >= maxRounds;
const highs = ((sem && sem.issues) || []).filter(x => x.severity === "high").slice(0, 8).map((x, i) => ({
  id: "C" + (i + 1), type: x.type || "semantic", from: x.from || "", to: x.to || "",
  message: String(x.message || "").slice(0, 500), suggestedAction: String(x.suggestedAction || "").slice(0, 300)
}));
if (!highs.length) { fs.writeFileSync(path.join(base, "conflicts.json"), JSON.stringify({ ok: true, case: CASE, issues: [], generatedAt: new Date().toISOString() }, null, 2)); console.log(JSON.stringify({ ok: true, issues: 0 })); process.exit(0); }
const compact = {};
for (const a of ["macro", "industry", "stock"]) {
  try { const j = JSON.parse(fs.readFileSync(path.join(base, a + ".json"), "utf8"));
    compact[a] = { stance: j.stance || j.direction || "", rating: j.rating || "", target: j.target_range || null,
      summary: String(j.summary || j.sector_view || "").slice(0, 500) }; } catch (e) {}
}
const prompt = [
  "你是投研冲突解决器。针对每个 high 级语义冲突，提出 2-3 个可执行修正方案，不要只给一个固定答案。",
  "只输出 JSON：{\"issues\":[{\"id\":\"C1\",\"diagnosis\":\"一句话\",\"options\":[{\"id\":\"A\",\"label\":\"短标签\",\"description\":\"改什么/为什么\",\"agent\":\"stock|industry|macro|lead\",\"task\":\"发给该员工的修订任务，要求只改相关章节、保留[S#]、不编造\",\"acceptance\":\"如何验证修好了\"}]}]}",
  "规则：方案可以是改结论、改口径、补数据、拆分口径、保留结论但加条件；不能新增无来源数字；不要越界改别的角色；每个 issue 至少 2 个方案。label 不超过 18 个汉字，description 不超过 50 字，task 才写详细要求。dataPolicy 必须标注：existing=只用已有[S#]数据；assumption=允许区间/情景并标缺口；need=现有证据不足，必须先补数据再修订。",
  "每个 option 必须额外给 resolves（该方案解决的 issue type）和 acceptanceRule（一句话可检查的验收规则）；没有这两项视为无效。",
  "冲突：" + JSON.stringify(highs),
  "各角色摘要：" + JSON.stringify(compact)
].join(String.fromCharCode(10));
const semCfg = (desk.models || {}).semantic || ((desk.models || {}).planner || {}).default || (desk.models || {}).default || {};
const cfg = { provider: process.env.SEMANTIC_PROVIDER || semCfg.provider || "opencode-go",
  model: process.env.SEMANTIC_MODEL || semCfg.model || "deepseek-v4.1-flash" };
const patch = path.join(ROOT, "runtime/profiles/conflict-resolve.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "conflict-resolve"); fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], { cwd: ROOT, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
let text = ""; String(r.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
let out = null; try { const m = text.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; } catch (e) {}
if (!out || !Array.isArray(out.issues)) { fs.writeFileSync(path.join(base, "conflicts.json"), JSON.stringify({ ok: false, case: CASE, error: "model returned invalid/empty", issues: [] }, null, 2)); console.log(JSON.stringify({ ok: false, error: "invalid model output" })); process.exit(3); }
if (blocked) {
  const b = { ok: true, case: CASE, blocked: true, round, maxRounds,
    reason: "已达到最大冲突修订轮次，需人工定向修订或显式豁免；可 --force 强制生成下一轮",
    issues: [], generatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(base, "conflicts.json"), JSON.stringify(b, null, 2));
  console.log(JSON.stringify({ ok: true, blocked: true, round, maxRounds }));
  process.exit(0);
}
const issues = out.issues.slice(0, 8).map((x, i) => ({ id: "C" + (i + 1), type: highs[i] && highs[i].type || x.type || "semantic", from: x.from || (highs[i] && highs[i].from) || "", message: String(x.diagnosis || (highs[i] && highs[i].message) || "").slice(0, 500),
  options: (x.options || []).filter(o => o && o.label && o.agent).slice(0, 3).map((o, j) => ({ id: String(o.id || String.fromCharCode(65 + j)), label: String(o.label).slice(0, 60), description: String(o.description || "").slice(0, 400), agent: String(o.agent), task: String(o.task || "").slice(0, 1200), acceptance: String(o.acceptance || "").slice(0, 400),
    resolves: String(o.resolves || "").slice(0, 80), acceptanceRule: String(o.acceptanceRule || "").slice(0, 300),
    dataPolicy: ["existing","assumption","need"].indexOf(o.dataPolicy) >= 0 ? o.dataPolicy : "existing" })) }));
fs.writeFileSync(path.join(base, "conflicts.json"), JSON.stringify({ ok: true, case: CASE, round, maxRounds, blocked: false, issues, generatedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ ok: true, issues: issues.length, options: issues.reduce((n, x) => n + x.options.length, 0) }));
