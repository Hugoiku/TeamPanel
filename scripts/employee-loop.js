#!/usr/bin/env node
"use strict";
/**
 * employee-loop — 员工级有界 super-agent 循环（支持 runtime adapter / 预算 / 子代理 depth<=1）。
 *
 *   node scripts/employee-loop.js --case c --agent industry --task "..." --max-rounds 3 --mode fake
 *   node scripts/employee-loop.js --case c --agent industry --task "..." --mode real --runtime dsh --max-tokens 80000
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const lib = require("./agent-loop-lib");
const runtimeApi = require("./agent-runtime");
const gateLib = require("./employee-gate");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function contractPrompt(agent, caseId, task, round, maxRounds, prev, work) {
  const envLine = work && work.envelope
    ? "Task Envelope（必须满足的约束，优先于默认习惯）：" + JSON.stringify(work.envelope).slice(0, 3000) : "";
  const workLine = work
    ? "WorkItem：" + work.id + " / " + work.name + "；声明产物：" + JSON.stringify(work.outputs || []) : "";
  return [
    "你是 AlphaDesk 的 " + agent + " 员工。本轮 case：" + caseId + "。",
    "这是一个有界自主循环的第 " + round + "/" + maxRounds + " 轮。任务：" + task,
    workLine, envLine,
    "",
    "工作方式：",
    "1. 先读任务相关文件/记忆（用 ./scripts/desk 或 node scripts/memory.js）；",
    "2. 需要数据/证据时，优先用 data.request / data.collect 工具（走 DataGateway 的配额/幂等/快照）；不要直接调 collect.js 绕开网关；",
    "2.5 需要本 case 已有事实时，用 knowledge.search 检索；只有 status=verified 且 allowedUses 含 report_citation 的知识才能进入报告结论，未验证/仅分析用的只能作探索；不得修改知识权限或提升状态；",
    "3. 数字必须有 [S#] 或明确标注缺口；缺数据用 ./scripts/desk need 上报，不要编造；",
    "4. 每轮结束前，在回答最后放一个 JSON 结果契约（只放一个 JSON 对象）：",
    "{",
    '  "status": "continue|done|blocked",',
    '  "summary": "本轮做了什么",',
    '  "artifacts": ["research/xxx.md"],',
    '  "evidenceIds": ["S1"],',
    '  "openQuestions": ["还没解决的问题"],',
    '  "needs": [{"kind":"data","title":"缺什么","detail":"用来干什么"}],',
    '  "subagents": [{"agent":"stock","task":"窄任务，例如查某公司订单"}],',
    '  "usedKnowledge": ["S1", "M1"],',
    '  "confidence": 0.7',
    "}",
    "如果 status=done，openQuestions/needs 应为空；如果还需要下一轮，status=continue。",
    "子代理只用于窄任务，最多 1 个，不要递归派子代理。",
    "WorkItem 的执行状态由 run-dag 管理；不要用 desk task 自报启动/重复派活，进度写在回答的 JSON 契约里。",
    "如果 data.request 返回 needs_paid_approval / quota_exhausted / rate_limited / circuit_open：不要重试，直接 status=blocked，并把原因写进 openQuestions；付费/配额由人批准，限流/熔断等恢复或换源。",
    prev ? "上一轮契约：" + JSON.stringify(prev).slice(0, 2000) : "",
    "不要修改其他员工的产物；写文件走 ./scripts/desk。"
  ].join(String.fromCharCode(10));
}
(async () => {
  const caseId = arg("case", "");
  const agent = arg("agent", "industry");
  let task = arg("task", "");
  const maxRounds = Math.max(1, Math.min(6, parseInt(arg("max-rounds", "3"), 10) || 3));
  const mode = arg("mode", "fake") === "real" ? "real" : "fake";
  const runtimeName = arg("runtime", "dsh");
  const depth = Math.max(0, parseInt(arg("depth", "0"), 10) || 0);
  const parentLoopId = arg("parent-loop-id", "");
  const maxTokens = Math.max(0, parseInt(arg("max-tokens", "120000"), 10) || 120000);
  const maxWallMs = Math.max(1000, parseInt(arg("max-wall-ms", String(30 * 60 * 1000)), 10) || 30 * 60 * 1000);
  const maxSubagents = Math.max(0, Math.min(2, parseInt(arg("max-subagents", "1"), 10) || 0));
  const fakeContractRaw = arg("fake-contract", "");
  const workId = arg("work-id", "");
  const replayOf = arg("replay-of", "");
  const attach = flag("attach");
  const noFinish = flag("no-finish");
  const skipGate = flag("skip-gate");
  const leaseIdArg = arg("lease-id", "");
  const provider = arg("provider", "");
  const modelName = arg("model", "");
  const effort = arg("effort", "");
  const leaseMs = Math.max(10000, parseInt(arg("lease-ms", "60000"), 10) || 60000);
  const id = arg("loop-id", "") || lib.loopId("employee");
  const owner = arg("owner", "") || (workId ? "loop:" + id : "");
  if (!caseId || (!task && !workId)) { console.error("用法: employee-loop.js --case <c> --agent <a> --task ... [--work-id W1] [--max-rounds 3] [--mode fake|real]"); process.exit(2); }
  const started = Date.now();
  // WorkItem 是员工循环的执行单元：先 claim（或 lease 过期后 resume），再跑循环，最后 finish。
  let work = null;
  if (workId) {
    try {
      const g = await lib.api("GET", "/api/work/item?case=" + encodeURIComponent(caseId) + "&id=" + encodeURIComponent(workId));
      if (g.status !== 200) throw new Error("WorkItem 不存在: " + workId);
      const item0 = g.body.item || {};
      // attach 模式由调度器重新绑定 loop；普通 spawn 仍拒绝冒领已绑定 WorkItem。
      if (!attach && item0.loopId && item0.loopId !== id) throw new Error("WorkItem 已绑定其他 loop: " + item0.loopId);
      const c = await lib.api("POST", "/api/work/claim", { case: caseId, id: workId, owner, loopId: id, leaseMs,
        resume: true, attach, leaseId: leaseIdArg });
      if (c.status !== 200 || !c.body.item) throw new Error("claim 失败: " + ((c.body && (c.body.reason || c.body.error)) || c.status));
      work = c.body.item;
      if (!task) task = work.task || "";
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/budget/i.test(msg)) {
        console.log(JSON.stringify({ ok: false, status: "budget_exceeded", workId, error: msg }, null, 2));
      } else console.error(msg);
      process.exit(1);
    }
  }
  const state = { id, pid: process.pid, case: caseId, kind: "employee", agent, task, mode, runtime: runtimeName,
    depth, parentLoopId, workId, owner, replayOf, status: "running", rounds: 0, maxRounds, trace: [], contract: null,
    envelope: (work && work.envelope) || null, gate: null,
    work: work ? { id: work.id, name: work.name, planId: work.planId, nodeId: work.nodeId,
      outputs: work.outputs || [], envelope: work.envelope || null } : null,
    budget: { maxRounds, maxTokens, maxWallMs, maxSubagents },
    usage: { tokens: 0, toolCalls: 0, subagents: 0, wallMs: 0 },
    subagents: [], createdAt: new Date().toISOString() };
  lib.writeState(state);
  if (workId) process.env.DESK_WORK_ID = workId;
  if (work) lib.appendTrace(state, "work.claimed", work.id + " / " + (work.name || work.nodeId || ""));
  let heartbeatTimer = null, leaseLost = false, cancelRequested = false;
  function startHeartbeat() {
    const every = Math.max(5000, Math.min(15000, Math.floor(leaseMs / 3)));
    heartbeatTimer = setInterval(async () => {
      try {
        const h = await lib.api("POST", "/api/work/heartbeat", { case: caseId, id: workId, owner,
          leaseId: (work && work.leaseId) || "", leaseMs });
        if (h.status === 200) { if (h.body && h.body.cancelRequested) cancelRequested = true; }
        else if (h.status === 409) { leaseLost = true; lib.appendTrace(state, "work.lease_lost", (h.body && h.body.error) || "heartbeat 409"); }
      } catch (e) { lib.appendTrace(state, "work.heartbeat_error", String((e && e.message) || e)); }
    }, every);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }
  async function finishWork() {
    if (!workId || !work) return;
    const ok = state.status === "done";
    const partial = state.status === "done_max_rounds";
    const cancelled = state.status === "stopped" || cancelRequested;
    const needsReview = state.status === "needs_review" || state.status === "waiting_human" || state.status === "budget_exceeded";
    let outputs = [];
    if (ok || partial) {
      const declared = (state.contract && Array.isArray(state.contract.artifacts)) ? state.contract.artifacts : [];
      const wanted = declared.length ? declared : (work.outputs || []);
      for (const o of wanted) {
        const rel = gateLib.outputRel(caseId, o);
        const p = rel ? gateLib.vaultPath(caseId, rel) : "";
        if (p && fs.existsSync(p)) outputs.push(o);
      }
      if (ok && !outputs.length && Array.isArray(work.outputs)) outputs = work.outputs.slice();
    }
    const usedKnowledge = (state.contract && Array.isArray(state.contract.usedKnowledge))
      ? state.contract.usedKnowledge.map(String).slice(0, 50) : [];
    const body = { case: caseId, id: workId, owner, leaseId: work.leaseId || "", ok, partial, cancelled,
      outputs, usedKnowledge, error: state.error || "", needsReview, loopId: id, gate: state.gate || null };
    let rr = { status: 0, body: {} };
    try { rr = await lib.api("POST", "/api/work/finish", body); } catch (e) { rr = { status: 0, body: { error: String(e.message || e) } }; }
    lib.appendTrace(state, "work.finish", rr.status === 200 ? "ok" : ("failed: " + ((rr.body && rr.body.error) || rr.status)));
    await lib.emit("agent.loop.work.finished", agent, { case: caseId, loopId: id, workId,
      ok, partial, cancelled, needsReview, status: state.status, error: state.error || "" });
    lib.writeState(state);
  }
  if (work) startHeartbeat();
  await lib.emit("agent.loop.started", agent, { case: caseId, loopId: id, kind: "employee", agent,
    task: task.slice(0, 500), mode, runtime: runtimeName, depth, parentLoopId, maxRounds,
    workId, replayOf, envelope: (work && work.envelope) || null });
  let prev = null;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (lib.stopRequested(id)) { state.status = "stopped"; lib.appendTrace(state, "stop", "收到停止请求"); break; }
      if (leaseLost) { state.status = "failed"; state.error = "WorkItem lease 丢失，停止执行"; lib.appendTrace(state, "work.lease_lost", state.error); break; }
      if (cancelRequested) { state.status = "stopped"; lib.appendTrace(state, "work.cancel", "WorkItem 已请求取消"); break; }
      const cb = await lib.caseBudget(caseId);
      if (cb.exceeded) {
        state.status = "budget_exceeded"; lib.appendTrace(state, "budget", "case token 预算已用尽");
        await lib.emit("agent.loop.budget_exceeded", agent, { case: caseId, loopId: id, scope: "case",
          tokens: cb.tokens, limit: cb.limit });
        break;
      }
      if (Date.now() - started > maxWallMs) {
        state.status = "budget_exceeded";
        state.error = "wall_time_exceeded: " + Math.round((Date.now() - started) / 1000) + "s > " + Math.round(maxWallMs / 1000) + "s";
        lib.appendTrace(state, "budget", state.error);
        break;
      }
      state.rounds = round;
      lib.appendTrace(state, "round.started", "第 " + round + "/" + maxRounds + " 轮");
      lib.writeState(state);
      await lib.emit("agent.loop.round.started", agent, { case: caseId, loopId: id, round, maxRounds });
      let contract = null, answer = "";
      if (mode === "fake") {
        contract = { status: "done", summary: "fake employee loop", artifacts: [], evidenceIds: [],
          openQuestions: [], needs: [], subagents: [], confidence: 1 };
        if (fakeContractRaw) { try { contract = JSON.parse(fakeContractRaw); } catch (e) {} }
      } else {
        const prompt = contractPrompt(agent, caseId, task, round, maxRounds, prev, work);
        const r = await runtimeApi.run(runtimeName, agent, caseId, prompt, id + "-r" + round,
          { provider, model: modelName, effort });
        answer = (r.employee && r.employee.answer) || "";
        if (!r.ok) {
          state.status = "failed"; state.error = String(r.error || (r.stderr || "").slice(-500) || "employee run failed");
          lib.appendTrace(state, "round.failed", state.error);
          await lib.emit("agent.loop.failed", agent, { case: caseId, loopId: id, round, error: state.error });
          break;
        }
        const emp = r.employee || {};
        const tools = Array.isArray(emp.toolCalls) ? emp.toolCalls : [];
        for (const t of tools.slice(0, 30)) {
          lib.appendTrace(state, "tool", JSON.stringify({ name: t.name || "tool", callId: t.callId || "",
            status: t.status || "", input: t.input || null, result: t.result || "" }).slice(0, 800));
        }
        state.usage.toolCalls += tools.length;
        const toolText = JSON.stringify(tools).slice(0, 20000);
        const blockedCode = ["needs_paid_approval", "quota_exhausted", "rate_limited", "circuit_open"]
          .find(c => toolText.indexOf(c) >= 0);
        if (blockedCode) {
          state.status = "waiting_human";
          state.error = "data_gateway:" + blockedCode;
          lib.appendTrace(state, "data.blocked", state.error);
          await lib.emit("agent.loop.data_blocked", agent, { case: caseId, loopId: id, round, code: blockedCode });
          lib.writeState(state);
          break;
        }
        state.usage.tokens += Number((emp.usage && emp.usage.total) || 0);
        // dsh/employee.js 会自己写 agent.usage；openai 等 adapter 由 loop 补写，保证 case/WorkItem 预算不漏计。
        const u = emp.usage || {};
        if (runtimeName !== "dsh" && Number(u.total || 0) > 0) {
          await lib.emit("agent.usage", agent, { case: caseId, workId, loopId: id, agent,
            stage: id + "-r" + round, inputTokens: Number(u.input || 0), outputTokens: Number(u.output || 0),
            totalTokens: Number(u.total || 0) });
        }
        contract = lib.parseContract(answer);
        if (!contract && String(answer || "").trim()) {
          // 模型偶尔不按格式返回 JSON；不把整轮工作判死，按低置信 done 兜底并留痕。
          contract = { status: "done", summary: String(answer).slice(0, 800), artifacts: [], evidenceIds: [],
            openQuestions: [], needs: [], subagents: [], confidence: 0.3, fallback: true };
          lib.appendTrace(state, "contract.fallback", "模型未返回 JSON 契约，已按 done 兜底");
          await lib.emit("agent.loop.contract_fallback", agent, { case: caseId, loopId: id, round,
            reason: "模型未返回 JSON 契约", answer: String(answer).slice(0, 500) });
        }
        if (!contract) {
          state.status = "failed"; state.error = "无法从员工回答中解析结果契约";
          lib.appendTrace(state, "contract.failed", answer.slice(0, 500));
          await lib.emit("agent.loop.failed", agent, { case: caseId, loopId: id, round, error: state.error });
          break;
        }
      }
      // 确定性输出门禁：模型说 done 不算数，artifact / WorkItem 产物 / evidence / needs 全过才算。
      const gate = skipGate
        ? { ok: true, skipped: true, checks: [], issues: [], status: contract.status || "" }
        : gateLib.check(caseId, contract, { work: { outputs: (work && work.outputs) || [] } });
      state.gate = gate;
      lib.appendTrace(state, "gate", (gate.ok ? "passed" : "failed") + " " +
        (gate.checks || []).map(x => x.id + ":" + (x.ok ? "ok" : "fail")).join(" "));
      await lib.emit("agent.loop.gate", agent, { case: caseId, loopId: id, round, workId,
        ok: gate.ok, status: contract.status || "", issues: gate.issues, checks: gate.checks });
      if (!gate.ok && String(contract.status) === "done") {
        state.contract = contract;
        state.status = "needs_review";
        state.error = "contract_rejected: " + gate.issues.slice(0, 3).join("; ");
        lib.appendTrace(state, "contract.rejected", state.error);
        await lib.emit("agent.loop.contract_rejected", agent, { case: caseId, loopId: id, round, workId,
          error: state.error, issues: gate.issues, gate });
        lib.writeState(state);
        break;
      }
      state.usage.wallMs = Date.now() - started;
      state.contract = contract;
      lib.appendTrace(state, "contract", JSON.stringify(contract).slice(0, 800));
      lib.writeState(state);
      await lib.emit("agent.loop.reflect", agent, { case: caseId, loopId: id, round,
        status: contract.status || "", openQuestions: (contract.openQuestions || []).length,
        needs: (contract.needs || []).length, confidence: contract.confidence,
        usage: state.usage });
      // 子代理：只允许 depth 0 -> 1，最多 maxSubagents 个。
      const subs = Array.isArray(contract.subagents) ? contract.subagents : [];
      if (subs.length) {
        if (depth >= 1) {
          lib.appendTrace(state, "subagent.rejected", "depth>=1，不允许再派子代理");
        } else {
          const room = Math.max(0, maxSubagents - state.usage.subagents);
          for (const s of subs.slice(0, room)) {
            const childAgent = String(s.agent || agent).slice(0, 20);
            const childTask = String(s.task || s.reason || "").slice(0, 1000);
            if (!childTask) continue;
            const childId = lib.loopId("employee");
            lib.appendTrace(state, "subagent.started", childAgent + " " + childTask.slice(0, 120));
            await lib.emit("agent.loop.subagent.started", agent, { case: caseId, loopId: id, childId, childAgent });
            const childArgs = [path.join(__dirname, "employee-loop.js"), "--case", caseId, "--agent", childAgent,
              "--task", childTask, "--mode", mode, "--runtime", runtimeName, "--max-rounds", "1",
              "--depth", String(depth + 1), "--parent-loop-id", id, "--loop-id", childId, "--max-subagents", "0"];
            const cr = spawnSync(process.execPath, childArgs, { cwd: lib.ROOT, encoding: "utf8",
              timeout: maxWallMs, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { DESK_BROKER: lib.BROKER }) });
            let cj = null; try { cj = JSON.parse(String(cr.stdout || "").trim()); } catch (e) {}
            const childState = lib.readState(childId);
            state.subagents.push({ id: childId, agent: childAgent, task: childTask,
              status: (childState && childState.status) || (cj && cj.status) || "failed",
              contract: (childState && childState.contract) || (cj && cj.contract) || null });
            state.usage.subagents += 1;
            lib.appendTrace(state, "subagent.finished", childAgent + " → " + ((childState && childState.status) || "failed"));
            await lib.emit("agent.loop.subagent.finished", agent, { case: caseId, loopId: id, childId,
              childAgent, status: (childState && childState.status) || "failed" });
          }
        }
      }
      state.usage.wallMs = Date.now() - started;
      await lib.emit("agent.loop.budget", agent, { case: caseId, loopId: id, round, usage: state.usage, budget: state.budget });
      lib.writeState(state);
      if (state.usage.tokens > maxTokens) { state.status = "budget_exceeded"; lib.appendTrace(state, "budget", "token 超预算"); break; }
      const workCap = Number(work && work.maxTokens) || 0;
      if (workCap > 0 && state.usage.tokens > workCap) {
        state.status = "budget_exceeded"; state.error = "WorkItem token budget exceeded: " + state.usage.tokens + "/" + workCap;
        lib.appendTrace(state, "budget", state.error);
        await lib.emit("agent.loop.budget_exceeded", agent, { case: caseId, loopId: id, scope: "work",
          workId, tokens: state.usage.tokens, limit: workCap });
        break;
      }
      const open = (contract.openQuestions || []).length;
      const needs = (contract.needs || []).length;
      if (contract.status === "blocked" || needs > 0) {
        state.status = "waiting_human";
        lib.appendTrace(state, "escalated", "员工提出 need/blocked，转人工");
        await lib.emit("agent.loop.escalated", agent, { case: caseId, loopId: id, round,
          reason: contract.status || "needs", needs: contract.needs || [], openQuestions: contract.openQuestions || [] });
        break;
      }
      if (contract.status === "done" || (!open && contract.status !== "continue")) { state.status = "done"; break; }
      prev = contract;
      if (round === maxRounds) { state.status = "done_max_rounds"; break; }
    }
  } catch (e) {
    state.status = "failed"; state.error = String((e && e.message) || e);
    lib.appendTrace(state, "exception", state.error);
  }
  state.usage.wallMs = Date.now() - started;
  lib.appendTrace(state, "finished", state.status);
  lib.writeState(state);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!noFinish) await finishWork();
  await lib.emit(state.status === "failed" ? "agent.loop.failed" : "agent.loop.finished", agent,
    { case: caseId, loopId: id, kind: "employee", agent, status: state.status, rounds: state.rounds,
      contract: state.contract, usage: state.usage, subagents: state.subagents, error: state.error || "",
      workId, gate: state.gate || null });
  const ok = state.status === "done";
  console.log(JSON.stringify({ ok, loopId: id, status: state.status, noFinish: !!noFinish,
    rounds: state.rounds, contract: state.contract, usage: state.usage, subagents: state.subagents,
    workId, gate: state.gate || null, error: state.error || "" }, null, 2));
  process.exit(ok ? 0 : (state.status === "waiting_human" || state.status === "stopped" || state.status === "done_max_rounds" ? 0 : 1));
})();
