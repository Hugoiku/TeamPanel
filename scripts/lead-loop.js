#!/usr/bin/env node
"use strict";
/**
 * lead-loop — Lead 级有界 super-agent 循环。
 *
 *   node scripts/lead-loop.js --case c --objective "..." --max-rounds 4 --mode fake
 *   node scripts/lead-loop.js --case c --objective "..." --mode real --runtime openai
 *
 * Lead 只做编排：创建/修订计划、创建 WorkItem/Task Envelope、启动有界 Employee Loop、
 * 请求复核、取消任务、装配报告（不签发）。高风险动作必须有人工审批痕迹。
 */
const lib = require("./agent-loop-lib");
const runtimeApi = require("./agent-runtime");
const tools = require("./tool-gateway");
const fs = require("fs");
const path = require("path");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
let DESK_CFG = {};
try { DESK_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config/desk.json"), "utf8")); } catch (e) {}
const ALLOWED_ACTIONS = {
  workflow: ["start_plans", "ask_human", "wait", "finish"],
  supervised: ["start_plans", "create_plan", "revise_plan", "assign_task", "spawn_employee",
    "request_review", "cancel_task", "ask_human", "wait", "synthesize", "finish"],
  autonomous: ["start_plans", "create_plan", "revise_plan", "assign_task", "spawn_employee",
    "request_review", "cancel_task", "ask_human", "wait", "synthesize", "finish"]
};
async function observe(caseId) {
  const out = {};
  const calls = [
    ["snapshot", "case.snapshot", { case: caseId }],
    ["needs", "case.needs", { case: caseId }],
    ["plans", "case.plans", { case: caseId }],
    ["work", "case.work", { case: caseId }],
    ["preflight", "data.preflight", { case: caseId }],
    ["freshness", "report.freshness", { case: caseId }]
  ];
  for (const [k, name, args] of calls) {
    try { const r = await tools.invoke(name, args, { actor: "lead", case: caseId, traceId: "lead-observe" });
      out[k] = r && r.result !== undefined ? r.result : r; } catch (e) { out[k] = { error: String((e && e.message) || e) }; }
  }
  return out;
}
function decisionPrompt(caseId, objective, round, maxRounds, obs) {
  return [
    "你是 AlphaDesk 的 Lead。case：" + caseId + "。研究目标：" + objective,
    "这是 Lead 编排循环第 " + round + "/" + maxRounds + " 轮。",
    "下面是当前观察（JSON 摘要）：",
    JSON.stringify(obs).slice(0, 14000),
    "",
    "请决定下一步动作，只返回一个 JSON 对象：",
    "{",
    '  "action": "start_plans|create_plan|revise_plan|assign_task|spawn_employee|request_review|cancel_task|ask_human|wait|synthesize|finish",',
    '  "planIds": ["PL1"],',
    '  "plan": {"agent":"industry","goal":"...","steps":[{"id":"S1","name":"...","task":"...","outputs":["research/x.md"],"depends":[]}]},',
    '  "revise": {"planId":"PL1","add":[],"update":[],"remove":[],"reason":"..."},',
    '  "task": {"planId":"PL1","nodeId":"S1","name":"...","agent":"industry","task":"...","outputs":["research/x.md"],"depends":[],"envelope":{"acceptance":["..."],"tools":["data.collect"]}},',
    '  "spawn": {"workId":"W1","agent":"industry","runtime":"dsh","mode":"real","maxRounds":3},',
    '  "review": {"title":"...","detail":"..."},',
    '  "cancel": {"workId":"W1","reason":"..."},',
    '  "need": {"kind":"info","title":"...","detail":"..."},',
    '  "force": false,',
    '  "reason": "为什么"',
    "}",
    "规则：",
    "- 没有计划或计划步骤不完整 → create_plan（只建 pending 草稿，人工批准后才能跑）；",
    "- 已有 approved 计划且未运行 → start_plans；",
    "- 计划已批准但还没有 WorkItem → assign_task（必须带 Task Envelope）；",
    "- 有 queued WorkItem 且预算允许 → spawn_employee（每个 WorkItem 一个 Employee Loop）；",
    "- 已有任务在跑 → wait；",
    "- 有阻塞缺口/需要用户决策 → ask_human；",
    "- 如果缺口/DataJob 状态是 needs_paid_approval / quota_exhausted → ask_human，不要反复 spawn 员工；",
    "- 如果状态是 rate_limited / circuit_open → wait 或 revise_plan 换源，不要立即重试；",
    "- 需要已有事实时调用 knowledge.search；只有 verified + report_citation 的知识可用于结论；不要提升/改权限；",
    "- 产物需要独立复核 → request_review；",
    "- 需要取消任务 → cancel_task（高风险，需人工审批）；",
    "- 所有计划完成且报告未装配 → synthesize（只装配、不签发；需人工审批）；",
    "- 无事可做或已完成 → finish。",
    "不要直接签发报告，不要绕过审计/法务门禁；不要自己批准计划。"
  ].join(String.fromCharCode(10));
}
function normSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 12).map((s, i) => ({
    id: String(s.id || ("S" + (i + 1))).slice(0, 20),
    name: String(s.name || ("任务" + (i + 1))).slice(0, 60),
    tier: ["fast", "strong", "verify"].indexOf(s.tier) >= 0 ? s.tier : "strong",
    task: String(s.task || "").slice(0, 1000),
    outputs: Array.isArray(s.outputs) ? s.outputs.slice(0, 6) : [],
    depends: Array.isArray(s.depends) ? s.depends.slice(0, 6) : [],
    failurePolicy: ["required", "degradable", "optional"].indexOf(s.failurePolicy) >= 0 ? s.failurePolicy : "required"
  }));
}
async function needsList(caseId) {
  try { const r = await lib.api("GET", "/api/needs?case=" + encodeURIComponent(caseId)); return (r.body && r.body.needs) || []; }
  catch (e) { return []; }
}
// 结构化审批优先：decision=approve 才算通过；旧 need 没有 decision 时才回退到文本判断。
function answered(n) { return n && n.status === "answered" && !n.waived; }
function rejected(n) {
  const s = String((n && (n.answer || n.waiveReason)) || "");
  return /不批准|不同意|拒绝|驳回|暂不|先不|无法补充|\bno\b|\breject\b/i.test(s);
}
function approved(n) {
  if (!answered(n) || n.consumedAt) return false;
  if (n.decision) return n.decision === "approve";
  return !rejected(n);
}
async function approvalAnswered(caseId, prefix, ref) {
  const list = await needsList(caseId);
  return list.find(n => approved(n) && String(n.title || "").startsWith(prefix) &&
    (!ref || String(n.detail || "").indexOf(ref) >= 0)) || null;
}
async function activeWork(caseId) {
  try { const r = await lib.api("GET", "/api/work?case=" + encodeURIComponent(caseId));
    return ((r.body && r.body.items) || []).filter(w => w.state === "running" || w.state === "queued" || w.state === "cancelling"); }
  catch (e) { return []; }
}
(async () => {
  const caseId = arg("case", "");
  const objective = arg("objective", "完成 case 研究并产出可审阅报告");
  const maxRounds = Math.max(1, Math.min(8, parseInt(arg("max-rounds", "4"), 10) || 4));
  const mode = arg("mode", "fake") === "real" ? "real" : "fake";
  const runtimeName = arg("runtime", "dsh");
  const maxTokens = Math.max(0, parseInt(arg("max-tokens", "160000"), 10) || 160000);
  const maxWallMs = Math.max(1000, parseInt(arg("max-wall-ms", String(40 * 60 * 1000)), 10) || 40 * 60 * 1000);
  const fakeDecisionRaw = arg("fake-decision", "");
  const replayOf = arg("replay-of", "");
  const resumeOf = arg("resume-of", "");
  const leaseId = arg("lease-id", "");
  const autonomy = String(arg("autonomy", (DESK_CFG.autonomy && DESK_CFG.autonomy.mode) || "supervised"));
  const started = Date.now();
  const id = arg("loop-id", "") || lib.loopId("lead");
  if (!caseId) { console.error("用法: lead-loop.js --case <c> [--objective ...] [--max-rounds 4] [--mode fake|real]"); process.exit(2); }
  let oldState = null;
  try { if (resumeOf) oldState = lib.readState(resumeOf); } catch (e) {}
  const resumeRound = oldState ? (Number(oldState.rounds) || 0) + 1 : 1;
  const roundsLimit = oldState ? Math.min(12, Math.max(maxRounds, resumeRound)) : maxRounds;
  const state = { id, pid: process.pid, case: caseId, kind: "lead", agent: "lead", objective, mode, runtime: runtimeName, replayOf, resumeOf, autonomy,
    status: "running", rounds: oldState ? (Number(oldState.rounds) || 0) : 0, maxRounds: roundsLimit,
    trace: oldState && Array.isArray(oldState.trace) ? oldState.trace : [], decision: null,
    decisionId: "", actionId: "",
    appliedActions: oldState && Array.isArray(oldState.appliedActions) ? oldState.appliedActions : [],
    actions: oldState && Array.isArray(oldState.actions) ? oldState.actions : [],
    budget: { maxRounds: roundsLimit, maxTokens, maxWallMs },
    usage: oldState && oldState.usage ? Object.assign({ tokens: 0, toolCalls: 0, wallMs: 0 }, oldState.usage) : { tokens: 0, toolCalls: 0, wallMs: 0 },
    resumedFrom: resumeOf || "", resumeCount: oldState ? (Number(oldState.resumeCount) || 0) + 1 : 0,
    createdAt: (oldState && oldState.createdAt) || new Date().toISOString() };
  lib.writeState(state);
  let leaseTimer = null;
  if (leaseId) {
    const beat = async () => {
      try {
        const r = await lib.api("POST", "/api/agent/loop/heartbeat", { case: caseId, loopId: id });
        if (r.status === 409) lib.appendTrace(state, "lease.lost", "Lead lease 已丢失");
      } catch (e) { lib.appendTrace(state, "lease.heartbeat_error", String((e && e.message) || e)); }
    };
    leaseTimer = setInterval(beat, 30000);
    if (leaseTimer.unref) leaseTimer.unref();
    beat();
  }
  async function note(action, ok, detail, extra) {
    const rec = Object.assign({ round: state.rounds, action, ok: !!ok, detail: String(detail || "").slice(0, 600),
      decisionId: state.decisionId || "", actionId: state.actionId || "",
      at: new Date().toISOString() }, extra || {});
    state.actions = (state.actions || []).slice(-50).concat([rec]);
    if (ok && state.actionId && !(state.appliedActions || []).some(x => x.actionId === state.actionId)) {
      state.appliedActions = (state.appliedActions || []).slice(-200).concat([{
        actionId: state.actionId, decisionId: state.decisionId, action, at: rec.at,
        detail: rec.detail
      }]);
    }
    lib.appendTrace(state, "action." + action, (ok ? "ok " : "fail ") + rec.detail);
    await lib.emit("agent.loop.action", "lead", { case: caseId, loopId: id, round: state.rounds,
      action, ok: !!ok, detail: rec.detail, decisionId: state.decisionId || "", actionId: state.actionId || "",
      extra: extra || {} });
  }
  async function createNeed(kind, title, detail, blocking) {
    return tools.invoke("need.request", { case: caseId, agent: "lead", kind: kind || "info",
      title: String(title || "").slice(0, 300), detail: String(detail || "").slice(0, 2000),
      blocking: blocking !== false }, { actor: "lead", case: caseId, traceId: id });
  }
  await lib.emit("agent.loop.started", "lead", { case: caseId, loopId: id, kind: "lead", objective, mode, maxRounds: roundsLimit, replayOf, resumeOf, autonomy });
  let terminal = false;
  try {
    for (let round = resumeRound; round <= roundsLimit; round++) {
      if (lib.stopRequested(id)) { state.status = "stopped"; lib.appendTrace(state, "stop", "收到停止请求"); break; }
      const cb = await lib.caseBudget(caseId);
      if (cb.exceeded) {
        state.status = "budget_exceeded"; lib.appendTrace(state, "budget", "case token 预算已用尽");
        await lib.emit("agent.loop.budget_exceeded", "lead", { case: caseId, loopId: id, scope: "case",
          tokens: cb.tokens, limit: cb.limit });
        break;
      }
      if (Date.now() - started > maxWallMs) { state.status = "budget_exceeded"; lib.appendTrace(state, "budget", "超过 wall time"); break; }
      state.rounds = round;
      lib.appendTrace(state, "round.started", "第 " + round + "/" + maxRounds + " 轮");
      lib.writeState(state);
      await lib.emit("agent.loop.round.started", "lead", { case: caseId, loopId: id, round, maxRounds });
      const obs = await observe(caseId);
      let decision = null;
      if (mode === "fake") {
        decision = { action: "finish", force: true, reason: "fake lead loop" };
        if (fakeDecisionRaw) { try { decision = JSON.parse(fakeDecisionRaw); } catch (e) {} }
      } else {
        const prompt = decisionPrompt(caseId, objective, round, roundsLimit, obs);
        let r = await runtimeApi.run(runtimeName, "lead", caseId, prompt, id + "-r" + round);
        if (!r.ok) {
          lib.appendTrace(state, "model.retry", "Lead 模型调用失败，重试一次");
          r = await runtimeApi.run(runtimeName, "lead", caseId, prompt, id + "-r" + round + "-retry");
        }
        if (!r.ok) { state.status = "failed"; state.failureKind = "runtime_unavailable"; state.recovery = "fallback_runtime"; state.error = String(r.error || (r.stderr || "").slice(-500) || "lead run failed");
          lib.appendTrace(state, "round.failed", state.error);
          await lib.emit("agent.loop.failed", "lead", { case: caseId, loopId: id, round, error: state.error }); break; }
        const emp = r.employee || {};
        const toolCalls = Array.isArray(emp.toolCalls) ? emp.toolCalls : [];
        for (const t of toolCalls.slice(0, 30)) lib.appendTrace(state, "tool", (t.name || "tool") + " " + (t.callId || ""));
        state.usage.toolCalls += toolCalls.length;
        state.usage.tokens += Number((emp.usage && emp.usage.total) || 0);
        state.usage.wallMs = Date.now() - started;
        decision = lib.parseContract((r.employee && r.employee.answer) || "");
        if (!decision) { state.status = "failed"; state.error = "无法从 Lead 回答中解析决策";
          lib.appendTrace(state, "decision.failed", "无法解析 JSON"); break; }
      }
      state.decision = decision;
      state.usage.wallMs = Date.now() - started;
      lib.appendTrace(state, "decision", JSON.stringify(decision).slice(0, 900));
      lib.writeState(state);
      await lib.emit("agent.loop.decision", "lead", { case: caseId, loopId: id, round, decision, usage: state.usage });
      await lib.emit("agent.loop.budget", "lead", { case: caseId, loopId: id, round, usage: state.usage, budget: state.budget });
      if (state.usage.tokens > maxTokens) { state.status = "budget_exceeded"; lib.appendTrace(state, "budget", "token 超预算"); break; }
      const action = String(decision.action || "finish");
      state.decisionId = id + "-d" + round;
      state.actionId = state.decisionId + "-" + action;
      if ((state.appliedActions || []).some(x => x.actionId === state.actionId)) {
        lib.appendTrace(state, "action.duplicate", "跳过已执行 action " + state.actionId);
        state.status = "done";
        terminal = true;
        break;
      }
      const reason = String(decision.reason || "").slice(0, 500);
      const allowed = ALLOWED_ACTIONS[autonomy] || ALLOWED_ACTIONS.supervised;
      if (allowed.indexOf(action) < 0) {
        await note("blocked_by_autonomy", false, "autonomy=" + autonomy + " 不允许 action=" + action);
        state.status = "waiting_human";
        state.error = "autonomy=" + autonomy + " 不允许 action=" + action;
        await lib.emit("agent.loop.blocked_by_autonomy", "lead", { case: caseId, loopId: id, round,
          autonomy, action, allowed });
        terminal = true;
        break;
      }
      if (action === "finish") {
        const active = await activeWork(caseId);
        if (active.length && decision.force !== true) {
          await note("finish", false, "仍有 " + active.length + " 个活跃 WorkItem，先等待");
          lib.appendTrace(state, "wait", "有活跃任务，暂不 finish");
          await lib.sleep(2000);
          if (round === maxRounds) { state.status = "done_max_rounds"; terminal = true; }
          continue;
        }
        await note("finish", true, reason || "完成");
        state.status = "done"; terminal = true;
      } else if (action === "wait") {
        await note("wait", true, "等待运行中任务");
        await lib.sleep(3000);
        if (round === maxRounds) { state.status = "done_max_rounds"; terminal = true; }
        continue;
      } else if (action === "ask_human") {
        const n = decision.need || {};
        await createNeed(n.kind || "info", n.title || "Lead 需要你确认", n.detail || reason || "", false);
        await note("ask_human", true, n.title || reason || "请求人工确认");
        state.status = "waiting_human"; terminal = true;
      } else if (action === "start_plans") {
        const ids = Array.isArray(decision.planIds) ? decision.planIds : [];
        let okCount = 0;
        for (const pid of ids) {
          try {
            const r = await tools.invoke("plan.start", { case: caseId, id: pid },
              { actor: "lead", case: caseId, traceId: id, approved: true });
            if (r && r.ok) okCount += 1;
            lib.appendTrace(state, "plan.start", pid + " → " + (r && r.ok ? "ok" : "failed"));
          } catch (e) { lib.appendTrace(state, "plan.start.failed", pid + " " + String((e && e.message) || e)); }
        }
        await note("start_plans", okCount === ids.length, "启动 " + okCount + "/" + ids.length + " 个计划");
        lib.writeState(state);
        if (round === maxRounds) { state.status = "done_max_rounds"; terminal = true; }
        if (!terminal) await lib.sleep(2000);
      } else if (action === "create_plan") {
        const p = decision.plan || {};
        const agent = String(p.agent || decision.agent || "industry").slice(0, 20);
        const steps = normSteps(p.steps);
        if (!steps.length) { await note("create_plan", false, "缺少 steps"); state.status = "failed"; state.error = "create_plan 缺少 steps"; terminal = true; }
        else {
          const r = await tools.invoke("plan.create", { case: caseId, agent,
            goal: String(p.goal || reason || "研究计划").slice(0, 300), steps },
            { actor: "lead", case: caseId, traceId: id });
          if (r && r.ok) {
            const plan = (r.result && (r.result.plan || r.result)) || {};
            await note("create_plan", true, "创建计划 " + (plan.id || ""), { planId: plan.id || "" });
          } else { await note("create_plan", false, (r && (r.error || r.status)) || "失败"); state.status = "failed"; state.error = "create_plan 失败"; terminal = true; }
        }
      } else if (action === "revise_plan") {
        const rv = decision.revise || {};
        const planId = String(rv.planId || (decision.planIds || [])[0] || "").slice(0, 40);
        if (!planId) { await note("revise_plan", false, "缺少 planId"); state.status = "failed"; state.error = "revise_plan 缺少 planId"; terminal = true; }
        else {
          const r = await tools.invoke("plan.revise", { case: caseId, planId,
            add: normSteps(rv.add), update: Array.isArray(rv.update) ? rv.update : [],
            remove: Array.isArray(rv.remove) ? rv.remove : [], reason: rv.reason || reason },
            { actor: "lead", case: caseId, traceId: id });
          if (r && r.ok) await note("revise_plan", true, "修订计划 " + planId, { planId });
          else { await note("revise_plan", false, (r && (r.error || r.status)) || "失败"); state.status = "failed"; state.error = "revise_plan 失败"; terminal = true; }
        }
      } else if (action === "assign_task") {
        const t = decision.task || {};
        const nodeId = String(t.nodeId || t.id || ("T" + Date.now().toString(36))).slice(0, 40);
        const agent = String(t.agent || decision.agent || "industry").slice(0, 20);
        const outputs = Array.isArray(t.outputs) ? t.outputs.slice(0, 6) : [];
        const depends = Array.isArray(t.depends) ? t.depends.slice(0, 6) : [];
        const envelope = (t.envelope && typeof t.envelope === "object") ? t.envelope
          : { task: String(t.task || "").slice(0, 1000), outputs, constraints: [] };
        const maxTokens = Math.max(0, Math.round(Number(t.maxTokens) ||
          Number(t.envelope && t.envelope.budget && t.envelope.budget.maxTokens) || 0));
        const r = await tools.invoke("work.create", { case: caseId, planId: t.planId || "",
          nodeId, name: t.name || nodeId, agent, task: String(t.task || "").slice(0, 1000),
          outputs, depends, envelope, maxTokens, failurePolicy: t.failurePolicy || "required" },
          { actor: "lead", case: caseId, traceId: id });
        if (r && r.ok) {
          const w = (r.result && r.result.item) || {};
          await note("assign_task", true, "创建 WorkItem " + (w.id || nodeId), { workId: w.id || "" });
        } else { await note("assign_task", false, (r && (r.error || r.status)) || "失败"); state.status = "failed"; state.error = "assign_task 失败"; terminal = true; }
      } else if (action === "spawn_employee") {
        const sp = decision.spawn || {};
        const workId = String(sp.workId || decision.workId || "").slice(0, 40);
        if (!workId) { await note("spawn_employee", false, "缺少 workId"); state.status = "failed"; state.error = "spawn_employee 缺少 workId"; terminal = true; }
        else {
          const r = await tools.invoke("employee.spawn", { case: caseId, workId,
            agent: String(sp.agent || decision.agent || "industry").slice(0, 20),
            runtime: sp.runtime || "dsh", mode: sp.mode || "real",
            maxRounds: Number(sp.maxRounds) || 3 },
            { actor: "lead", case: caseId, traceId: id });
          if (r && r.ok) await note("spawn_employee", true, "启动 Employee Loop " + ((r.result && r.result.loopId) || ""), { workId, loopId: (r.result && r.result.loopId) || "" });
          else { await note("spawn_employee", false, (r && (r.error || r.status)) || "失败"); state.status = "failed"; state.error = "spawn_employee 失败"; terminal = true; }
        }
      } else if (action === "request_review") {
        const rv = decision.review || {};
        await createNeed("info", "[复核] " + (rv.title || "请复核当前产物"),
          (rv.detail || reason || "") + "\nLead Loop: " + id, true);
        await note("request_review", true, rv.title || "请求复核");
        state.status = "waiting_human"; terminal = true;
      } else if (action === "cancel_task") {
        const c = decision.cancel || {};
        const workId = String(c.workId || decision.workId || "").slice(0, 40);
        if (!workId) { await note("cancel_task", false, "缺少 workId"); state.status = "failed"; state.error = "cancel_task 缺少 workId"; terminal = true; }
        else {
          const approvedNeed = await approvalAnswered(caseId, "[取消审批]", workId);
          const r = await tools.invoke("task.cancel", { case: caseId, id: workId,
            reason: String(c.reason || reason || "").slice(0, 500) },
            { actor: "lead", case: caseId, traceId: id,
              approvalToken: approvedNeed ? "need:" + approvedNeed.id : "" });
          if (r && r.ok) {
            if (approvedNeed) await lib.api("POST", "/api/need/consume", { case: caseId, id: approvedNeed.id, by: "lead" });
            await note("cancel_task", true, "取消 WorkItem " + workId, { workId, approvalNeed: approvedNeed ? approvedNeed.id : "" });
          }
          else if (r && r.status === "pending_approval") {
            await createNeed("other", "[取消审批] " + workId, "Lead 请求取消 WorkItem " + workId + "：" + (c.reason || reason || ""), true);
            await note("cancel_task", false, "等待人工审批", { workId, pendingApproval: true });
            state.status = "waiting_human"; terminal = true;
          } else { await note("cancel_task", false, (r && (r.error || r.status)) || "失败"); state.status = "failed"; state.error = "cancel_task 失败"; terminal = true; }
        }
      } else if (action === "synthesize") {
        const approvedNeed = await approvalAnswered(caseId, "[装配审批]", "");
        const r = await tools.invoke("report.assemble", { case: caseId, by: "lead" },
          { actor: "lead", case: caseId, traceId: id,
            approvalToken: approvedNeed ? "need:" + approvedNeed.id : "" });
        if (r && r.ok) {
          if (approvedNeed) await lib.api("POST", "/api/need/consume", { case: caseId, id: approvedNeed.id, by: "lead" });
          await note("synthesize", true, "报告已装配，未签发", { approvalNeed: approvedNeed ? approvedNeed.id : "" });
          await lib.emit("agent.loop.synthesized", "lead", { case: caseId, loopId: id, round,
            out: (r.result && r.result.out) || "", version: (r.result && r.result.version) || 0, signed: false });
          state.status = "done"; terminal = true;
        } else if (r && r.status === "pending_approval") {
          await createNeed("other", "[装配审批] 最终报告", "Lead 认为可以装配最终报告；只装配、不签发。批准后下一轮 Lead 会执行装配。", true);
          await note("synthesize", false, "等待人工审批装配", { pendingApproval: true });
          state.status = "waiting_human"; terminal = true;
        } else {
          const err = (r && (r.error || (r.result && r.result.error))) || "装配失败";
          await note("synthesize", false, String(err).slice(0, 500));
          await createNeed("other", "[装配失败] 最终报告", String(err).slice(0, 1000), true);
          state.status = "waiting_human"; terminal = true;
        }
      } else {
        state.status = "failed"; state.error = "未知 action：" + action;
        lib.appendTrace(state, "unknown.action", action);
        await note("unknown", false, action);
        terminal = true;
      }
      if (!terminal && round === maxRounds) { state.status = "done_max_rounds"; terminal = true; }
      lib.writeState(state);
      if (terminal) break;
    }
  } catch (e) {
    state.status = "failed"; state.error = String((e && e.message) || e);
    lib.appendTrace(state, "exception", state.error);
  }
  if (state.status === "failed" && !state.failureKind) {
    const err = String(state.error || "");
    if (/token|budget|预算/i.test(err)) { state.failureKind = "budget_exceeded"; state.recovery = "stop"; }
    else if (/parse|json|决策|contract/i.test(err)) { state.failureKind = "invalid_decision"; state.recovery = "repair_decision"; }
    else if (/timeout|timed out|empty|无返回/i.test(err)) { state.failureKind = "model_timeout"; state.recovery = "retry_round"; }
    else { state.failureKind = "action_failed"; state.recovery = "ask_human"; }
  }
  state.usage.wallMs = Date.now() - started;
  if (leaseTimer) clearInterval(leaseTimer);
  if (leaseId) { try { await lib.api("POST", "/api/agent/loop/release", { case: caseId, loopId: id }); } catch (e) {} }
  lib.appendTrace(state, "finished", state.status);
  lib.writeState(state);
  await lib.emit(state.status === "failed" ? "agent.loop.failed" : "agent.loop.finished", "lead",
    { case: caseId, loopId: id, kind: "lead", status: state.status, rounds: state.rounds,
      decision: state.decision, actions: state.actions, usage: state.usage, error: state.error || "",
      failureKind: state.failureKind || "", recovery: state.recovery || "" });
  const ok = state.status === "done";
  console.log(JSON.stringify({ ok, loopId: id, status: state.status, rounds: state.rounds,
    decision: state.decision, actions: state.actions, usage: state.usage, error: state.error || "" }, null, 2));
  process.exit(ok ? 0 : (state.status === "waiting_human" || state.status === "stopped" || state.status === "done_max_rounds" ? 0 : 1));
})();
