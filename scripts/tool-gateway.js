#!/usr/bin/env node
"use strict";
/**
 * tool-gateway — Agent 工具目录与统一调用入口。
 *
 * 目标：把 panel 已有能力（case/need/plan/data/report/memory）收敛成带 schema、权限、
 * 幂等与审计的 Tool API，供 Lead/Employee Agent Loop 或外部 MCP/function calling 调用。
 *
 * 只暴露领域工具，不暴露裸 bash/write；写文件仍走 Broker 专用工具。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BROKER = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const IDEM_FILE = path.join(ROOT, "runtime/tool-gateway/idempotency.json");
const IDEM_TTL_MS = 10 * 60 * 1000;

function sha(s) { return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16); }
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BROKER + p);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      agent: false,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (e) { j = { raw: data }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function emit(type, actor, payload) {
  try { await api("POST", "/api/event", Object.assign({ type, actor, case: payload.case || "default" }, payload)); } catch (e) {}
}
function idemKey(name, args) { return name + ":" + sha(JSON.stringify(args || {})); }
function readIdem() { try { return JSON.parse(fs.readFileSync(IDEM_FILE, "utf8")); } catch (e) { return {}; } }
function writeIdem(o) { fs.mkdirSync(path.dirname(IDEM_FILE), { recursive: true }); fs.writeFileSync(IDEM_FILE, JSON.stringify(o, null, 2)); }

const TOOLS = {
  "case.snapshot": {
    description: "读取 case 快照：文件版本、锁、mission、模型状态",
    risk: "low", method: "GET", path: "/api/snapshot", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "case.needs": {
    description: "读取 case 的缺口列表（含 stage/reason/auto/evidence）",
    risk: "low", method: "GET", path: "/api/needs", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "case.plans": {
    description: "读取 case 的研究计划与状态",
    risk: "low", method: "GET", path: "/api/plans", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "knowledge.search": {
    description: "检索本 case 的只读知识视图（证据/claim），按状态/类型过滤，供员工判断是否使用",
    risk: "low", local: true, mutating: false,
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, query: { type: "string" }, type: { type: "string" },
      status: { type: "string" }, limit: { type: "number" } }, required: ["case"] }
  },
  "case.work": {
    description: "读取 case 的 WorkItem/DAG 状态",
    risk: "low", method: "GET", path: "/api/work", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "data.preflight": {
    description: "运行前数据预检：每个未补齐缺口的可用来源链",
    risk: "low", method: "GET", path: "/api/data/preflight", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "data.source_health": {
    description: "数据源健康度：可用性、层级、原因、延迟、上次可用",
    risk: "low", method: "GET", path: "/api/data/source-health",
    inputSchema: { type: "object", properties: {} }
  },
  "data.jobs": {
    description: "读取 case 的数据采集任务",
    risk: "low", method: "GET", path: "/api/data/jobs", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "data.request": {
    description: "统一数据请求：先走已注册 connector/DataJob；无可用源时返回 needs_source/needs_credential；给 URL 时可建 DataTask",
    risk: "medium", method: "POST", path: "/api/data/request", mutating: true,
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, needId: { type: "string" }, itemIndex: { type: "number" },
      metric: { type: "string" }, range: { type: "string" }, url: { type: "string" },
      sourceId: { type: "string" }, allowPaid: { type: "boolean" }, allowCredential: { type: "boolean" }
    }, required: ["case", "needId"] }
  },
  "data.collect": {
    description: "为某个指标创建数据采集任务（异步；返回 jobId）",
    risk: "medium", method: "POST", path: "/api/data/jobs", mutating: true,
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, metric: { type: "string" }, sourceId: { type: "string" },
      range: { type: "string" }
    }, required: ["case", "metric"] }
  },
  "need.request": {
    description: "提出缺口（数据/技能/信息/权限），进入人工队列",
    risk: "medium", method: "POST", path: "/api/need", mutating: true,
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, agent: { type: "string" }, kind: { type: "string" },
      title: { type: "string" }, detail: { type: "string" }, blocking: { type: "boolean" }
    }, required: ["case", "title"] }
  },
  "plan.start": {
    description: "启动已批准的研究计划（Lead 编排用）",
    risk: "high", method: "POST", path: "/api/plan/autorun", mutating: true,
    inputSchema: { type: "object", properties: { case: { type: "string" }, id: { type: "string" } }, required: ["case", "id"] }
  },
  "plan.create": {
    description: "创建研究计划草稿；始终 pending，必须人工批准后才能运行",
    risk: "medium", method: "POST", path: "/api/plan", mutating: true,
    mapArgs: a => Object.assign({}, a, { status: "pending", by: "lead" }),
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, agent: { type: "string" }, goal: { type: "string" },
      steps: { type: "array" }, parentPlanId: { type: "string" }, relation: { type: "string" }
    }, required: ["case", "agent", "steps"] }
  },
  "plan.revise": {
    description: "修订计划步骤；已批准计划被改动会自动撤销批准",
    risk: "medium", method: "POST", path: "/api/plan/merge", mutating: true,
    mapArgs: a => Object.assign({}, a, { by: "lead" }),
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, planId: { type: "string" }, agent: { type: "string" },
      add: { type: "array" }, update: { type: "array" }, remove: { type: "array" }, reason: { type: "string" }
    }, required: ["case", "planId"] }
  },
  "work.create": {
    description: "创建 WorkItem / Task Envelope（DAG 执行单元）",
    risk: "medium", method: "POST", path: "/api/work/create", mutating: true,
    mapArgs: a => Object.assign({}, a, { by: "lead" }),
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, planId: { type: "string" }, nodeId: { type: "string" },
      name: { type: "string" }, agent: { type: "string" }, task: { type: "string" },
      outputs: { type: "array" }, depends: { type: "array" }, envelope: { type: "object" },
      maxTokens: { type: "number" }, failurePolicy: { type: "string" }, traceId: { type: "string" }
    }, required: ["case", "nodeId"] }
  },
  "employee.spawn": {
    description: "为 WorkItem 启动一个有界 Employee Loop（异步；受 case 预算约束）",
    risk: "medium", method: "POST", path: "/api/agent/loop", mutating: true,
    mapArgs: a => Object.assign({}, a, { kind: "employee", by: "lead" }),
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, workId: { type: "string" }, agent: { type: "string" },
      runtime: { type: "string" }, mode: { type: "string" }, maxRounds: { type: "number" },
      maxTokens: { type: "number" }, task: { type: "string" }
    }, required: ["case", "workId"] }
  },
  "task.cancel": {
    description: "取消 WorkItem（高风险：需人工审批 token）",
    risk: "high", method: "POST", path: "/api/work/cancel", mutating: true,
    requiresApprovalToken: true, approvalNeedPrefix: "[取消审批]",
    inputSchema: { type: "object", properties: {
      case: { type: "string" }, id: { type: "string" }, reason: { type: "string" }
    }, required: ["case", "id"] }
  },
  "report.assemble": {
    description: "装配最终报告（高风险：只装配、不签发；需人工审批 token）",
    risk: "high", method: "POST", path: "/api/report/final", mutating: true,
    requiresApprovalToken: true, approvalNeedPrefix: "[装配审批]",
    inputSchema: { type: "object", properties: { case: { type: "string" }, by: { type: "string" } },
      required: ["case"] }
  },
  "report.freshness": {
    description: "报告数据新鲜度：每个指标 dataAsOf/是否过期/证据",
    risk: "low", method: "GET", path: "/api/report/freshness", caseQuery: true,
    inputSchema: { type: "object", properties: { case: { type: "string" } }, required: ["case"] }
  },
  "web.site": {
    description: "抓取网址及统计/详情子页，下载 XLS/PDF 并转 CSV，返回 bundle（模型识别数据用）",
    risk: "medium", local: true, mutating: false,
    inputSchema: { type: "object", properties: {
      url: { type: "string" }, depth: { type: "number" }, maxPages: { type: "number" },
      out: { type: "string" }
    }, required: ["url"] }
  },
  "web.agent": {
    description: "通用网页解析 Agent：给 URL + 目标板块，模型自主浏览/点 tab/跟链接/下载附件，返回结构化记录",
    risk: "medium", local: true, mutating: false,
    inputSchema: { type: "object", properties: {
      url: { type: "string" }, goal: { type: "string" }, maxSteps: { type: "number" },
      maxPages: { type: "number" }, feedback: { type: "string" }, previous: { type: "string" },
      out: { type: "string" }
    }, required: ["url", "goal"] }
  },
  "memory.search": {
    description: "检索 case 记忆索引（文件/证据/知识库）",
    risk: "low", local: true,
    inputSchema: { type: "object", properties: { case: { type: "string" }, q: { type: "string" } }, required: ["case", "q"] }
  }
};

function catalog() {
  return Object.keys(TOOLS).map(name => {
    const t = TOOLS[name];
    return { name, description: t.description, risk: t.risk, inputSchema: t.inputSchema,
      mutating: !!t.mutating, highRisk: t.risk === "high" };
  });
}
function validate(tool, args) {
  const schema = tool.inputSchema || {};
  const req = schema.required || [];
  for (const k of req) if (args[k] === undefined || args[k] === null || String(args[k]).trim() === "") {
    throw new Error("缺少参数 " + k);
  }
  for (const k of Object.keys(args || {})) if (!(schema.properties || {})[k]) {
    throw new Error("未知参数 " + k);
  }
}
function rejectedAnswer(n) {
  const s = String((n && (n.answer || n.waiveReason)) || "");
  return /不批准|不同意|拒绝|驳回|暂不|先不|无法补充|\bno\b|\breject\b/i.test(s);
}
async function verifyApprovalToken(tool, caseId, token) {
  const id = String(token || "").replace(/^need:/, "").trim();
  if (!id) return false;
  try {
    const r = await api("GET", "/api/needs?case=" + encodeURIComponent(caseId));
    const n = ((r.body && r.body.needs) || []).find(x => x.id === id);
    if (!n || n.status !== "answered" || n.waived || n.consumedAt) return false;
    if (tool.approvalNeedPrefix && !String(n.title || "").startsWith(tool.approvalNeedPrefix)) return false;
    if (n.decision) return n.decision === "approve";
    return !rejectedAnswer(n);
  } catch (e) { return false; }
}
async function invokeLocal(name, args) {
  if (name === "web.agent") {
    const a = args || {};
    const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const pyArgs = [path.join(ROOT, "scripts/web_agent.py"), "--url", String(a.url),
      "--goal", String(a.goal), "--max-steps", String(Math.max(2, Math.min(15, Number(a.maxSteps) || 10))),
      "--max-pages", String(Math.max(1, Math.min(30, Number(a.maxPages) || 5)))];
    if (a.feedback) pyArgs.push("--feedback", String(a.feedback));
    if (a.previous) pyArgs.push("--previous", String(a.previous));
    if (a.out) pyArgs.push("--out", String(a.out));
    const r = spawnSync(PY, pyArgs, { cwd: ROOT, encoding: "utf8", timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }) });
    let j = null;
    const raw = String(r.stdout || "").trim();
    try { j = JSON.parse(raw); } catch (e) { try { j = JSON.parse(raw.split(String.fromCharCode(10)).pop()); } catch (e2) {} }
    return { status: r.status === 0 && j && j.ok ? 200 : 500,
      body: j || { ok: false, error: String(r.stderr || "").slice(0, 800) || ("exit " + r.status) } };
  }
  if (name === "web.site") {
    const a = args || {};
    const cmdArgs = [path.join(ROOT, "scripts/collect.js"), "site", String(a.url),
      "--depth", String(Math.max(0, Math.min(3, Number(a.depth) || 1))),
      "--max-pages", String(Math.max(1, Math.min(20, Number(a.maxPages) || 8)))];
    if (a.out) cmdArgs.push("--out", String(a.out));
    const r = spawnSync(process.execPath, cmdArgs, { cwd: ROOT, encoding: "utf8",
      timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    let j = null;
    const raw = String(r.stdout || "").trim();
    try { j = JSON.parse(raw); } catch (e) { try { j = JSON.parse(raw.split(String.fromCharCode(10)).pop()); } catch (e2) {} }
    return { status: r.status === 0 ? 200 : 500,
      body: j || { ok: false, error: String(r.stderr || "").slice(0, 500) || ("exit " + r.status) } };
  }
  if (name === "knowledge.search") {
    const a = args || {};
    const qs = new URLSearchParams({ case: String(a.case || "default") });
    if (a.query) qs.set("q", String(a.query));
    if (a.type) qs.set("type", String(a.type));
    if (a.status) qs.set("status", String(a.status));
    if (a.limit) qs.set("limit", String(a.limit));
    try {
      const r = await api("GET", "/api/knowledge/search?" + qs.toString());
      return { status: r.status, body: r.body };
    } catch (e) { return { status: 500, body: { ok: false, error: String(e && e.message || e) } }; }
  }
  if (name === "memory.search") {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/memory.js"), "search",
      "--case", String(args.case), "--q", String(args.q)], { cwd: ROOT, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
    return { status: r.status === 0 ? 200 : 500, body: j || { ok: false, error: String(r.stderr || "").slice(0, 300) } };
  }
  throw new Error("unknown local tool " + name);
}
async function invoke(name, args, ctx) {
  const t = TOOLS[name];
  if (!t) throw new Error("未知工具：" + name);
  const a = Object.assign({}, args || {});
  const c = ctx || {};
  validate(t, a);
  const started = Date.now();
  const actor = c.actor || "agent";
  const traceId = c.traceId || "";
  await emit("tool.called", actor, { case: a.case || c.case || "default", tool: name,
    traceId, argsHash: sha(JSON.stringify(a)), risk: t.risk });
  // 高风险工具：需要 token 的必须验证 answered+approve 的 need；其余允许显式 approved。
  if (t.risk === "high") {
    const caseId = a.case || c.case || "default";
    const tokenOk = c.approvalToken ? await verifyApprovalToken(t, caseId, c.approvalToken) : false;
    if ((t.requiresApprovalToken && !tokenOk) || (!tokenOk && c.approved !== true)) {
      const result = { ok: false, status: "pending_approval", tool: name,
        reason: t.requiresApprovalToken ? "需要人工审批 token（answered + approve）" : "高风险工具需要人工/Lead 审批",
        approvalHint: t.approvalNeedPrefix || "", argsHash: sha(JSON.stringify(a)) };
      await emit("tool.pending_approval", actor, { case: caseId, tool: name, traceId,
        argsHash: result.argsHash, tokenPresent: !!c.approvalToken, tokenOk });
      return result;
    }
  }
  // 幂等：写操作同一个 key 10 分钟内直接返回缓存，避免重试重复建 job/need。
  const key = t.mutating ? idemKey(name, a) : "";
  if (key) {
    const all = readIdem();
    const hit = all[key];
    if (hit && Date.now() - hit.at < IDEM_TTL_MS) return Object.assign({}, hit.result, { cached: true });
  }
  let r;
  const payload = (t.mapArgs && t.method !== "GET") ? t.mapArgs(a) : a;
  try { r = t.local ? await invokeLocal(name, a) : await api(t.method, t.path + (t.caseQuery ? "?case=" + encodeURIComponent(a.case) : ""), t.method === "GET" ? undefined : payload); }
  catch (e) {
    await emit("tool.failed", actor, { case: a.case || c.case || "default", tool: name, traceId, error: String(e && e.message || e).slice(0, 300), ms: Date.now() - started });
    return { ok: false, tool: name, error: String(e && e.message || e).slice(0, 300) };
  }
  const ok = r.status >= 200 && r.status < 300 && r.body && r.body.error === undefined;
  const result = { ok, tool: name, status: r.status, result: r.body };
  if (key && ok) { const all = readIdem(); all[key] = { at: Date.now(), result }; writeIdem(all); }
  await emit(ok ? "tool.result" : "tool.failed", actor, { case: a.case || c.case || "default", tool: name,
    traceId, ms: Date.now() - started, ok, summary: JSON.stringify(r.body || {}).slice(0, 300) });
  return result;
}
module.exports = { catalog, invoke, TOOLS, sha };
