#!/usr/bin/env node
"use strict";
/**
 * planner — 为某个员工生成本轮计划（每员工一个规划者）
 *
 *   node scripts/planner.js --case case-2026-003 --agent macro            # 模板计划（默认，零模型调用）
 *   node scripts/planner.js --case case-2026-003 --agent macro --use-model # 调规划者模型产出 JSON（失败回退模板）
 *   node scripts/planner.js --case c --agent stock --dry-run
 *
 * 规划产物写入 Broker（/api/plan），研究类角色进入「待审批」，服务类自动通过。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BRK = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) >= 0; }
function apiOnce(method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(BRK + p), payload = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, x => {
      let s = ""; x.on("data", d => s += d); x.on("end", () => { let j = {}; try { j = s ? JSON.parse(s) : {}; } catch (e) { j = { raw: s }; } res({ status: x.statusCode, body: j }); });
    });
    r.on("error", rej); if (payload) r.write(payload); r.end();
  });
}
async function api(method, p, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await apiOnce(method, p, body); } catch (e) {
      last = e;
      if (!/ECONNRESET|EPIPE|ECONNREFUSED/.test(String(e && e.code || e))) break;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}
const CASE = arg("case", "default");
const AGENT = arg("agent", "");
const INTENT = arg("intent", "");
if (!AGENT) { console.error("需要 --agent"); process.exit(2); }
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); } catch (e) { return {}; } })();
async function reportScopeFailure(caseId, agent, text) {
  try { await api("POST", "/api/event", { case: caseId, type: "scope.failed", actor: agent,
    agent, text }); } catch (e) {}
  try { await api("POST", "/api/completion/options", { case: caseId, agent,
    title: "无法生成计划", message: text,
    options: [
      { id: "scope-retry", label: "补充研究范围", description: "重新输入问题/行业/范围", action: "scope-retry" },
      { id: "later", label: "稍后处理", description: "先不生成计划", action: "later" }
    ] }); } catch (e) {}
}
const ROLES = { macro: "宏观研究员", industry: "行业研究员", stock: "个股研究员", audit: "信息审计", legal: "法律顾问", trader: "交易员" };
// planFor fixed templates removed: use modelPlan + scope resolver.
function plannerCfg(agent) {
  const p = (CFG.models || {}).planner || {};
  return (p.byAgent || {})[agent] || p.default || { provider: "opencode-go", model: "deepseek-v4.1-flash" };
}
function patchFor(cfg) {
  return ["- id: agent-default-model", '  name: "@deepseek-ai/dsh-agent-default-model"', "  config:",
    "    provider: " + cfg.provider, "    model: " + cfg.model, "    reasoningEffort: high",
    "- id: llm-pi-ai", '  name: "@deepseek-ai/dsh-llm-pi-ai"', "  config:", "    providers:",
    "      " + cfg.provider + ":", "        apiKeyEnv: OPENCODE_GO_API_KEY", ""].join("\n");
}
function templatePath(agent) { return path.join(ROOT, "config/tasks", agent + ".json"); }
function loadTemplate(agent) {
  try { const j = JSON.parse(fs.readFileSync(templatePath(agent), "utf8")); return Array.isArray(j.steps) ? j.steps : (Array.isArray(j) ? j : null); } catch (e) { return null; }
}
function saveTemplate(agent, steps) {
  fs.mkdirSync(path.join(ROOT, "config/tasks"), { recursive: true });
  fs.writeFileSync(templatePath(agent), JSON.stringify({ agent, savedAt: new Date().toISOString(), steps }, null, 2));
  return templatePath(agent);
}
// --- 语义去重：本地相似度 + 规划模型判断 ---
function normText(s) {
  return String(s || "").toLowerCase().replace(/^追加[:：]/, "")
    // 同义词归一：让"管制/限制/管控""分析/研究/评估""影响/效应"落到同一词
    .replace(/限制|管控/g, "管制")
    .replace(/研究|评估|研判/g, "分析")
    .replace(/效应/g, "影响")
    .replace(/[补充|一下|进行|关于|针对|对|的|了]/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
function bigrams(s) {
  const t = normText(s), set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (!set.size && t) set.add(t);
  return set;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter += 1; });
  return inter / (A.size + B.size - inter);
}
function callPlannerModel(agent, prompt) {
  const cfg = plannerCfg(agent);
  const patch = path.join(ROOT, "runtime/profiles/planner-" + agent + ".yml");
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, patchFor(cfg));
  const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  const home = path.join(ROOT, "runtime/dsh-home", agent + "-planner");
  fs.mkdirSync(home, { recursive: true });
  let key = process.env.OPENCODE_GO_API_KEY || "";
  try {
    const m = fs.readFileSync(path.join(process.env.HOME || "", ".dsh/.credentials.yaml"), "utf8")
      .match(/OPENCODE_GO_API_KEY:\s*(\S+)/);
    if (m) key = m[1];
  } catch (e) {}
  const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], {
    cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home })
  });
  let text = "";
  String(r.stdout || "").split("\n").forEach(l => {
    try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {}
  });
  return text;
}
function classifyIntentModel(agent, text) {
  const prompt = [
    "判断用户这句话的意图。只输出一个 JSON 对象：",
    "{\"kind\":\"question|task|mixed|ack\",\"confidence\":0.0,\"task\":\"如果是任务，改写为动作句\",\"reason\":\"一句话\"}",
    "question=询问/要解释/要进度；task=要求改任务或做事；mixed=既问又要求做；ack=确认寒暄。",
    "用户：", text
  ].join("\n");
  const out = callPlannerModel(agent, prompt);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return { kind: j.kind || "task", confidence: j.confidence || 0,
    task: j.task || "", reason: j.reason || "" }; } catch (e) { return null; }
}
async function intentStatusText(agent) {
  const pending = ((await api("GET", "/api/needs?case=" + encodeURIComponent(CASE))).body.needs || [])
    .filter(n => n.status !== "answered");
  const pl = (await api("GET", "/api/plans?case=" + encodeURIComponent(CASE))).body.plans || [];
  const plan = pl.filter(p => p.agent === agent).pop();
  const works = (await api("GET", "/api/work?case=" + encodeURIComponent(CASE))).body.items || [];
  const items = plan ? works.filter(w => w.planId === plan.id) : [];
  const done = items.filter(w => w.state === "done").length;
  const running = items.filter(w => w.state === "running").length;
  let text = plan ? "当前计划 " + plan.id + "（" + plan.steps.length + " 个任务，" + plan.status + "）" +
    (items.length ? "，调度进度 " + done + "/" + items.length + (running ? "，正在执行 " + running + " 个节点" : "") : "，尚无调度节点")
    : "当前还没有已生成的任务计划。";
  text += pending.length ? "待补数据：" + pending.slice(0, 5).map(n => n.title).join("；") : "暂无待补数据。";
  return text.slice(0, 900);
}
function judgeDuplicate(agent, steps, intent) {
  if (((CFG.planning || {}).semanticDedupe) === false) return null;
  const brief = steps.map(s => ({ id: s.id, name: s.name, task: s.task })).slice(-40);
  const prompt = [
    "你是任务去重判断器。判断新意图是否与已有任务语义重复（同一目标、同一交付物或同一动作）。",
    "同义表达视为重复，例如：出口管制/出口限制、分析影响/影响分析、研判/研究、补充/追加。",
    "只输出一个 JSON 对象：{\"duplicate\":true|false,\"targetId\":\"S?\",\"mergedTask\":\"如果重复，把新信息并入已有任务后的完整任务描述\",\"reason\":\"一句话\"}",
    "已有任务：", JSON.stringify(brief),
    "新意图：", intent
  ].join("\n");
  const text = callPlannerModel(agent, prompt);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { duplicate: !!j.duplicate, targetId: j.targetId || "", mergedTask: j.mergedTask || "", reason: j.reason || "" };
  } catch (e) { return null; }
}
function reviewScope(agent, scopeOut) {
  const prompt = [
    "你是投研规划审校者。检查下面选出的研究模块是否能回答问题；只输出 JSON，不要解释：",
    '{"add":["module_id"],"remove":["module_id"],"reason":"一句话"}',
    "规则：只允许从 available 里加；最多 add 2 个、remove 2 个；窄问题不要扩成完整报告；不要选无关行业模块。",
    "问题：", String(INTENT || "").slice(0, 1000),
    "意图：", JSON.stringify(scopeOut.intent),
    "已选：", JSON.stringify(scopeOut.modules.selected.map(x => x.id)),
    "排除：", JSON.stringify(scopeOut.modules.excluded.map(x => x.id)),
    "available：", JSON.stringify((scopeOut.modules.available || []).map(x => ({ id: x.id, name: x.name })))
  ].join(String.fromCharCode(10));
  const out = callPlannerModel(agent, prompt);
  const m = out.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
function modelPlan(agent, base) {
  const intent = INTENT;
  const cfg = plannerCfg(agent);
  const patch = path.join(ROOT, "runtime/profiles/planner-" + agent + ".yml");
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, patchFor(cfg));
  const mission = (() => { try { return fs.readFileSync(path.join(ROOT, "vault", CASE, "mission.md"), "utf8"); } catch (e) { return ""; } })();
  const prompt = [
    "你是 AlphaDesk 的规划者，为员工 " + agent + "（" + (ROLES[agent] || agent) + "）生成本轮步骤计划。",
    "只输出一个 JSON 对象，不要解释：{\"goal\":\"...\",\"steps\":[{\"id\":\"S0\",\"name\":\"...\",\"tier\":\"fast|strong|verify\",\"task\":\"...\",\"outputs\":[\"...\"],\"depends\":[\"S0\"]}]}",
    "要求：4–8 步；每步边界是可验收产物；tier 只能 fast/strong/verify；不要编造数据。",
    "如果任务涉及数据/趋势/对比，必须包含一个「可视化：关键图表」步骤（用 node scripts/chart.js 生成 SVG 并在底稿引用）。",
    "mission：", mission.slice(0, 4000),
    intent ? ("用户这次的意图：" + intent) : "",
    "参考模板（可改写）：", JSON.stringify(base)
  ].join("\n");
  const dsh = process.env.DSH_BIN || "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
  const home = path.join(ROOT, "runtime/dsh-home", agent + "-planner");
  fs.mkdirSync(home, { recursive: true });
  const keyFile = path.join(process.env.HOME || "", ".dsh/.credentials.yaml");
  let key = process.env.OPENCODE_GO_API_KEY || "";
  try { const m = fs.readFileSync(keyFile, "utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/); if (m) key = m[1]; } catch (e) {}
  const r = spawnSync(dsh, ["--patch", patch, "--profile", "headless", "--json", prompt], {
    cwd: ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { OPENCODE_GO_API_KEY: key, DSH_HOME: home })
  });
  let text = "";
  String(r.stdout || "").split("\n").forEach(l => { try { const j = JSON.parse(l); if (j.type === "final" && typeof j.text === "string") text = j.text; } catch (e) {} });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.steps) || !j.steps.length) return null;
    const steps = j.steps.slice(0, 10).map((s, i) => ({
      id: s.id || "S" + i, name: String(s.name || "步骤" + i).slice(0, 40),
      tier: ["fast", "strong", "verify"].indexOf(s.tier) >= 0 ? s.tier : "strong",
      task: String(s.task || "").slice(0, 400), outputs: Array.isArray(s.outputs) ? s.outputs.slice(0, 4) : [],
      depends: Array.isArray(s.depends) ? s.depends.slice(0, 4) : [],
      parentId: s.parentId ? String(s.parentId).slice(0, 20) : "",
      branchId: s.branchId ? String(s.branchId).slice(0, 30) : "",
      merge_from: Array.isArray(s.merge_from || s.mergeFrom) ? (s.merge_from || s.mergeFrom).slice(0, 5) : [],
      failurePolicy: ["required", "degradable", "optional"].indexOf(s.failurePolicy) >= 0 ? s.failurePolicy : "required"
    }));
    if (steps.length < 3 || steps.length > 10) return null;
    const ids = new Set(steps.map(x => x.id));
    if (ids.size !== steps.length) return null;
    for (const st of steps) {
      if ((st.depends || []).some(d => !ids.has(d))) return null;
      if (!st.task || !st.outputs || !st.outputs.length) return null;
    }
    // 依赖环检测
    const state = {};
    function visit(id) { if (state[id] === 1) return false; if (state[id] === 2) return true; state[id] = 1; const st = steps.find(x => x.id === id); for (const d of (st && st.depends) || []) { if (!visit(d)) return false; } state[id] = 2; return true; }
    for (const st of steps) if (!visit(st.id)) return null;
    return { goal: String(j.goal || "").slice(0, 300), steps, by: "model" };
  } catch (e) { return null; }
}
(async () => {
  if (flag("completion-options")) {
    const idx = process.argv.indexOf("--completion-options");
    const planId = process.argv[idx + 1] || "";
    const pl = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
    const plan = ((pl.body && pl.body.plans) || []).find(x => x.id === planId);
    const wk = await api("GET", "/api/work?case=" + encodeURIComponent(CASE));
    const items = ((wk.body && wk.body.items) || []).filter(x => x.planId === planId);
    const casePlans = (pl.body && pl.body.plans) || [];
    const caseWork = (wk.body && wk.body.items) || [];
    const busyAgents = {};
    casePlans.filter(x => x.status === "approved" || x.status === "running").forEach(x => { busyAgents[x.agent] = x.id; });
    caseWork.filter(x => x.state === "running" || x.state === "queued").forEach(x => { busyAgents[x.agent] = busyAgents[x.agent] || x.planId; });
    const nd = await api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
    const pending = ((nd.body && nd.body.needs) || []).filter(x => x.status === "pending" || x.status === "partial");
    const rp = await api("GET", "/api/reports?case=" + encodeURIComponent(CASE));
    const reports = ((rp.body && rp.body.reports) || []).map(x => x.path || x.name || "");
    const ql = await api("GET", "/api/quality?case=" + encodeURIComponent(CASE));
    const dj = await api("GET", "/api/data/jobs?case=" + encodeURIComponent(CASE));
    const dataJobs = ((dj.body && dj.body.jobs) || []).filter(x => x.status === "failed" || x.status === "needs_review");
    const rd = await api("GET", "/api/report/readiness?case=" + encodeURIComponent(CASE) + "&agent=" + encodeURIComponent(AGENT));
    const diag = {
      failed: items.filter(x => x.state === "failed").map(x => ({ id: x.id, node: x.nodeId, error: String(x.error || "").slice(0, 80) })),
      partial: items.filter(x => x.state === "done" && x.partial).map(x => x.nodeId),
      done: items.filter(x => x.state === "done").length,
      total: items.length,
      pendingNeeds: pending.map(x => ({ id: x.id, title: x.title, blocking: !!x.blocking })).slice(0, 6),
      reports, evidence: (ql.body && ql.body.evidence) || 0,
      readiness: rd.body ? { formal: rd.body.formal, reason: rd.body.reason } : null,
      dataJobs: dataJobs.map(x => ({ id: x.id, metric: x.metric, status: x.status, error: String(x.error || x.lastError || "").slice(0, 80) })).slice(0, 5),
      activeAgents: busyAgents,
      activePlans: casePlans.filter(x => x.status === "approved" || x.status === "running").map(x => ({ id: x.id, agent: x.agent, steps: (x.steps || []).length }))
    };
    const mission = (() => { try { return fs.readFileSync(path.join(ROOT, "vault", CASE, "mission.md"), "utf8"); } catch (e) { return ""; } })();
    const fallbackOpts = [];
    if (diag.failed.length) fallbackOpts.push({
      id: "retry-failed", label: "重试失败节点",
      description: "重试当前计划里失败的 WorkItem，重置 attempt 后重新入队",
      action: "retry_failed", payload: { workIds: items.filter(x => x.state === "failed").map(x => x.id) }
    });
    const blockingNeed = pending.filter(x => x.blocking)[0] || pending[0];
    if (blockingNeed) fallbackOpts.push({
      id: "collect-need", label: "补缺失数据",
      description: "打开阻塞缺口的补数据入口",
      action: "collect_need", payload: { needId: blockingNeed.id }
    });
    if (AGENT !== "macro" && !busyAgents.macro) fallbackOpts.push({
      id: "start-macro", label: "启动宏观研究", description: "补宏观环境、政策、利率与汇率",
      action: "start_agent", payload: { agent: "macro" }
    });
    if (AGENT !== "industry" && !busyAgents.industry) fallbackOpts.push({
      id: "start-industry", label: "启动行业研究", description: "补供需、价格、库存与竞争格局",
      action: "start_agent", payload: { agent: "industry" }
    });
    if (AGENT !== "stock" && !busyAgents.stock) fallbackOpts.push({
      id: "start-stock", label: "启动个股研究", description: "补财务、估值与目标价",
      action: "start_agent", payload: { agent: "stock" }
    });
    const fallback = { title: "本轮任务已完成", message: "接下来要做什么？", options: fallbackOpts.slice(0, 5) };
    let result = fallback;
    result.options = (result.options || []).filter(o => !((o.action === "industry" || o.action === "stock") && busyAgents[o.action]));
    if (!result.options.length) result.options = [{ id: "wait-parallel", label: "等待并行任务",
      description: "该员工仍有关联任务在运行，先等待，避免重复派活", action: "later" }];
    const prompt = [
      "你是投研项目的 NextActionPlanner，不是模板填空器。根据当前真实状态判断最值得做的下一步（最多 5 个）。",
      '只输出 JSON：{"title":"...","message":"...","options":[{"id":"...","label":"...","description":"...","action":"retry_failed|collect_need|macro-report|industry-report|stock-report|view-macro|industry|stock|later","payload":{}}]}',
      "动作：retry_failed payload={workIds:[...]}；collect_need payload={needId}；start_agent payload={agent,target}。没有可执行动作时不要编造选项；不要生成单员工装配报告选项，最终报告由统一流程生成。",
      "规则：有 failed 且可重试时优先 retry_failed；有阻塞 pending need 时优先 collect_need；不要推荐已完成/已有报告的重复装配；有失败节点不要假装完成；描述写清原因和预期。",
      "并行约束：activeAgents 里的员工已有 approved/running 计划，禁止再推荐同名 action（industry/stock），否则会重复派活；此时优先等待并行结果、查看已完成底稿或补缺口。",
      "mission：", String(mission).slice(0, 1800),
      "已完成计划：" + planId + "，员工：" + (plan && plan.agent),
      "真实状态 JSON：", JSON.stringify(Object.assign({}, diag, { failedWorkIds: items.filter(x => x.state === "failed").map(x => x.id), pendingNeedItems: pending.map(x => ({ id: x.id, specs: (x.spec && x.spec.items || []).map((it, i) => ({ index: i, indicator: it.indicator })).filter(it => it.indicator) })) })),
      "待补数据：" + pending.map(x => x.title).slice(0, 5).join("；")
    ].join("\n");
    const out = callPlannerModel(AGENT, prompt);
    const m = out.match(/\{[\s\S]*\}/);
    try {
      const j = m ? JSON.parse(m[0]) : null;
      if (j && Array.isArray(j.options) && j.options.length) {
        const allowed = ["retry_failed", "collect_need", "start_agent"];
        j.options = j.options.filter(o => allowed.indexOf(o.action) >= 0).filter(o => {
          if ((o.action === "industry" || o.action === "stock") && busyAgents[o.action]) return false;
          if (o.action === "start_agent" && o.payload && busyAgents[o.payload.agent]) return false;
          if (o.action === "assemble_report" && o.payload && reports.some(p => new RegExp(o.payload.agent + "-report").test(p))) return false;
          if (o.action === "industry-report" && reports.some(p => /industry/i.test(p))) return false;
          if (o.action === "stock-report" && reports.some(p => /stock/i.test(p))) return false;
          return true;
        }).slice(0, 5);
        if (!j.options.length && Object.keys(busyAgents).length) {
          j.options = [{ id: "wait-parallel", label: "等待并行任务",
            description: "行业/个股仍在运行，先等并行结果，避免重复派活",
            action: "later" }];
        }
        if (j.options.length) result = { title: j.title || fallback.title,
          message: j.message || fallback.message, options: j.options };
      }
    } catch (e) {}
    await api("POST", "/api/completion/options", { case: CASE, planId, agent: AGENT,
      title: result.title, message: result.message, options: result.options });
    console.log(JSON.stringify({ ok: true, options: result.options.length }));
    process.exit(0);
  }
  if (flag("need-dedupe")) {
    const idx = process.argv.indexOf("--need-dedupe");
    const needId = process.argv[idx + 1] || "";
    const all = await api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
    const list = (all.body && all.body.needs) || [];
    const n = list.find(x => x.id === needId);
    if (!n) { console.error("need not found", needId); process.exit(2); }
    const ids = (n.pendingDedupe && n.pendingDedupe.candidateIds) || [];
    const candidates = ids.map(id => list.find(x => x.id === id)).filter(Boolean);
    const brief = candidates.map(c => ({ id: c.id, title: c.title,
      indicators: c.indicatorIds || [], detail: String(c.detail || "").slice(0, 400) }));
    const prompt = [
      "判断“新缺口”和“已有缺口”是否属于同一数据需求。只输出 JSON：",
      "{\"relation\":\"duplicate|related|different\",\"targetId\":\"N?\",\"confidence\":0.0,\"reason\":\"一句话\"}",
      "duplicate=同一指标集合/可直接合并；related=部分重叠但口径可能不同，建议人工确认；different=不同需求。",
      "新缺口：", JSON.stringify({ id: n.id, title: n.title, indicators: n.indicatorIds || [],
        detail: String(n.detail || "").slice(0, 400), spec: n.spec || null }),
      "已有缺口：", JSON.stringify(brief)
    ].join("\n");
    const out = callPlannerModel(AGENT, prompt);
    const m = out.match(/\{[\s\S]*\}/);
    let judged = null;
    try { judged = m ? JSON.parse(m[0]) : null; } catch (e) {}
    const target = (judged && judged.targetId) || (candidates[0] && candidates[0].id);
    if (!target) process.exit(0);
    const rel = judged && judged.relation ? judged.relation : "related";
    await api("POST", "/api/need/merge-suggest", { case: CASE, id: needId, targetId: target,
      relation: rel, confidence: (judged && judged.confidence) || 0.5,
      reason: (judged && judged.reason) || "部分指标重叠，建议人工确认" });
    console.log(JSON.stringify({ ok: true, needId, targetId: target, relation: rel,
      confidence: judged && judged.confidence }));
    process.exit(0);
  }
  if (flag("save-template")) {
    console.error("固定模板已废弃；请通过 scope 模块生成计划");
    process.exit(3);
  }
  // 固定模板不再作为规划或兜底；新计划只能由 scope resolver 产生。
  const base = [];
  let plan = { goal: INTENT ? INTENT.slice(0, 60) : (ROLES[AGENT] + "本轮计划"), steps: base, by: "scope" };
  const cfg = plannerCfg(AGENT);
  if (flag("dry-run")) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
  // 已有任务列表时：后续对话只增删改，不新增段
  if (INTENT && !flag("force-new") && !flag("emit-plan")) {
    const existing = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
    const cur = ((existing.body && existing.body.plans) || []).filter(p => p.agent === AGENT).pop();
    if (cur) {
      let classifyKind = "";
      // 规则判为歧义/混合时，由小模型再判一次；明确问题直接回复
      if (flag("classify-only")) {
        const judged = classifyIntentModel(AGENT, INTENT);
        classifyKind = (judged && judged.kind) || "task";
        if (classifyKind === "question" || classifyKind === "ack") {
          const text = await intentStatusText(AGENT);
          await api("POST", "/api/event", { case: CASE, type: "agent.reply", actor: AGENT, agent: AGENT,
            stage: "Q", text: text, by: "intent-model" });
          console.log(JSON.stringify({ ok: true, answered: true, kind: classifyKind,
            method: "model", reason: judged && judged.reason }));
          process.exit(0);
        }
        if (classifyKind === "mixed") {
          const text = await intentStatusText(AGENT);
          await api("POST", "/api/event", { case: CASE, type: "agent.reply", actor: AGENT, agent: AGENT,
            stage: "Q", text: text, by: "intent-model" });
        }
      }
      // 0) 询问类意图不写任务列表；直接回复待补数据/执行进度
      const isQuestion = /(怎么|为什么|为何|还差|还需要|需要什么|缺什么|进度|多久|什么时候|是否|能不能|可以吗|如何)/.test(INTENT);
      const isTaskVerb = /^(请)?(补充|增加|分析|生成|写|做|改|删|添加|执行|跑|评估|核对|整理|输出|研究|帮我)/.test(INTENT.trim());
      if (classifyKind !== "mixed" && isQuestion && !isTaskVerb) {
        const needRes = await api("GET", "/api/needs?case=" + encodeURIComponent(CASE));
        const pending = ((needRes.body && needRes.body.needs) || []).filter(n => n.status !== "answered");
        const workRes = await api("GET", "/api/work?case=" + encodeURIComponent(CASE));
        const items = ((workRes.body && workRes.body.items) || []).filter(w => w.planId === cur.id);
        const done = items.filter(w => w.state === "done").length;
        const running = items.filter(w => w.state === "running").length;
        const text = "这是询问，不新增任务。当前计划 " + cur.id + " 已批准，共 " + cur.steps.length +
          " 个任务；调度进度 " + done + "/" + (items.length || cur.steps.length) +
          (running ? "，正在执行 " + running + " 个节点" : "") +
          (pending.length ? "。待补数据：" + pending.slice(0, 5).map(n => n.title).join("；") : "。暂无待补数据。");
        await api("POST", "/api/event", { case: CASE, type: "agent.reply", actor: AGENT, agent: AGENT,
          stage: "Q", text: text.slice(0, 900), by: "planner" });
        console.log(JSON.stringify({ ok: true, answered: true, skipped: "question", text: text.slice(0, 300) }));
        process.exit(0);
      }
      // 1) 本地相似度先筛；2) 规划模型做语义判断；3) 重复则并入，不新增
      let best = null, bestScore = 0;
      cur.steps.forEach(s => {
        const sc = Math.max(similarity(INTENT, s.name || ""), similarity(INTENT, s.task || ""));
        if (sc > bestScore) { bestScore = sc; best = s; }
      });
      let dup = null, method = "";
      if (best && bestScore >= 0.55) { dup = { id: best.id, mergedTask: "" }; method = "local"; }
      if (!dup) {
        const judged = judgeDuplicate(AGENT, cur.steps, INTENT);
        console.error("[judge]", JSON.stringify(judged));
        if (judged && judged.duplicate && judged.targetId) {
          dup = { id: judged.targetId, mergedTask: judged.mergedTask || "" };
          method = "model";
        }
      }
      let merged;
      if (dup && cur.steps.some(s => s.id === dup.id)) {
        const target = cur.steps.find(s => s.id === dup.id);
        const update = { id: dup.id, task: dup.mergedTask ||
          (String(target.task || "") + "；补充：" + INTENT) };
        merged = await api("POST", "/api/plan/merge", { case: CASE, agent: AGENT, update: [update], by: "planner" });
        if (merged.status !== 200) { console.error("合并失败", merged.status); process.exit(4); }
        console.log(JSON.stringify({ ok: true, planId: merged.body.plan.id, merged: true, deduped: true,
          method: method, targetId: dup.id, steps: merged.body.plan.steps.length }));
        process.exit(0);
      }
      const id = "A" + Date.now().toString(36).slice(-5);
      const step = { id, name: ("追加：" + INTENT).slice(0, 32), tier: "strong",
        task: INTENT, outputs: [], depends: [] };
      merged = await api("POST", "/api/plan/merge", { case: CASE, agent: AGENT, add: [step], by: "planner" });
      if (merged.status !== 200) {
        console.error("合并任务失败", merged.status, JSON.stringify(merged.body).slice(0, 300));
        process.exit(4);
      }
      const mp = merged.body.plan;
      var skipped = (merged.body && merged.body.skipped) || 0;
      console.log(JSON.stringify({ ok: true, planId: mp.id, status: mp.status, merged: true,
        added: skipped ? 0 : 1, skipped: skipped, steps: mp.steps.length }));
      process.exit(0);
    }
  }
  // 新计划：用 scope resolver 从意图选模块，替代固定模板
  let scopeOut = null;
  if (INTENT && !flag("no-scope")) {
    try {
      const scope = require("./scope");
      let out = scope.resolve({
        case: CASE, agent: AGENT, text: INTENT,
        subject: arg("subject", ""), industry: arg("industry", ""),
        subjectType: arg("subject-type", ""), depth: arg("depth", ""),
        deliverable: arg("deliverable", ""), horizon: arg("horizon", "")
      });
      if (out.steps && out.steps.length && out.modules.selected.length) {
        if (flag("use-model")) {
          const review = reviewScope(AGENT, out);
          if (review && (review.add || review.remove)) {
            out = scope.applyReview(out, review);
            try { await api("POST", "/api/event", { case: CASE, type: "scope.reviewed", actor: AGENT,
              agent: AGENT, add: review.add || [], remove: review.remove || [], reason: review.reason || "" }); } catch (e) {}
          }
        }
        scopeOut = out;
        plan = { goal: INTENT.slice(0, 60), steps: out.steps, by: "scope" };
        if (flag("model-plan")) {
          const mp = modelPlan(AGENT, out.steps);
          if (mp && mp.steps && mp.steps.length) { plan = { goal: mp.goal || INTENT.slice(0, 60), steps: mp.steps, by: "model" }; }
          else console.error("[planner] model plan invalid; fallback to scope");
        }
        if (flag("emit-plan")) { console.log(JSON.stringify(plan)); process.exit(0); }
        scope.writeScope(out);
        try {
          const outline = scope.outlineMarkdown(out);
          await api("POST", "/api/upload", { case: CASE, path: "research/report-outline.md",
            name: "report-outline.md", contentBase64: Buffer.from(outline).toString("base64"),
            by: "planner" });
        } catch (e) {}
        try { await api("POST", "/api/event", { case: CASE, type: "scope.resolved", actor: AGENT,
          agent: AGENT, intent: out.intent, selected: out.modules.selected.map(x => x.id),
          excluded: out.modules.excluded.map(x => x.id), steps: out.steps.length }); } catch (e) {}
      }
    } catch (e) {
      console.error("[scope] failed", String(e && e.message || e));
      await reportScopeFailure(CASE, AGENT, "无法从意图生成计划：" + String(e && e.message || e));
    }
  }
  if (INTENT && !scopeOut) {
    console.error("[planner] scope resolver failed; fixed template fallback removed");
    await reportScopeFailure(CASE, AGENT, "无法从意图生成计划；请补充行业/研究范围后重试");
    process.exit(3);
  }
  if (!plan.steps || !plan.steps.length) {
    console.error("[planner] empty plan; intent/scope required");
    await reportScopeFailure(CASE, AGENT, "计划为空；请通过意图补充研究范围");
    process.exit(3);
  }
  const created = await api("POST", "/api/plan", { case: CASE, agent: AGENT, steps: plan.steps,
    goal: plan.goal, planner: cfg, by: plan.by || "planner" });
  if (created.status !== 200) { console.error("创建计划失败", created.status, JSON.stringify(created.body).slice(0, 300)); process.exit(4); }
  const p = created.body.plan;
  // 行业意图含“筛选公司”：额外生成一个 stock screen 计划（待审批，不自动执行）
  if (scopeOut && scopeOut.screen && scopeOut.screen.needed && !flag("no-screen")) {
    try {
      const existing = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
      const hasScreen = ((existing.body && existing.body.plans) || []).some(x =>
        x.agent === "stock" && String(x.goal || "").indexOf("公司筛选") >= 0 &&
        (x.status === "pending" || x.status === "approved"));
      if (!hasScreen) {
        const sp = await api("POST", "/api/plan", { case: CASE, agent: "stock",
          goal: "公司筛选：" + (scopeOut.intent.industry || scopeOut.intent.question || "").slice(0, 40),
          steps: scopeOut.screen.steps, by: "scope-screen",
          parentPlanId: p.id, relation: "screen" });
        if (sp.status === 200) {
          try { await api("POST", "/api/event", { case: CASE, type: "screen.proposed", actor: "planner",
            agent: "stock", planId: sp.body.plan.id, parentPlanId: p.id, industry: scopeOut.intent.industry,
            candidates: scopeOut.screen.modules }); } catch (e) {}
        }
      }
    } catch (e) { console.error("[screen] failed", String(e && e.message || e)); }
  }
  if (scopeOut && scopeOut.industryUnknown && AGENT === "industry") {
    try {
      await api("POST", "/api/completion/options", { case: CASE, planId: p.id, agent: AGENT,
        title: "检测到新行业", message: "“" + String(scopeOut.intent.industry || "") + "”未在行业类型库中，是否生成研究框架草案？",
        options: [
          { id: "learn", label: "生成行业研究框架草案", description: "草案需确认后启用", action: "learn-industry" },
          { id: "skip", label: "先用通用框架", description: "使用 universal + general", action: "later" }
        ] });
    } catch (e) {}
  }
  console.log(JSON.stringify({ ok: true, planId: p.id, status: p.status, steps: p.steps.length,
    screen: !!(scopeOut && scopeOut.screen && scopeOut.screen.needed),
    industryUnknown: !!(scopeOut && scopeOut.industryUnknown), planner: cfg }));
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
