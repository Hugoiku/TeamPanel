#!/usr/bin/env node
"use strict";
/**
 * run-plan — 执行某个员工已审批的计划（同一 DSH 会话，按步骤换模型）
 *
 *   node scripts/run-plan.js --case case-2026-003 --plan PL1 [--dry-run]
 *
 * 每步：写 runtime/profiles/<agent>.<step>.yml（provider/model 来自 config.models.routes[tier]）
 *       → 调 runtime/agents/employee.js（--session-id 续跑，第一步创建会话）
 *       → 账本 agent.step.started/finished + agent.usage
 *       → 累计 tokens，超过 80% 窗口就写记忆 state + 开新会话（memory.checkpoint）
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
      if (!/ECONNRESET|EPIPE|ECONNREFUSED/.test(String((e && e.code) || e))) break;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}
const CASE = arg("case", "default");
const PLAN_ID = arg("plan", "");
if (!PLAN_ID) { console.error("需要 --plan <PLx>"); process.exit(2); }
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); } catch (e) { return {}; } })();
const ROUTES = ((CFG.models || {}).routes) || {};
const CHECKPOINT_PCT = Number((CFG.memory || {}).checkpointPct || 0.8);
function routeOf(tier) { return ROUTES[tier] || ROUTES.fast || { provider: "opencode-go", model: "deepseek-v4.1-flash" }; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const pl = await api("GET", "/api/plans?case=" + encodeURIComponent(CASE));
  const plan = ((pl.body && pl.body.plans) || []).find(x => x.id === PLAN_ID);
  if (!plan) { console.error("找不到计划 " + PLAN_ID); process.exit(3); }
  if (plan.status !== "approved") { console.error("计划状态是 " + plan.status + "，需要先审批通过"); process.exit(4); }
  // 上下文窗口：优先模型目录里的 ctx
  let ctx = 128000;
  try {
    const ms = await api("GET", "/api/models?case=" + encodeURIComponent(CASE));
    const def = (ms.body && (ms.body.byAgent || {})[plan.agent]) || (ms.body && ms.body.default);
    const cat = ((ms.body && ms.body.catalog) || []).find(m => def && m.provider === def.provider && m.model === def.model);
    if (cat && cat.ctx) ctx = cat.ctx;
  } catch (e) {}
  const budget = Math.round(ctx * CHECKPOINT_PCT);
  console.log("[run-plan] " + PLAN_ID + " · " + plan.agent + " · " + plan.steps.length + " 步 · ctx " + ctx + " · checkpoint@" + budget);
  const LIMIT = parseInt(arg("limit", "0"), 10);
  const ONLY = String(arg("steps", "") || "").split(",").map(x => x.trim()).filter(Boolean);
  let sessionId = "";
  let totalTokens = 0;
  let runCount = 0;
  for (let i = 0; i < plan.steps.length; i++) {
    if (LIMIT && i >= LIMIT) { console.log("[run-plan] 已按 --limit " + LIMIT + " 停止"); break; }
    const s = plan.steps[i];
    if (ONLY.length && ONLY.indexOf(s.id) < 0) { console.log("[skip] " + s.id + " " + s.name); continue; }
    var r = routeOf(s.tier);
    if (s.model && String(s.model).indexOf("/") > 0) {
      const parts = String(s.model).split("/");
      r = { provider: parts[0], model: parts.slice(1).join("/") };
    }
    const args = [path.join(ROOT, "runtime/agents/employee.js"), "--agent", plan.agent, "--case", CASE,
      "--task", "【" + s.id + " " + s.name + "】" + s.task + (s.outputs && s.outputs.length ? "（产出：" + s.outputs.join("、") + "）" : ""),
      "--provider", r.provider, "--model", r.model, "--stage", s.id];
    if (runCount > 0) args.push("--short-prompt");
    if (sessionId) args.push("--session-id", sessionId);
    if (runCount === 0) args.push("--save-session");
    var effort = r.effort || (s.tier === "fast" ? "low" : (s.tier === "verify" ? "medium" : "medium"));
    args.push("--effort", effort);
    console.log("[step " + (i + 1) + "/" + plan.steps.length + "] " + s.id + " " + s.name + " · " + r.model +
      " · session=" + (sessionId ? sessionId.slice(0, 18) + "…" : (i === 0 ? "new" : "复用上一步")));
    if (flag("dry-run")) { if (runCount === 0) sessionId = "session-<created>"; runCount++; continue; }
    const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 25 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    let out = null;
    const lines = String(res.stdout || "").trim().split("\n");
    for (let k = lines.length - 1; k >= 0; k--) { try { out = JSON.parse(lines[k]); break; } catch (e) {} }
    if (!out || !out.ok) {
      console.error("[step] 失败：", (out && out.answer) || String(res.stderr || "").slice(-400));
      await api("POST", "/api/plan/progress", { case: CASE, id: PLAN_ID, step: s.id, status: "failed", by: plan.agent });
      process.exit(5);
    }
    runCount += 1;
    sessionId = out.sessionId || "";
    totalTokens += (out.usage && out.usage.total) || 0;
    await api("POST", "/api/plan/progress", { case: CASE, id: PLAN_ID, step: s.id,
      status: "running", sessionId, by: plan.agent });
    console.log("  ok · tokens +" + ((out.usage && out.usage.total) || 0) + " · 累计 " + totalTokens + " / " + budget);
    if (totalTokens >= budget) {
      const stateFile = "/tmp/memory-state-" + CASE + "-" + plan.agent + ".json";
      fs.writeFileSync(stateFile, JSON.stringify({ planId: PLAN_ID, agent: plan.agent, lastStep: s.id,
        sessionId, totalTokens, contextWindow: ctx, note: "上下文达到 " + Math.round(totalTokens / ctx * 100) + "%，开新会话继续" }, null, 2));
      const cp = spawnSync(process.execPath, [path.join(ROOT, "scripts/memory.js"), "checkpoint",
        "--case", CASE, "--agent", plan.agent, "--state", stateFile], { cwd: ROOT, encoding: "utf8" });
      console.log("  [memory.checkpoint] " + String(cp.stdout || "").trim().slice(0, 200));
      await api("POST", "/api/event", { case: CASE, type: "memory.checkpoint", actor: plan.agent,
        agent: plan.agent, planId: PLAN_ID, step: s.id, sessionId, totalTokens, contextWindow: ctx });
      sessionId = "";
      totalTokens = 0;
    }
  }
  if (!flag("dry-run")) {
    await api("POST", "/api/plan/progress", { case: CASE, id: PLAN_ID, step: "done", status: "done", by: plan.agent });
    console.log("[run-plan] 完成 · " + plan.steps.length + " 步");
  } else {
    console.log("[run-plan] dry-run：未调用模型");
  }
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
