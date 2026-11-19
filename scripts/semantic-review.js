"use strict";
/** Semantic cross-review split by role pair, to avoid one large prompt returning no final. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) { console.error("--case required"); process.exit(2); }
const base = path.join(ROOT, "vault", CASE, "research");
const briefs = {};
for (const a of ["macro", "industry", "stock"]) { try { briefs[a] = JSON.parse(fs.readFileSync(path.join(base, "brief-" + a + ".json"), "utf8")); } catch (e) {} }
if (!Object.keys(briefs).length) { console.log(JSON.stringify({ ok: false, error: "no briefs" })); process.exit(0); }
function compact(a, b) {
  const pick = (x) => {
    const y = x || {};
    return { stance: String(y.stance || "").slice(0, 180), rating: y.rating || "", target: y.target_range || null,
      claims: (y.keyClaims || []).slice(0, 3).map(c => String(c.text || "").slice(0, 150)),
      assumptions: (y.keyAssumptions || []).slice(0, 3).map(x => String(x).slice(0, 150)),
      gaps: (y.dataGaps || []).slice(0, 2).map(x => String(x).slice(0, 150)) };
  };
  return { [a]: pick(briefs[a]), [b]: pick(briefs[b]) };
}
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const semCfg = (desk.models || {}).semantic || ((desk.models || {}).planner || {}).default || (desk.models || {}).default || {};
const cfg = { provider: process.env.SEMANTIC_PROVIDER || semCfg.provider || "opencode-go",
  model: process.env.SEMANTIC_MODEL || semCfg.model || "deepseek-v4.1-flash" };
const patch = path.join(ROOT, "runtime/profiles/semantic-review.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "semantic-review"); fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
function call(prompt) {
  const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], {
    cwd: ROOT, encoding: "utf8", timeout: 70000, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
  let text = "";
  String(r.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
  return { text, status: r.status, stderr: String(r.stderr || "").slice(0, 300), stdoutTail: String(r.stdout || "").slice(-500) };
}
let applied = [];
try {
  const cf = JSON.parse(fs.readFileSync(path.join(base, "conflicts.json"), "utf8"));
  (cf.issues || []).filter(i => i.applied).forEach(i => {
    const opt = (i.options || []).find(o => o.id === i.applied.optionId) || {};
    applied.push({ issue: i.id, type: i.type, option: opt.label || "", resolves: opt.resolves || i.type,
      acceptanceRule: opt.acceptanceRule || "", dataPolicy: opt.dataPolicy || "" });
  });
} catch (e) {}
let round = 1;
try { round = Number(JSON.parse(fs.readFileSync(path.join(base, "semantic-rounds.json"), "utf8")).round || 1); } catch (e) {}
const pairs = [["macro", "industry"], ["industry", "stock"], ["macro", "stock"]];
const issues = [], failures = [];
for (const [a, b] of pairs) {
  const prompt = [
    "你是投研质量审计。只比较下面两个 role 的 brief，找出会导致报告互相矛盾或越界的问题。",
    "只输出 JSON：{\"issues\":[{\"type\":\"assumption_conflict|numeric_conflict|scope_leak|missing_dependency|unsupported_claim\",\"from\":\"" + a + "\",\"to\":\"" + b + "\",\"severity\":\"high|medium\",\"message\":\"一句话\",\"suggestedAction\":\"一句话\"}]}",
    "不要解释，不要输出 thinking；没有问题时输出 {\"issues\":[]}；最多 4 条；只依据给出的两份 brief。",
    "pair：" + a + " vs " + b,
    JSON.stringify(compact(a, b)),
    (applied.length ? "已应用的冲突方案（这些边界已被用户接受；如果文本确实满足验收规则，不要重复报同一 high；只有仍未落实才报）：" + JSON.stringify(applied) : "")
  ].join(String.fromCharCode(10));
  const r = call(prompt);
  if (!String(r.text || "").trim()) { failures.push({ pair: a + "/" + b, status: r.status, stderr: r.stderr, stdoutTail: r.stdoutTail }); continue; }
  let j = null; try { const m = r.text.match(/\{[\s\S]*\}/); j = m ? JSON.parse(m[0]) : null; } catch (e) {}
  if (!j || !Array.isArray(j.issues)) { failures.push({ pair: a + "/" + b, error: "invalid json", text: r.text.slice(0, 300) }); continue; }
  j.issues.slice(0, 4).forEach(x => issues.push({ type: String(x.type || "semantic"), from: String(x.from || a), to: String(x.to || b),
    severity: x.severity === "high" ? "high" : "medium", message: String(x.message || "").slice(0, 300),
    suggestedAction: String(x.suggestedAction || "").slice(0, 300), semantic: true, pair: a + "/" + b }));
}
const high = issues.filter(x => x.severity === "high").length;
const ok = failures.length === 0;
const out = { version: 1, case: CASE, model: cfg.provider + "/" + cfg.model, ok, partial: !ok && issues.length > 0,
  issues, high, failures, round, applied, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(base, "cross-review-semantic.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(base, "semantic-rounds.json"), JSON.stringify({ case: CASE, round: round + 1, high, at: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ ok, issues: issues.length, high, failures: failures.length }));
process.exit(ok ? 0 : 3);
