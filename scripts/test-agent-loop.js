#!/usr/bin/env node
"use strict";
/**
 * test-agent-loop — 双层 Agent Loop / Tool Gateway 验收（不调用模型）。
 *   node scripts/test-agent-loop.js
 * 需要 broker 运行；fake 模式只验证循环状态机、契约、账本事件，不跑 DSH。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const CASE = "__tmp_agentloop_" + Date.now().toString(36) + "__";
let passed = 0, failed = 0;
function ok(name, fn) { try { fn(); passed++; console.log("  PASS " + name); } catch (e) { failed++; console.log("  FAIL " + name + " :: " + String((e && e.message) || e)); } }
function pass(m) { passed++; console.log("  PASS " + m); }
function fail(m) { failed++; console.log("  FAIL " + m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j || {} };
}
function cleanup() {
  try { fs.rmSync(path.join(ROOT, "vault", CASE), { recursive: true, force: true }); } catch (e) {}
  try {
    for (const f of fs.readdirSync(path.join(ROOT, "runtime/agent-loops"))) {
      if (!/\.json$/.test(f)) continue;
      const p = path.join(ROOT, "runtime/agent-loops", f);
      try { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j.case === CASE) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}
(async () => {
  const lib = require("./agent-loop-lib");
  const tools = require("./tool-gateway");
  console.log("=== 契约解析 ===");
  ok("解析裸 JSON 契约", () => {
    const c = lib.parseContract('done\n{"status":"done","openQuestions":[]}');
    if (!c || c.status !== "done") throw new Error("parse failed");
  });
  ok("解析代码块契约", () => {
    const c = lib.parseContract('x\n\u0060\u0060\u0060json\n{"status":"continue","openQuestions":["a"]}\n\u0060\u0060\u0060');
    if (!c || c.status !== "continue" || c.openQuestions.length !== 1) throw new Error("parse failed");
  });
  console.log("=== Tool Gateway ===");
  ok("Agent Runtime 适配层包含 dsh/openai/fake", () => {
    const rt = require("./agent-runtime").list().map(x => x.name);
    ["dsh", "openai", "fake"].forEach(n => { if (rt.indexOf(n) < 0) throw new Error("runtime 列表缺少 " + n); });
  });
  ok("工具目录包含数据/缺口/计划/报告工具", () => {
    const names = tools.catalog().map(x => x.name);
    ["case.snapshot", "data.preflight", "data.collect", "need.request", "plan.start", "report.freshness"].forEach(n => {
      if (names.indexOf(n) < 0) throw new Error("缺少工具 " + n);
    });
  });
  ok("高风险工具默认返回 pending_approval", async () => {
    // 该断言在下方 async 场景里做，这里只检查 catalog 标记
    const p = tools.catalog().find(x => x.name === "plan.start");
    if (!p || p.highRisk !== true) throw new Error("plan.start 未标记高风险");
  });

  try {
    const h = await api("GET", "/api/health");
    if (!h.body || !h.body.ok) { console.log("SKIP broker 未启动，跳过 fake 循环集成测试"); }
    else {
      await api("POST", "/api/case", { case: CASE, name: CASE, uniqueId: false });
      const emp = spawnSync(process.execPath, [path.join(ROOT, "scripts/employee-loop.js"), "--case", CASE,
        "--agent", "industry", "--task", "fake", "--mode", "fake", "--max-rounds", "2"],
        { cwd: ROOT, encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { DESK_BROKER: BASE }) });
      let ej = null; try { ej = JSON.parse(String(emp.stdout || "").trim()); } catch (e) {}
      if (ej && ej.status === "done") pass("employee-loop fake 状态 done"); else fail("employee-loop fake 失败：" + String(emp.stdout || "").slice(0, 200));
      const sub = spawnSync(process.execPath, [path.join(ROOT, "scripts/employee-loop.js"), "--case", CASE,
        "--agent", "industry", "--task", "fake parent", "--mode", "fake", "--max-rounds", "1",
        "--max-subagents", "1", "--fake-contract", JSON.stringify({ status: "done", artifacts: [], evidenceIds: [],
          openQuestions: [], needs: [], subagents: [{ agent: "stock", task: "fake child" }], confidence: 1 })],
        { cwd: ROOT, encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { DESK_BROKER: BASE }) });
      let sj = null; try { sj = JSON.parse(String(sub.stdout || "").trim()); } catch (e) {}
      if (sj && sj.usage && sj.usage.subagents === 1 && (sj.subagents || []).length === 1) pass("employee 子代理 depth<=1 可运行");
      else fail("employee 子代理失败：" + String(sub.stdout || "").slice(0, 300));
      const lead = spawnSync(process.execPath, [path.join(ROOT, "scripts/lead-loop.js"), "--case", CASE,
        "--objective", "fake", "--mode", "fake", "--max-rounds", "2"],
        { cwd: ROOT, encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { DESK_BROKER: BASE }) });
      let lj = null; try { lj = JSON.parse(String(lead.stdout || "").trim()); } catch (e) {}
      if (lj && lj.status === "done") pass("lead-loop fake 状态 done"); else fail("lead-loop fake 失败：" + String(lead.stdout || "").slice(0, 200));

      const start = await api("POST", "/api/agent/loop", { case: CASE, kind: "lead", mode: "fake", maxRounds: 1, objective: "fake" });
      if (start.status === 200 && start.body.loopId) pass("POST /api/agent/loop 返回 loopId");
      else fail("启动 loop 失败：" + JSON.stringify(start.body).slice(0, 200));
      await sleep(1200);
      const list = await api("GET", "/api/agent/loops?case=" + encodeURIComponent(CASE));
      if ((list.body.loops || []).some(x => x.id === start.body.loopId && x.status === "done")) pass("GET /api/agent/loops 可见完成状态");
      else fail("loop 列表未显示完成：" + JSON.stringify(list.body).slice(0, 200));
      const rep = await api("POST", "/api/agent/loop/replay", { case: CASE, id: start.body.loopId });
      if (rep.status === 200 && rep.body.loopId && rep.body.replayOf === start.body.loopId) pass("POST /api/agent/loop/replay 创建重放循环");
      else fail("重放失败：" + JSON.stringify(rep.body).slice(0, 200));
      await sleep(1200);
      const list2 = await api("GET", "/api/agent/loops?case=" + encodeURIComponent(CASE));
      if ((list2.body.loops || []).some(x => x.id === rep.body.loopId && x.replayOf === start.body.loopId)) pass("重放循环记录 replayOf");
      else fail("重放循环状态缺失：" + JSON.stringify(list2.body).slice(0, 200));

      const budget = await api("GET", "/api/budget?case=" + encodeURIComponent(CASE));
      if (budget.status === 200 && budget.body.case === CASE && budget.body.tokens !== undefined) pass("GET /api/budget 返回 case token 预算");
      else fail("预算接口异常：" + JSON.stringify(budget.body).slice(0, 200));
      const toolsList = await api("GET", "/api/tools");
      if ((toolsList.body.tools || []).length >= 10) pass("GET /api/tools 返回工具目录");
      else fail("工具目录为空");
      const snap = await api("POST", "/api/tools/case.snapshot", { case: CASE, by: "test" });
      if (snap.status === 200 && snap.body.ok) pass("POST /api/tools/case.snapshot 调用成功");
      else fail("tool gateway 调用失败：" + JSON.stringify(snap.body).slice(0, 200));
      const high = await api("POST", "/api/tools/plan.start", { case: CASE, args: { case: CASE, id: "PL-NOT-EXIST" }, by: "test" });
      if (high.status === 202 && high.body.status === "pending_approval") pass("高风险工具返回 pending_approval");
      else fail("高风险工具未拦截：" + high.status + " " + JSON.stringify(high.body).slice(0, 200));
    }
  } catch (e) { fail("异常：" + String((e && e.message) || e)); }
  finally {
    try { await api("POST", "/api/case/delete", { case: CASE, confirm: true, by: "test" }); } catch (e) {}
    cleanup();
  }
  console.log("\n" + JSON.stringify({ ok: failed === 0, passed, failed }));
  process.exit(failed ? 1 : 0);
})();
