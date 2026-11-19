#!/usr/bin/env node
"use strict";
/**
 * metric-semantic — 封闭候选集语义匹配
 *   node scripts/metric-semantic.js --case <case> --need N193 --index 0
 * 结果 POST /api/metric/apply，由 broker 做确定性门禁与状态迁移。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BRK = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const resolver = require(path.join(ROOT, "scripts/metric-resolver.js"));
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function apiOnce(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BRK + p), payload = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, x => {
      let s = ""; x.on("data", d => s += d); x.on("end", () => { let j = {}; try { j = JSON.parse(s); } catch (e) { j = { raw: s }; } resolve({ status: x.statusCode, body: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}
async function api(method, p, body) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { return await apiOnce(method, p, body); } catch (e) {
      last = e;
      if (!/ECONNRESET|EPIPE|socket hang up|ECONNREFUSED/i.test(String((e && e.message) || e))) break;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}
function plannerCfg(agent) {
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); } catch (e) { return {}; } })();
  const p = (cfg.models || {}).planner || {};
  return (p.byAgent || {})[agent] || p.default || { provider: "opencode-go", model: "deepseek-v4.1-flash" };
}
function patchFor(cfg) {
  return ["- id: agent-default-model", '  name: "@deepseek-ai/dsh-agent-default-model"', "  config:",
    "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
    "- id: llm-pi-ai", '  name: "@deepseek-ai/dsh-llm-pi-ai"', "  config:", "    providers:",
    "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join("\n");
}
function callModel(agent, prompt) {
  const cfg = plannerCfg(agent);
  const patch = path.join(ROOT, "runtime/profiles/metric-semantic-" + agent + ".yml");
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, patchFor(cfg));
  const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  const home = path.join(ROOT, "runtime/dsh-home", agent + "-metric");
  fs.mkdirSync(home, { recursive: true });
  let key = process.env.OPENCODE_GO_API_KEY || "";
  try {
    const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/);
    if (m) key = m[1];
  } catch (e) {}
  const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], {
    cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home })
  });
  let text = "";
  String(r.stdout || "").split("\n").forEach(line => {
    try { const j = JSON.parse(line); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {}
  });
  return text;
}
(async () => {
  const caseId = arg("case", "default");
  const needId = arg("need", "");
  const index = Number(arg("index", "-1"));
  if (!needId || !(index >= 0)) { console.error("需要 --need 和 --index"); process.exit(2); }
  const nr = await api("GET", "/api/needs?case=" + encodeURIComponent(caseId));
  const need = ((nr.body && nr.body.needs) || []).find(n => n.id === needId);
  if (!need) { console.error("need not found"); process.exit(3); }
  const item = (need.spec && need.spec.items || [])[index];
  if (!item) { console.error("item not found"); process.exit(3); }
  const metrics = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8")).metrics || [];
  const candidates = metrics.filter(m => m.status !== "draft").slice(0, 20).map(m => ({
    id: m.id, name: m.name, definition: String(m.definition || "").slice(0, 220),
    unit: m.unit || "", frequency: m.frequency || "", stockFlow: m.stockFlow || "",
    aliases: (m.aliases || []).slice(0, 6)
  }));
  const prompt = [
    "你是投研数据指标匹配器。只能从候选 metric 中选择，不得编造 ID。",
    '只输出 JSON：{"metricId":"候选ID或unknown","confidence":0.0,"reason":"一句话","alternatives":["候选ID"]}',
    "必须对照 definition / unit / frequency / stockFlow；字面像但定义冲突时不要选，metricId 输出 unknown。",
    "待匹配指标：", JSON.stringify({ indicator: item.indicator || "", definition: item.definition || "", unit: item.unit || "", frequency: item.frequency || "", range: item.range || "" }),
    "候选 metric：", JSON.stringify(candidates)
  ].join("\n");
  const out = callModel(need.agent || "macro", prompt);
  const m = out.match(/\{[\s\S]*\}/);
  let result = null;
  try { result = m ? JSON.parse(m[0]) : null; } catch (e) {}
  if (!result || !result.metricId) result = { metricId: "unknown", confidence: 0, reason: "模型无有效输出", alternatives: [] };
  const chosen = metrics.find(x => x.id === result.metricId);
  let state = "draft", reasons = ["无匹配 metric"];
  if (chosen) {
    const reasons0 = resolver.compatibility(chosen, item);
    state = reasons0.length ? "candidate_pending" : (Number(result.confidence) >= 0.9 ? "confirmed" : "candidate_pending");
    reasons = reasons0;
  }
  await api("POST", "/api/metric/apply", { case: caseId, needId, index,
    result: { state, metricId: chosen ? chosen.id : "", method: "semantic",
      confidence: Number(result.confidence) || 0, reason: result.reason || "", reasons,
      alternatives: result.alternatives || [] } });
  console.log(JSON.stringify({ ok: true, state, metricId: chosen ? chosen.id : "", confidence: result.confidence || 0 }));
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
