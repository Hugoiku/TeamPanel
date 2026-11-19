#!/usr/bin/env node
"use strict";
/**
 * run-dag — 确定性 DAG 调度器（v2：受控并发 + merge + 每节点工作区）
 *
 *   node scripts/run-dag.js --case c --plan PL1 [--dry-run] [--fake]
 *        [--max-concurrency 2] [--fake-ms 1000] [--heartbeat-ms 15000]
 *
 * 默认串行；并发只用于互不依赖的节点。每个节点有独立临时工作区 runtime/work/<workId>/。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BRK = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const OWNER = "dag-" + process.pid;
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) >= 0; }
function apiOnce(method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(BRK + p), payload = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, x => {
      let s = ""; x.on("data", d => s += d);
      x.on("end", () => { let j = {}; try { j = s ? JSON.parse(s) : {}; } catch (e) { j = { raw: s }; } res({ status: x.statusCode, body: j }); });
    });
    r.on("error", rej); if (payload) r.write(payload); r.end();
  });
}
async function api(method, p, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await apiOnce(method, p, body); } catch (e) {
      last = e;
      if (!/ECONNRESET|EPIPE|ECONNREFUSED/.test(String((e && e.code) || e))) break;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}
function buildDag(plan) {
  const steps = (plan.steps || []).map(s => Object.assign({}, s));
  const ids = new Set(steps.map(s => s.id));
  if (ids.size !== steps.length) throw new Error("计划步骤 id 重复");
  steps.forEach((s, i) => {
    if (!s.dependsExplicit && (!Array.isArray(s.depends) || !s.depends.length)) {
      s.depends = i > 0 ? [steps[i - 1].id] : [];
    }
    if (!Array.isArray(s.depends)) s.depends = [];
    s.depends = s.depends.filter(d => d !== s.id);
    const mergeFrom = s.merge_from || s.mergeFrom || [];
    mergeFrom.forEach(d => { if (s.depends.indexOf(d) < 0) s.depends.push(d); });
    s.depends.forEach(d => { if (!ids.has(d)) throw new Error("节点 " + s.id + " 依赖不存在：" + d); });
  });
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));
  const indeg = {}, adj = {};
  steps.forEach(s => { indeg[s.id] = 0; adj[s.id] = []; });
  steps.forEach(s => s.depends.forEach(d => { adj[d].push(s.id); indeg[s.id] += 1; }));
  const q = steps.filter(s => indeg[s.id] === 0).map(s => s.id), order = [];
  while (q.length) {
    const id = q.shift(); order.push(id);
    (adj[id] || []).forEach(n => { indeg[n] -= 1; if (indeg[n] === 0) q.push(n); });
  }
  if (order.length !== steps.length) throw new Error("计划存在循环依赖");
  return { steps, byId, order };
}
function caseDir(caseId) { return String(caseId || "default").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "default"; }
function sessionPath(caseId, agent) { return path.join(ROOT, "runtime/dsh-home", caseDir(caseId), agent, "alphadesk-session.json"); }
function readSession(caseId, agent) { try { return JSON.parse(fs.readFileSync(sessionPath(caseId, agent), "utf8")).sessionId || ""; } catch (e) { return ""; } }
function killTree(c, signal) {
  if (!c || c.killed) return;
  try {
    if (process.platform !== "win32" && c.pid) process.kill(-c.pid, signal || "SIGTERM");
    else c.kill(signal || "SIGTERM");
  } catch (e) { try { c.kill(signal || "SIGTERM"); } catch (x) {} }
}
const CASE = arg("case", "default");
const PLAN_ID = arg("plan", "");
if (!PLAN_ID) { console.error("需要 --plan <PLx>"); process.exit(2); }
const MAX_CONC = Math.max(1, parseInt(arg("max-concurrency", "1"), 10) || 1);
const FAKE = flag("fake");
const FAKE_MS = parseInt(arg("fake-ms", "150"), 10) || 150;
const HB_MS = parseInt(arg("heartbeat-ms", "15000"), 10) || 15000;
let DESK_CFG = {};
try { DESK_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); } catch (e) {}
const LEASE_MS = Math.max(60000, Number((DESK_CFG.scheduler || {}).leaseMs) || 120000);
// 默认让 DAG 节点走 Employee Loop（双层执行）；--no-agent-loop 可回退旧 employee.js。
const USE_LOOP = !flag("no-agent-loop") &&
  (flag("agent-loop") || (!FAKE && (DESK_CFG.scheduler || {}).useAgentLoop !== false));
const LOOP_RUNTIME = arg("loop-runtime", (DESK_CFG.scheduler || {}).agentLoopRuntime || "dsh");
const LOOP_MAX_ROUNDS = Math.max(1, Math.min(4, parseInt(arg("loop-max-rounds", "2"), 10) || 2));
const activeChildren = new Map();
const sessions = {};
const waitLogged = new Set();
function killAllChildren() {
  activeChildren.forEach(c => { try { killTree(c); } catch (e) {} });
  activeChildren.clear();
}
process.on("exit", killAllChildren);
process.on("SIGTERM", () => { killAllChildren(); process.exit(0); });
process.on("SIGINT", () => { killAllChildren(); process.exit(0); });
// macOS: 长任务期间阻止系统空闲休眠/App Nap 打断心跳；退出时 caffeinate -w 自动结束。
try {
  if (process.platform === "darwin") {
    const cp = spawn("caffeinate", ["-i", "-w", String(process.pid)], { cwd: ROOT, detached: true, stdio: "ignore" });
    cp.unref();
  }
} catch (e) {}
async function loadWorkers(caseId) {
  try { const r = await api("GET", "/api/workers?case=" + encodeURIComponent(caseId)); return r.body || {}; }
  catch (e) { return {}; }
}
function chooseAgent(step, plan, reg) {
  if (step.agent) return step.agent;
  const caps = step.capability ? [].concat(step.capability) : [];
  const list = (reg.workers || []).filter(w => w.enabled !== false);
  for (const cap of caps) {
    const hit = list.find(w => (w.capabilities || []).indexOf(cap) >= 0 && (w.free === undefined || w.free > 0));
    if (hit) return hit.agent;
  }
  return plan.agent;
}
let MODEL_CFG = null;
async function loadModelConfig() {
  try {
    const r = await api("GET", "/api/models?case=" + encodeURIComponent(CASE));
    MODEL_CFG = (r.body && r.body.models) || r.body || null;
  } catch (e) { MODEL_CFG = null; }
}
function modelFor(agent) {
  const m = MODEL_CFG || {};
  return (m.byAgent && m.byAgent[agent]) || m.default || null;
}
function runEmployee(agent, step, task, useSession, workId, sessionId, modelCfg) {
  return new Promise(resolve => {
    const cfg = modelCfg || modelFor(agent) || {};
    const provider = cfg.provider || "opencode-go";
    const model = cfg.model || "deepseek-v4.1-flash";
    const effort = cfg.effort || "high";
    const stageId = (modelCfg && modelCfg.stage) || step.id;
    const args = [path.join(ROOT, "runtime/agents/employee.js"), "--agent", agent,
      "--case", CASE, "--stage", stageId, "--provider", provider,
      "--model", model, "--effort", effort, "--task", task];
    if (useSession && sessionId) args.push("--session-id", sessionId, "--short-prompt");
    else if (MAX_CONC === 1 && !modelCfg) args.push("--save-session");
    const c = spawn(process.execPath, args, { cwd: ROOT, detached: process.platform !== "win32",
      env: Object.assign({}, process.env, { DESK_WORK_ID: workId || "" }) });
    activeChildren.set(workId, c);
    let out = "", err = "";
    c.stdout.on("data", d => out += d); c.stderr.on("data", d => err += d);
    c.on("close", code => {
      activeChildren.delete(workId);
      let j = null;
      out.trim().split(/\r?\n/).forEach(line => { try { const x = JSON.parse(line); if (x && x.agent) j = x; } catch (e) {} });
      resolve({ code, out, err, json: j });
    });
  });
}
// DAG 节点交给 Employee Loop 执行：run-dag 已 claim，loop 用同一 owner/lease attach；
// --no-finish 让 WorkItem 生命周期仍由 run-dag 收口（等子任务/汇总/门禁后再 finish）。
function runEmployeeLoop(agent, step, task, item, modelCfg, opts) {
  return new Promise(resolve => {
    const o = opts || {};
    const cfg = modelCfg || modelFor(agent) || {};
    const args = [path.join(ROOT, "scripts/employee-loop.js"), "--case", CASE, "--agent", agent,
      "--task", task, "--work-id", item.id, "--owner", OWNER, "--lease-id", item.leaseId || "",
      "--attach", "--no-finish", "--mode", FAKE ? "fake" : "real",
      "--runtime", FAKE ? "fake" : LOOP_RUNTIME, "--max-rounds", String(o.maxRounds || LOOP_MAX_ROUNDS),
      "--max-subagents", "1",
      "--max-wall-ms", String(Number(item.maxWallMs) || Number((item.envelope && item.envelope.budget && item.envelope.budget.maxWallMs)) || 1800000),
      "--lease-ms", String(LEASE_MS)];
    if (o.skipGate) args.push("--skip-gate");
    if (!FAKE) {
      if (cfg.provider) args.push("--provider", String(cfg.provider));
      if (cfg.model) args.push("--model", String(cfg.model));
      if (cfg.effort) args.push("--effort", String(cfg.effort));
    }
    const c = spawn(process.execPath, args, { cwd: ROOT, detached: process.platform !== "win32",
      env: Object.assign({}, process.env, { DESK_WORK_ID: item.id, DESK_BROKER: BRK }) });
    activeChildren.set(item.id, c);
    let out = "", err = "";
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("close", code => {
      activeChildren.delete(item.id);
      let j = null;
      try { j = JSON.parse(String(out || "").trim()); } catch (e) {
        const lines = String(out || "").trim().split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { const x = JSON.parse(lines[i]); if (x && x.loopId) { j = x; break; } } catch (e2) {}
        }
      }
      resolve({ code, out, err, json: j });
    });
  });
}
function loopOk(r) {
  const j = (r && r.json) || {};
  return !!(r && r.code === 0 && j.status === "done" && !(j.gate && j.gate.ok === false));
}
function loopError(r) {
  const j = (r && r.json) || {};
  const issues = (j.gate && Array.isArray(j.gate.issues)) ? j.gate.issues.join("; ") : "";
  return String(j.error || issues || (r && r.err) ||
    (r && r.code != null ? "exit " + r.code : "employee loop failed")).slice(0, 900);
}
function startHeartbeat(item) {
  if (!item || !item.leaseId) return null;
  try {
    const p = spawn(process.execPath, [path.join(ROOT, "scripts/heartbeat.js"),
      "--case", CASE, "--work", item.id, "--owner", OWNER, "--lease", item.leaseId,
      "--parent-pid", String(process.pid), "--interval", String(Math.max(5000, HB_MS)),
      "--lease-ms", String(LEASE_MS)],
      { cwd: ROOT, detached: false, stdio: "ignore",
        env: Object.assign({}, process.env, { DESK_BROKER: BRK }) });
    p.on("error", () => {});
    return p;
  } catch (e) { return null; }
}
function stageSafe(s) { return String(s || "stage").replace(/[^a-zA-Z0-9_.-]/g, "_"); }
function stageSha(obj) { return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex"); }
async function stageStart(item, step, stageId, modelCfg) {
  try {
    await api("POST", "/api/event", { case: CASE, type: "stage.started", lane: item.agent,
      actor: item.agent, agent: item.agent, workId: item.id, planId: item.planId,
      nodeId: step.id, stageId: stageId, provider: (modelCfg && modelCfg.provider) || "opencode-go",
      model: (modelCfg && modelCfg.model) || "deepseek-v4.1-flash" });
  } catch (e) {}
}
async function stageFinish(item, step, stageId, modelCfg, startedAt, ok, err, extra) {
  const x = extra || {};
  const workDir = path.join(ROOT, "runtime/work", item.id);
  fs.mkdirSync(workDir, { recursive: true });
  startHeartbeat(item);
  const base = stageSafe(stageId);
  const artifactPath = path.join(workDir, base + ".artifact.json");
  const gatePath = path.join(workDir, base + ".gate.json");
  const finishedAt = Date.now();
  const artifact = { stageId: stageId, workId: item.id, planId: item.planId, nodeId: step.id,
    agent: item.agent, provider: (modelCfg && modelCfg.provider) || "opencode-go",
    model: (modelCfg && modelCfg.model) || "deepseek-v4.1-flash",
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
    ms: finishedAt - startedAt, ok: !!ok, error: ok ? "" : String(err || "").slice(0, 800),
    loopId: x.loopId || "", loopStatus: x.status || "", employeeGate: x.gate || null };
  const sha = stageSha(artifact);
  const gate = { stageId: stageId, status: ok ? "passed" : "failed", sha256: sha,
    checks: [{ name: "employee_exit", ok: !!ok }, { name: "artifact_written", ok: !!ok }]
      .concat(x.gate ? [{ name: "employee_gate", ok: !!x.gate.ok }] : []),
    loopId: x.loopId || "", finishedAt: artifact.finishedAt };
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(gatePath, JSON.stringify(gate, null, 2));
  const relArtifact = path.relative(ROOT, artifactPath);
  const relGate = path.relative(ROOT, gatePath);
  try {
    await api("POST", "/api/event", { case: CASE, type: "stage.artifact", lane: item.agent, actor: item.agent,
      agent: item.agent, workId: item.id, planId: item.planId, nodeId: step.id, stageId: stageId,
      provider: artifact.provider, model: artifact.model, artifact: relArtifact, gate: relGate,
      sha256: sha, ms: artifact.ms, ok: !!ok, loopId: x.loopId || "", loopStatus: x.status || "" });
    await api("POST", "/api/event", { case: CASE, type: ok ? "stage.gate.passed" : "stage.gate.failed",
      lane: item.agent, actor: item.agent, agent: item.agent, workId: item.id, planId: item.planId,
      nodeId: step.id, stageId: stageId, artifact: relArtifact, gate: relGate, sha256: sha,
      error: ok ? "" : String(err || "").slice(0, 300) });
  } catch (e) {}
}
async function waitChildren(item, timeoutMs) {
  const end = Date.now() + (timeoutMs || 600000);
  while (Date.now() < end) {
    try {
      const r = await api("GET", "/api/work/children?case=" + encodeURIComponent(CASE) + "&parentWorkId=" + encodeURIComponent(item.id));
      const kids = (r.body && r.body.items) || [];
      if (!kids.length) return [];
      if (kids.every(k => k.state === "done" || k.state === "failed" || k.state === "cancelled")) return kids;
    } catch (e) {}
    try { await api("POST", "/api/work/heartbeat", { case: CASE, id: item.id, owner: OWNER,
      leaseId: item.leaseId, leaseMs: LEASE_MS }); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return [];
}
async function executeItem(item, step) {
  let cancelFlag = false;
  const workDir = path.join(ROOT, "runtime/work", item.id);
  fs.mkdirSync(workDir, { recursive: true });
  startHeartbeat(item);
  try { fs.writeFileSync(path.join(workDir, "case.json"), JSON.stringify({ case: CASE, workId: item.id })); } catch (e) {}
  const mergeFrom = step.merge_from || step.mergeFrom || [];
  let task = "【" + step.id + " " + (step.name || "") + "】" + (step.task || "");
  task += "\n本节点临时工作区：runtime/work/" + item.id + "/；需要分享的中间产物写这里，最终底稿/证据再按任务要求写。";
  if (mergeFrom.length) task = "【合并节点】汇总分支 " + mergeFrom.join("、") + " 的产物。" + task;
  const hb = setInterval(async function () {
    try {
      const r = await api("POST", "/api/work/heartbeat", { case: CASE, id: item.id, owner: OWNER,
        leaseId: item.leaseId, leaseMs: LEASE_MS });
      if (r.body && r.body.cancelRequested) {
        cancelFlag = true;
        console.log("[work] " + item.nodeId + " 收到取消请求，终止子进程");
        const child = activeChildren.get(item.id);
        if (child) killTree(child);
      }
    } catch (e) {}
  }, HB_MS);
  let ok = true, cancelled = false, errText = "", loopInfo = null;
  try {
    const chain0 = Array.isArray(step.modelChain) ? step.modelChain : [];
    if (USE_LOOP && !chain0.length) {
      const singleModel = Object.assign({ stage: step.id },
        modelFor(item.agent) || { provider: "opencode-go", model: "deepseek-v4.1-flash" });
      const startedAt = Date.now();
      await stageStart(item, step, step.id, singleModel);
      const r = await runEmployeeLoop(item.agent, step, task, item, singleModel);
      const j = r.json || {};
      loopInfo = { loopId: j.loopId || "", status: j.status || "", gate: j.gate || null,
        contract: j.contract || null, usage: j.usage || null };
      ok = loopOk(r);
      if (!ok) errText = loopError(r);
      await stageFinish(item, step, step.id, singleModel, startedAt, ok, errText, loopInfo);
    } else if (USE_LOOP && chain0.length) {
      for (let ci = 0; ci < chain0.length; ci++) {
        const mc = chain0[ci];
        const stageId = step.id + "." + String(mc.id || ("M" + (ci + 1)));
        const stageTask = "【阶段 " + (ci + 1) + "/" + chain0.length + "：" +
          (mc.id || "model") + "】" + (mc.task || "") + String.fromCharCode(10) + task;
        console.log("[chain] " + item.nodeId + " → " + stageId + " · " +
          ((mc.provider || "?") + "/" + (mc.model || "?")));
        const startedAt = Date.now();
        await stageStart(item, step, stageId, mc);
        const r = await runEmployeeLoop(item.agent, step, stageTask, item,
          Object.assign({}, mc, { stage: stageId }), { maxRounds: 1, skipGate: ci < chain0.length - 1 });
        const j = r.json || {};
        loopInfo = { loopId: j.loopId || "", status: j.status || "", gate: j.gate || null,
          contract: j.contract || null, usage: j.usage || null };
        ok = loopOk(r);
        if (!ok) {
          errText = loopError(r);
          await stageFinish(item, step, stageId, mc, startedAt, false, errText, loopInfo);
          break;
        }
        await stageFinish(item, step, stageId, mc, startedAt, true, "", loopInfo);
      }
    } else if (FAKE) {
      await new Promise(r => setTimeout(r, FAKE_MS));
    } else {
      if (USE_LOOP && chain0.length) console.log("[loop] " + item.nodeId + " 使用 modelChain，回退 employee.js");
      const useSession = MAX_CONC === 1;
      const sid = sessions[item.agent] || readSession(CASE, item.agent);
      const chain = chain0;
      if (chain.length) {
        for (let ci = 0; ci < chain.length; ci++) {
          const mc = chain[ci];
          const stageId = step.id + "." + String(mc.id || ("M" + (ci + 1)));
          const stageTask = "【阶段 " + (ci + 1) + "/" + chain.length + "：" +
            (mc.id || "model") + "】" + (mc.task || "") + String.fromCharCode(10) + task;
          console.log("[chain] " + item.nodeId + " → " + stageId + " · " +
            ((mc.provider || "?") + "/" + (mc.model || "?")));
          const startedAt = Date.now();
          await stageStart(item, step, stageId, mc);
          const r = await runEmployee(item.agent, step, stageTask, false, item.id, null,
            Object.assign({}, mc, { stage: stageId }));
          ok = r.code === 0 && (!r.json || r.json.ok !== false);
          if (!ok) {
            errText = String((r.json && (r.json.error || r.json.answer)) || r.err ||
              ("exit " + (r.code == null ? "?" : r.code))).slice(0, 900);
            await stageFinish(item, step, stageId, mc, startedAt, false, errText);
            break;
          }
          await stageFinish(item, step, stageId, mc, startedAt, true, "");
        }
      } else {
        const singleModel = { stage: step.id, provider: "opencode-go", model: "deepseek-v4.1-flash" };
        const startedAt = Date.now();
        await stageStart(item, step, step.id, singleModel);
        const r = await runEmployee(item.agent, step, task, useSession, item.id, sid);
        ok = r.code === 0 && (!r.json || r.json.ok !== false);
        if (MAX_CONC === 1 && r.json && r.json.sessionId) sessions[item.agent] = r.json.sessionId;
        if (!ok) errText = String((r.json && (r.json.error || r.json.answer)) || r.err ||
          ("exit " + (r.code == null ? "?" : r.code))).slice(0, 900);
        await stageFinish(item, step, step.id, singleModel, startedAt, ok, errText);
      }
    }
  } finally { clearInterval(hb); }
  const policy = step.failurePolicy || item.failurePolicy || "required";
  const hb2 = setInterval(async function () {
    try { await api("POST", "/api/work/heartbeat", { case: CASE, id: item.id, owner: OWNER,
      leaseId: item.leaseId, leaseMs: LEASE_MS }); } catch (e) {}
  }, HB_MS || 30000);
  const kids = await waitChildren(item);
  let childSummary = "";
  if (kids.length) {
    const rows = kids.map(k => {
      let result = null;
      try { result = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/work", k.id, "result.json"), "utf8")); } catch (e) {}
      return { id: k.id, nodeId: k.nodeId, name: k.name, state: k.state, partial: !!k.partial,
        tokens: k.tokens || 0, error: k.error || "", result };
    });
    try { fs.writeFileSync(path.join(workDir, "children.json"), JSON.stringify(rows, null, 2)); } catch (e) {}
    const nl = String.fromCharCode(10);
    const input = rows.map(r => "### " + (r.name || r.id) + nl + "状态：" + r.state + (r.error ? nl + "错误：" + r.error : "") +
      nl + "结果：" + ((r.result && (r.result.answer || r.result.error)) || "（无文本结果，请读子任务 result.json）")).join(nl + nl);
    const synthTask = "【父任务子结果汇总】以下是并行子任务的结果。请核对、去重、统一口径，合并成父任务结论；不要编造子任务没有提供的数据。" +
      nl + task + nl + "子任务结果：" + nl + input;
    const sr = await runEmployee(item.agent, step, synthTask, false, item.id, null,
      { stage: "SYNTH-" + item.id, provider: "opencode-go", model: "deepseek-v4.1-flash" });
    if (sr.code === 0) {
      let ans2 = (sr.json && sr.json.answer) || "";
      if (!ans2) {
        try { const jj = JSON.parse(String(sr.out || "").trim()); ans2 = jj.answer || ""; } catch (e) {}
        if (!ans2) { const a3 = String(sr.out || "").indexOf("{"), b3 = String(sr.out || "").lastIndexOf("}"); if (a3 >= 0 && b3 > a3) { try { const jj = JSON.parse(String(sr.out).slice(a3, b3 + 1)); ans2 = jj.answer || ""; } catch (e) {} } }
      }
      childSummary = String(ans2 || sr.out || "").trim().slice(0, 4000);
    }
    if (sr.code !== 0) errText = errText || "子任务汇总失败";
    if (childSummary) { try { fs.writeFileSync(path.join(workDir, "children.summary.md"), childSummary); } catch (e) {} }
  }
  clearInterval(hb2);
  const childFailed = kids.some(k => k.state === "failed" || k.state === "cancelled");
  if (childFailed) {
    const msg = "子任务失败：" + kids.filter(k => k.state === "failed" || k.state === "cancelled").map(k => k.id).join(",");
    errText = errText || msg;
    if (policy === "required") ok = false;
  }
  const partial = (!ok || childFailed) && !cancelFlag && policy !== "required";
  const fin = await api("POST", "/api/work/finish", { case: CASE, id: item.id, owner: OWNER,
    leaseId: item.leaseId, ok: ok && !cancelFlag, partial, cancelled: cancelFlag,
    error: cancelFlag ? "cancelled" : errText, outputs: step.outputs || [],
    gate: loopInfo ? loopInfo.gate : null, loopId: loopInfo ? loopInfo.loopId : "",
    needsReview: !!(USE_LOOP && !ok && !cancelFlag) });
  if (cancelFlag) return { ok: false, cancelled: true };
  if (fin.status === 409) { console.error("[work] finish 被拒绝：" + JSON.stringify(fin.body)); return { ok: false, stale: true }; }
  return { ok: ok || partial, partial, cancelled, error: errText || "" };
}
(async () => {
  const pl = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
  const plan = ((pl.body && pl.body.plans) || []).find(x => x.id === PLAN_ID);
  if (!plan) { console.error("找不到计划 " + PLAN_ID); process.exit(3); }
  if (plan.status !== "approved") { console.error("计划状态是 " + plan.status + "，需要先审批"); process.exit(4); }
  await loadModelConfig();
  const dag = buildDag(plan);
  const workerReg = await loadWorkers(CASE);
  console.log("[dag] " + dag.steps.length + " 个节点 · 并发 " + MAX_CONC + " · 拓扑：" + dag.order.join(" → "));
  if (flag("dry-run")) {
    dag.steps.forEach(s => console.log("  " + s.id + " ← [" + (s.depends || []).join(",") + "] " + (s.name || "")));
    process.exit(0);
  }
  for (const s of dag.steps) {
    const r = await api("POST", "/api/work/create", { case: CASE, planId: PLAN_ID, nodeId: s.id,
      agent: chooseAgent(s, plan, workerReg), name: s.name, task: s.task, depends: s.depends, tier: s.tier,
      outputs: s.outputs || [], mergeFrom: s.merge_from || s.mergeFrom || [],
      modelChain: s.modelChain || [], failurePolicy: s.failurePolicy || "required",
      maxTokens: s.maxTokens || (s.envelope && s.envelope.budget && s.envelope.budget.maxTokens) || 0,
      waitForPlans: Array.isArray(s.waitForPlans) ? s.waitForPlans : [],
      envelope: s.envelope || null,
      traceId: PLAN_ID, by: "dag" });
    if (r.status !== 200) { console.error("创建 WorkItem 失败", s.id, JSON.stringify(r.body)); process.exit(5); }
  }
  async function fetchItems() {
    const all = await api("GET", "/api/work?case=" + encodeURIComponent(CASE));
    return (((all.body && all.body.items) || []).filter(x => x.planId === PLAN_ID && x.kind !== "child"));
  }
  function failAndExit(items) {
    if (items.some(x => x.state === "failed")) {
      console.error("[dag] 存在失败节点，停止");
      return 6;
    }
    if (items.some(x => x.state === "cancelled")) {
      console.error("[dag] 存在取消节点，停止");
      return 9;
    }
    return 0;
  }
  if (MAX_CONC === 1) {
    while (true) {
      const items = await fetchItems();
      if (items.every(x => x.state === "done")) {
        console.log("[dag] 全部完成 · " + items.length + " 个节点");
        break;
      }
      const bad = failAndExit(items);
      if (bad) process.exit(bad);
      const claim = await api("POST", "/api/work/claim", { case: CASE, owner: OWNER,
        maxConcurrency: 1, leaseMs: LEASE_MS });
      const item = claim.body && claim.body.item;
      if (!item) {
        if (claim.body && claim.body.reason === "paused") {
          console.log("[dag] case 已暂停，等待恢复…");
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (claim.body && claim.body.reason === "budget") {
          const runningB = items.some(x => x.state === "running" || x.state === "cancelling");
          if (runningB) { await new Promise(r => setTimeout(r, 1000)); continue; }
          console.error("[dag] case token 预算不足：" + JSON.stringify(claim.body));
          process.exit(10);
        }
        if (claim.body && claim.body.reason === "upstream-failed") {
          console.error("[dag] 上游计划失败，停止：" + JSON.stringify(claim.body));
          process.exit(6);
        }
        if (claim.body && claim.body.reason === "waiting-upstream") {
          const key = (claim.body.plans || []).join(",");
          if (!waitLogged.has(key)) { waitLogged.add(key); console.log("[dag] 等待上游计划完成：" + key); }
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const running = items.some(x => x.state === "running" || x.state === "cancelling");
        if (!running) {
          console.error("[dag] 没有就绪节点（依赖未满足/重试退避/环）");
          process.exit(7);
        }
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      console.log("[work] " + item.id + " " + item.nodeId + " " + (item.name || "") + " 开始");
      const r = await executeItem(item, dag.byId[item.nodeId]);
      if (r.stale) process.exit(8);
      if (r.cancelled) process.exit(9);
      if (!r.ok) { console.error("[work] " + item.id + " 失败：" + String(r.error || "unknown").slice(0, 500)); process.exit(6); }
    }
  } else {
    let stop = false;
    async function worker() {
      while (!stop) {
        const items = await fetchItems();
        if (items.every(x => x.state === "done")) return;
        if (items.some(x => x.state === "failed" || x.state === "cancelled")) { stop = true; return; }
        const claim = await api("POST", "/api/work/claim", { case: CASE, planId: PLAN_ID, owner: OWNER,
          maxConcurrency: MAX_CONC, leaseMs: LEASE_MS });
        const item = claim.body && claim.body.item;
        if (!item) {
          if (claim.body && claim.body.reason === "paused") {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          if (claim.body && claim.body.reason === "budget") {
            if (items.some(x => x.state === "running" || x.state === "cancelling")) {
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            console.error("[dag] case token 预算不足：" + JSON.stringify(claim.body));
            process.exit(10);
          }
          if (claim.body && claim.body.reason === "upstream-failed") {
            console.error("[dag] 上游计划失败，停止：" + JSON.stringify(claim.body));
            process.exit(6);
          }
          if (claim.body && claim.body.reason === "waiting-upstream") {
            const key = (claim.body.plans || []).join(",");
            if (!waitLogged.has(key)) { waitLogged.add(key); console.log("[dag] 等待上游计划完成：" + key); }
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          if (!items.some(x => x.state === "running" || x.state === "cancelling")) return;
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        console.log("[work] " + item.id + " " + item.nodeId + " " + (item.name || "") + " 开始");
        const r = await executeItem(item, dag.byId[item.nodeId]);
        if (!r.ok) { console.error("[work] " + item.id + " 失败：" + String(r.error || "unknown").slice(0, 500)); stop = true; return; }
      }
    }
    await Promise.all(Array.from({ length: MAX_CONC }, worker));
    const items = await fetchItems();
    if (items.every(x => x.state === "done")) console.log("[dag] 全部完成 · " + items.length + " 个节点");
    else process.exit(failAndExit(items) || 7);
  }
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
