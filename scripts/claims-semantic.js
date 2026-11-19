"use strict";
/** Model semantic check: are claims supported/overstated by cited evidence? */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE, "research");
const claims = JSON.parse(fs.readFileSync(path.join(base, "claims.json"), "utf8"));
const all = [...(claims.macro.claims || []), ...(claims.industry.claims || []), ...(claims.stock.claims || [])];
const ev = {};
try { for (const l of fs.readFileSync(path.join(ROOT, "vault", CASE, "evidence", "sources.jsonl"), "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const x = JSON.parse(l); if (x.id) { const v = x.value != null ? x.value : (x.text || x.title || ""); ev[x.id] = (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 2000); } } catch (e) {} } } catch (e) {}
let compact;
try {
  const mapped = JSON.parse(fs.readFileSync(path.join(base, "claim-evidence.json"), "utf8")).claimsEvidence || [];
  compact = mapped.slice(0, 16).map(c => ({ id: c.id, claim: c.text, source: (c.refs || []).join(";"),
    snippets: (c.snippets || []).map(s => s.source + " " + s.text).slice(0, 8) }));
} catch (e) {
  compact = all.slice(0, 16).map(c => ({ id: c.id, claim: String(c.text || "").slice(0, 300), source: c.source || "", snippets: (String(c.source || "").match(/S\d+/g) || []).map(s => ev[s] || "") }));
}
const prompt = [
  "你是投研证据审计。判断每条 claim 是否被 source 支持，或是否明显夸大、把假设写成事实。",
  "只输出 JSON：{\"issues\":[{\"claimId\":\"I1\",\"level\":\"high|medium\",\"message\":\"一句话\"}]}；没有问题时 issues=[]。",
  "只依据 claim 与其 source snippets；不要补充外部知识；最多 8 条。",
  JSON.stringify(compact)
].join(String.fromCharCode(10));
const desk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
const cfg = (desk.models || {}).semantic || ((desk.models || {}).planner || {}).default || {};
const patch = path.join(ROOT, "runtime/profiles/claims-semantic.yml");
fs.mkdirSync(path.dirname(patch), { recursive: true });
fs.writeFileSync(patch, ["- id: agent-default-model", "  name: \"@deepseek-ai/dsh-agent-default-model\"", "  config:",
  "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
  "- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:",
  "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join(String.fromCharCode(10)));
const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home = path.join(ROOT, "runtime/dsh-home", "claims-semantic"); fs.mkdirSync(home, { recursive: true });
let key = process.env.OPENCODE_GO_API_KEY || "";
try { const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], { cwd: ROOT, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home }) });
let text = ""; String(r.stdout || "").split(String.fromCharCode(10)).forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
let out = null; try { const m = text.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; } catch (e) {}
if (!out || !Array.isArray(out.issues)) { const bad = { ok: false, error: "model empty/invalid", high: 0, issues: [], generatedAt: new Date().toISOString() }; fs.writeFileSync(path.join(base, "claims-semantic.json"), JSON.stringify(bad, null, 2)); console.log(JSON.stringify(bad)); process.exit(3); }
const issues = out.issues.slice(0, 8).map(x => ({ level: x.level === "high" ? "high" : "medium", claimId: String(x.claimId || ""), message: String(x.message || "").slice(0, 300) }));
const high = issues.filter(x => x.level === "high").length;
const data = { ok: true, high, issues, checked: compact.length, model: cfg.provider + "/" + cfg.model, generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(base, "claims-semantic.json"), JSON.stringify(data, null, 2));
console.log(JSON.stringify(data));
