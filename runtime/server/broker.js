#!/usr/bin/env node
/**
 * AlphaDesk Broker — M1
 * 唯一写入口：锁队列（FIFO + 租约 + 写优先）/ 版本 CAS / 事件账本 / SSE
 * 零依赖，只用 node 内置模块。
 *
 *   node runtime/server/broker.js --port 7801 --root .
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { URL } = require("url");
const { spawn, spawnSync } = require("child_process");
function runNode(args, env2, timeoutMs) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, args, { cwd: ROOT, env: env2 || process.env });
    let out = "", err = "", done = false;
    const finish = (code) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ code, out, err }); };
    const timer = timeoutMs ? setTimeout(() => { try { c.kill("SIGKILL"); } catch (e) {} finish(null); }, timeoutMs) : null;
    c.stdout.on("data", d => out += d);
    c.stderr.on("data", d => err += d);
    c.on("close", code => finish(code));
    c.on("error", e => { err += String(e && e.message || e); finish(null); });
  });
}

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
}
const ROOT = path.resolve(arg("root", path.join(__dirname, "../..")));
// 代码/脚本始终从仓库目录加载；ROOT 只决定数据目录（测试会用 --root 指向临时目录）。
const CODE_ROOT = path.resolve(__dirname, "../..");
const metricResolver = require(path.join(CODE_ROOT, "scripts/metric-resolver.js"));
const sourceHealth = require(path.join(CODE_ROOT, "scripts/source-health.js"));
const sourceChain = require(path.join(CODE_ROOT, "scripts/source-chain.js"));
const sourcePolicy = require(path.join(CODE_ROOT, "scripts/source-policy.js"));
const sourceUsage = require(path.join(CODE_ROOT, "scripts/source-usage.js"));
const dataGateway = require(path.join(CODE_ROOT, "scripts/data-gateway.js"));
const taskEstimator = require(path.join(CODE_ROOT, "scripts/task-estimator.js"));
const dataQuality = require(path.join(CODE_ROOT, "scripts/data-quality.js"));
const dataTask = require(path.join(CODE_ROOT, "scripts/datatask.js"));
const toolGateway = require(path.join(CODE_ROOT, "scripts/tool-gateway.js"));
const caseIntent = require(path.join(CODE_ROOT, "scripts/case-intent.js"));
const caseView = require(path.join(CODE_ROOT, "runtime/domain/case-view.js"));
const { FINAL_REPORT, LEGACY_FINAL_REPORT } = require(path.join(CODE_ROOT, "runtime/contracts.js"));
const ALIAS_FILE = path.join(ROOT, "runtime/metric-aliases.json");
function loadAliasProposals() {
  try { return JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8")); } catch (e) { return []; }
}
function saveAliasProposals(list) {
  try { fs.mkdirSync(path.dirname(ALIAS_FILE), { recursive: true }); fs.writeFileSync(ALIAS_FILE, JSON.stringify(list.slice(-300), null, 2)); } catch (e) {}
}
function loadMetricConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8")); } catch (e) { return { metrics: [] }; }
}
function saveMetricConfig(cfg) {
  try { fs.writeFileSync(path.join(ROOT, "config/data/metrics.json"), JSON.stringify(cfg, null, 2)); } catch (e) {}
}
function draftMetricId(name) {
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "custom";
  return "custom." + slug + "-" + Date.now().toString(36);
}
function validateDraftMetric(m) {
  const missing = [];
  if (!m.name) missing.push("name");
  if (!m.definition) missing.push("definition");
  if (!m.unit) missing.push("unit");
  if (!m.frequency) missing.push("frequency");
  if (!Array.isArray(m.sources) || !m.sources.length) missing.push("sources");
  return missing;
}
function precheckAlias(metricId, text) {
  const t = String(text || "").trim();
  const n = metricResolver.norm(t);
  const reasons = [];
  if (!t) return { pass: false, status: "rejected", reasons: ["别名为空"] };
  if (n.length < 2) return { pass: false, status: "rejected", reasons: ["别名过短"] };
  if (t.length > 40) return { pass: false, status: "rejected", reasons: ["别名过长"] };
  const broad = ["数据", "指标", "金额", "数值", "信息", "情况", "相关", "其他"];
  if (broad.indexOf(n) >= 0) return { pass: false, status: "rejected", reasons: ["别名过于宽泛"] };
  const cfg = loadMetricConfig();
  const metrics = cfg.metrics || [];
  const target = metrics.find(m => m.id === metricId);
  if (!target) return { pass: false, status: "rejected", reasons: ["目标 metric 不存在"] };
  const names = [target.name].concat(target.aliases || []);
  if (names.some(x => metricResolver.norm(x) === n)) return { pass: false, status: "rejected", reasons: ["与目标 metric 已有别名重复"] };
  const conflict = metrics.find(m => m.id !== metricId && [m.name].concat(m.aliases || []).some(x => metricResolver.norm(x) === n));
  if (conflict) return { pass: true, status: "pre_reviewed", conflictMetricId: conflict.id,
    reasons: ["与其他 metric 别名冲突：" + conflict.id] };
  return { pass: true, status: "pre_reviewed", reasons: [] };
}
let classifyIntentRule = null;
try { classifyIntentRule = require(path.join(CODE_ROOT, "scripts/intent.js")).classify; } catch (e) {}
let indicatorApi = null;
try { indicatorApi = require(path.join(CODE_ROOT, "scripts/indicators.js")); } catch (e) {}
const PORT = parseInt(arg("port", "7801"), 10);
// 默认只听本机；要跨机器看板就 --host 0.0.0.0，并且必须配 --token（否则同网段任何人可读写账本/下载文件）
const HOST = String(process.env.PANEL_HOST || arg("host", "127.0.0.1"));
const TOKEN = String(process.env.PANEL_TOKEN || arg("token", "") || "");
// 默认信任本机回环（员工/desk/pipeline 都从 127.0.0.1 连，不该逼它们带口令）。
// --trust-loopback 0 时连本机也要口令——只用于"模拟外网来源"的测试，或前面挂了反向代理的场景。
const TRUST_LOOPBACK = String(arg("trust-loopback", "1")) !== "0";

// dsh 是"员工"的运行本体：优先 DSH_BIN，其次 PATH，最后回落 macOS App 自带路径
function findDshBin() {
  const ok = p => { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { return ""; } };
  const cands = [process.env.DSH_BIN,
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"];
  const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
  (process.env.PATH || "").split(path.delimiter).forEach(d => {
    if (d) names.forEach(nm => cands.push(path.join(d, nm)));
  });
  for (const c of cands) { if (c && ok(c)) return c; }
  return "";
}
const DSH_BIN = findDshBin();
const RUNTIME = { node: process.version, platform: process.platform,
  dsh: DSH_BIN || null, dshOk: !!DSH_BIN, dshHint: DSH_BIN ? "" : "未找到 dsh：员工无法启动。安装 DeepSeek Harness 或用 DSH_BIN 指向 dsh 可执行文件",
  host: HOST, tokenRequired: !!TOKEN };

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "";
}
const LEDGER = path.join(ROOT, "runtime/ledger/events.jsonl");
const VAULT = path.join(ROOT, "vault");
const HISTORY = path.join(ROOT, "runtime/history");
const LOCK_DIR = path.join(ROOT, "runtime/locks");

fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
fs.mkdirSync(VAULT, { recursive: true });
fs.mkdirSync(HISTORY, { recursive: true });
fs.mkdirSync(LOCK_DIR, { recursive: true });

/* ---------------------------------------------------------------- 状态 */
const S = {
  seq: 0,
  files: new Map(),   // "case::rel" -> file
  locks: new Map(),   // lockId -> lock
  cases: new Map(),   // caseId -> {gates:{}}
  events: [],         // 环形缓冲，供 SSE
  startedAt: Date.now(),
  stats: { acquires: 0, grants: 0, writes: 0, conflicts: 0, timeouts: 0, expired: 0 }
};
let lockSeq = 0, reqSeq = 0, taskSeq = 0, capSeq = 0;
const tasks = new Map();   // caseId -> [task]
const runs = new Map();    // agent -> { agent, case, pid, task, startedAt } 进行中的员工进程
const cycles = new Map();  // caseId -> { status: running|awaiting_review|signed|failed|blocked, startedAt, finishedAt, pid, summary }
const KB_ROOT = path.join(ROOT, "runtime/kb");  // 每个员工一个 Wiki 知识库
const INDEX_CACHE = new Map();  // caseId -> { sig, docs: [{path,version,terms,snippet}] }  vault 全文倒排（磁盘内容变化才重建）
const caseNames = new Map();    // caseId -> 显示名（账本主键不改，重命名=别名+显示名）
const deletedCases = new Set(); // 已删除的 case（进回收站，可恢复）
const trash = new Map();        // caseId -> { trash: 相对路径, at, files }
const usage = new Map();        // caseId -> { agent: { input, output, cacheRead, total, runs, lastMs } }
const reviews = new Map(); // caseId -> [review]  复核服务：一次服务 = (产物路径, 版本, audit|legal)
const leadLeases = new Map(); // caseId -> { loopId, until, pid }  单 case 只能有一个 active Lead
const evidenceHashCache = new Map(); // path+mtime+size -> sha256（文件证据现算，不回写证据）
let reviewSeq = 0;
/* ---------------------------------------------------------------- 配置与目录发现
 * 开源版：角色名单、默认模型、每员工默认技能、案例默认角色都从 config/desk.json 读；
 * 技能从 skills/<id>/SKILL.md 自动发现。用户改配置 / 加文件即可，不必改代码。
 */
const CONFIG = (function loadConfig() {
  const fallback = {
    brand: "AlphaDesk", language: "zh",
    server: { port: 7801, host: "127.0.0.1" },
    agents: [
      { id: "macro", name: "宏观研究员", glyph: "宏", tier: "base", role: "agents/macro/ROLE.md" },
      { id: "industry", name: "行业研究员", glyph: "行", tier: "base", role: "agents/industry/ROLE.md" },
      { id: "stock", name: "个股研究员", glyph: "股", tier: "base", role: "agents/stock/ROLE.md" },
      { id: "audit", name: "信息审计", glyph: "审", tier: "advanced", role: "agents/audit/ROLE.md" },
      { id: "legal", name: "法律顾问", glyph: "法", tier: "advanced", role: "agents/legal/ROLE.md" },
      { id: "trader", name: "交易员", glyph: "交", tier: "advanced", role: "agents/trader/ROLE.md" },
      { id: "lead", name: "Lead · 汇编", glyph: "L", tier: "system", role: null }
    ],
    case: { roles: ["macro", "industry", "stock", "audit", "legal", "trader"],
      audience: "内部研究", horizon: "6~12 个月" },
    models: { default: null, catalog: [] },
    skills: { dir: "skills", assign: {} },
    dsh: { bin: null }
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
    // 本机私有覆盖（gitignored）：作者自己的模型目录/端口等，不随仓库发布
    try {
      const local = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.local.json"), "utf8"));
      Object.keys(local).forEach(k => {
        cfg[k] = (local[k] && typeof local[k] === "object" && !Array.isArray(local[k]) && cfg[k])
          ? Object.assign({}, cfg[k], local[k]) : local[k];
      });
    } catch (_) {}
    return Object.assign({}, fallback, cfg, {
      agents: Array.isArray(cfg.agents) && cfg.agents.length ? cfg.agents : fallback.agents,
      case: Object.assign({}, fallback.case, cfg.case || {}),
      models: Object.assign({}, fallback.models, cfg.models || {}),
      skills: Object.assign({}, fallback.skills, cfg.skills || {}),
      server: Object.assign({}, fallback.server, cfg.server || {})
    });
  } catch (e) {
    console.warn("[broker] 读不到 config/desk.json，用内置兜底：" + e.message);
    return fallback;
  }
})();
const AGENT_LIST = CONFIG.agents.filter(a => a.id !== "lead" && a.role !== null);
const AGENT_IDS = new Set(AGENT_LIST.map(a => a.id));
function agentMeta(id) { return CONFIG.agents.find(a => a.id === id) || null; }

// 技能 = skills/<id>/SKILL.md（frontmatter + 正文）。加一个目录就多一个技能，改文件即改内容。
function loadSkillsFromDisk() {
  const dir = path.join(ROOT, CONFIG.skills.dir || "skills");
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name, "SKILL.md");
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
    let meta = {}, body = text;
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      body = text.slice(fm[0].length);
      fm[1].split(/\r?\n/).forEach(line => {
        const i = line.indexOf(":");
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
    }
    const doc = body.split(/\r?\n/)
      .filter(l => !/^(name|description|version|category|author|source|tags)\s*:/.test(l.trim()))
      .join("\n").trim();
    if (!meta.name && !doc) continue;
    const kb = Math.max(1, Math.round(fs.statSync(file).size / 1024));
    out.push({ id: name, name: meta.name || name, cat: meta.category || "research",
      kind: "skill", ver: meta.version || "1.0.0", author: meta.author || "workspace",
      source: meta.source || "workspace", installed: true, size: kb + " KB",
      desc: meta.description || "", doc: doc.slice(0, 4000) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
const SKILL_CATALOG = loadSkillsFromDisk();
const skillState = new Map();   // caseId -> {catalog, byAgent, loaded}
function skillsOf(caseId) {
  if (!skillState.has(caseId)) {
    skillState.set(caseId, {
      catalog: SKILL_CATALOG.map(s => JSON.parse(JSON.stringify(s))),
      byAgent: JSON.parse(JSON.stringify(CONFIG.skills.assign || {})),
      loaded: []
    });
  }
  return skillState.get(caseId);
}

const modelState = new Map();   // caseId -> {default, byAgent, catalog}
function modelsOf(caseId) {
  if (!modelState.has(caseId)) {
    const d = CONFIG.models.default;
    modelState.set(caseId, {
      // 开源默认不预置模型：用户自己在面板加。null 时面板显示"未配置"，员工派活会明确报错。
      default: d && d.provider && d.model ? { provider: d.provider, model: d.model } : null,
      byAgent: {},
      catalog: (CONFIG.models.catalog || []).map(m => Object.assign({ builtin: false }, m))
    });
  }
  return modelState.get(caseId);
}
const caps = new Map();    // caseId -> [capabilityRequest]
const needs = new Map();   // caseId -> [need]  员工主动提出的缺失/申请（数据、技能、信息、插件、权限）
let needSeq = 0;
const plans = new Map();   // caseId -> [plan]  每个员工自己的步骤计划（Lead/规划者产出，研究类需审批）
const coords = new Map();  // caseId -> [coordination] 员工之间的协作请求（需审批）
const works = new Map();   // caseId -> [workItem] DAG 节点执行单元（调度器/Worker 的协议）
const intakes = new Map(); // caseId -> [intake] 数据补充子请求（绑定 need item，不进入 plan.steps）
let intakeSeq = 0;
const dataTasks = new Map(); // caseId -> [dataTask] 专用数据补齐任务（有界智能）
let dataTaskSeq = 0, dataTaskSourceSeq = 0, dataTaskAttemptSeq = 0;
let childSeq = 0;
const fanoutGroups = new Map();
const fanoutInFlight = new Map();
const DATA_JOB_DIR = path.join(ROOT, "runtime/data/jobs");
const ASYNC_JOB_DIR = path.join(ROOT, "runtime/jobs");
let asyncJobSeq = 0;
function asyncJobPath(id) { return path.join(ASYNC_JOB_DIR, id + ".json"); }
function readAsyncJob(id) { try { return JSON.parse(fs.readFileSync(asyncJobPath(id), "utf8")); } catch (e) { return null; } }
function writeAsyncJob(j) { fs.mkdirSync(ASYNC_JOB_DIR, { recursive: true }); fs.writeFileSync(asyncJobPath(j.id), JSON.stringify(j, null, 2)); return j; }
function listAsyncJobs(caseId, type, status) {
  try {
    const jobs = fs.readdirSync(ASYNC_JOB_DIR).filter(f => /\.json$/.test(f)).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(ASYNC_JOB_DIR, f), "utf8")); } catch (e) { return null; }
    }).filter(x => x && (!caseId || x.case === caseId) && (!type || x.type === type) && (!status || x.status === status));
    jobs.forEach(j => {
      if (j.status !== "running") return;
      let dead = false;
      if (j.workerPid) { try { process.kill(j.workerPid, 0); } catch (e) { dead = true; } }
      const age = Date.now() - (Date.parse(j.updatedAt || j.createdAt) || 0);
      if (!j.workerPid && age > 5 * 60 * 1000) dead = true;
      if (dead) { j.status = "failed"; j.error = "job worker exited before finishing"; j.updatedAt = new Date().toISOString(); writeAsyncJob(j); }
    });
    return jobs.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  } catch (e) { return []; }
}
let dataJobSeq = 0;
function dataJobPath(id) { return path.join(DATA_JOB_DIR, id + ".json"); }
function readDataJob(id) { try { return JSON.parse(fs.readFileSync(dataJobPath(id), "utf8")); } catch (e) { return null; } }
function writeDataJob(j) { fs.mkdirSync(DATA_JOB_DIR, { recursive: true }); fs.writeFileSync(dataJobPath(j.id), JSON.stringify(j, null, 2)); return j; }
function listDataJobs(caseId) {
  try {
    return fs.readdirSync(DATA_JOB_DIR).filter(f => /\.json$/.test(f)).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_JOB_DIR, f), "utf8")); } catch (e) { return null; }
    }).filter(x => x && (!caseId || x.case === caseId)).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  } catch (e) { return []; }
}
function dataCoverage(metric, range, records) {
  const expected = (() => {
    const m = String(range || "").match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
    if (!m) return 0;
    return Math.max(0, (parseInt(m[3]) * 12 + parseInt(m[4])) - (parseInt(m[1]) * 12 + parseInt(m[2])) + 1);
  })();
  const periods = new Set((records || []).map(r => r.period).filter(Boolean));
  return { expected, got: periods.size, coverage: expected ? Math.round(Math.min(periods.size, expected) / expected * 100) : (periods.size ? 100 : 0) };
}
function fanoutWorkOf(caseId, t) {
  const ids = t.stepIds || [t.stepId];
  return (works.get(caseId) || []).filter(w => w.planId === t.planId && ids.indexOf(w.nodeId) >= 0);
}
function fanoutGroupDone(caseId, g) {
  return (g.tasks || []).length > 0 && (g.tasks || []).every(t => {
    const ws = fanoutWorkOf(caseId, t);
    // required 任务失败时不能触发 Lead 综合；只有全部 done 才视为 group 完成。
    return ws.length && ws.every(w => w.state === "done");
  });
}
function buildFanoutRaw(caseId, g, by) {
  if (!g) return null;
  const lines = ["# 并行研究汇总 · " + g.goal, "", "> 任务组：" + g.id + " · " + g.createdAt, ""];
  (g.tasks || []).forEach(t => {
    const plan = (plans.get(caseId) || []).find(x => x.id === t.planId);
    const ids = t.stepIds || [t.stepId];
    const worksOf = (works.get(caseId) || []).filter(w => w.planId === t.planId && ids.indexOf(w.nodeId) >= 0);
    lines.push("## " + t.agent + " · " + (plan && plan.goal || t.planId), "");
    lines.push("- 步骤：" + ids.join(" → "));
    lines.push("- 状态：" + worksOf.map(w => w.nodeId + "=" + w.state).join(" / "));
    lines.push("- token：" + worksOf.reduce((n, w) => n + (w.tokens || 0), 0));
    worksOf.filter(w => w.error).forEach(w => lines.push("- " + w.nodeId + " 错误：" + String(w.error).slice(0, 200)));
    worksOf.forEach(w => {
      const cs = path.join(ROOT, "runtime/work", w.id, "children.summary.md");
      if (fs.existsSync(cs)) lines.push("", "### " + w.nodeId + " 子任务汇总", "", fs.readFileSync(cs, "utf8").trim());
      const step = plan && (plan.steps || []).find(x => x.id === w.nodeId);
      const outputs = (w.outputs && w.outputs.length) ? w.outputs : ((step && step.outputs) || []);
      outputs.forEach(p => {
        const rel = outputRel(caseId, p);
        const ap = path.join(ROOT, "vault", caseId, rel);
        if (fs.existsSync(ap)) lines.push("", "### " + rel, "", fs.readFileSync(ap, "utf8").slice(0, 3000));
      });
    });
    lines.push("");
  });
  const rel = "reports/fanout-" + g.id + ".md";
  const abs = path.join(ROOT, "vault", caseId, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!g.rawBuilt) {
    fs.writeFileSync(abs, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
    g.rawBuilt = true;
    emit("fanout.collected", by || "system", { case: caseId, groupId: g.id, path: rel });
  }
  return { rel, markdown: lines.join(String.fromCharCode(10)) };
}
function spawnLeadSynthesis(caseId, g) {
  if (!g || g.synthesisStarted || !fanoutGroupDone(caseId, g)) return null;
  const rawRel = "reports/fanout-" + g.id + ".md";
  if (!fs.existsSync(path.join(ROOT, "vault", caseId, rawRel))) return null;
  g.synthesisStarted = true;
  const outRel = "reports/fanout-" + g.id + "-lead.md";
  const prompt = [
    "你是投研团队 Lead。读取 " + rawRel + "，把多个员工的并行研究结果综合成一份 Lead 汇总。",
    "要求：合并重复；指出分歧；统一口径；保留证据引用；缺数据写缺口，不要编造。",
    "输出写到 " + outRel + "，结构：结论摘要、分员工要点、交叉验证、风险与缺口、下一步建议。",
    "不要修改其他员工底稿，不要签发。"
  ].join(String.fromCharCode(10));
  const stage = "LEAD-" + g.id;
  const dir = path.join(ROOT, "runtime/fanout-lead"); fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, g.id + "-" + Date.now() + ".log");
  const fd = fs.openSync(logPath, "a");
  const lcfg = (((CONFIG.models || {}).byAgent || {}).lead) || ((CONFIG.models || {}).planner || {}).default || (CONFIG.models || {}).default || {};
  const lprovider = lcfg.provider || "opencode-go";
  const lmodel = lcfg.model || "deepseek-v4.1-flash";
  const leffort = lcfg.effort || "high";
  const cp = spawn(process.execPath, [path.join(ROOT, "runtime/agents/employee.js"),
    "--agent", "lead", "--case", caseId, "--stage", stage,
    "--provider", lprovider, "--model", lmodel, "--effort", leffort,
    "--task", prompt, "--short-prompt"], { cwd: ROOT, detached: true,
    stdio: ["ignore", fd, fd], env: Object.assign({}, process.env,
      { DESK_BROKER: "http://127.0.0.1:" + PORT, DESK_WORK_ID: "" }) });
  cp.on("close", code => {
    const abs = path.join(ROOT, "vault", caseId, outRel);
    let ok = false, bytes = 0, err = "";
    try { const txt = fs.readFileSync(abs, "utf8"); bytes = txt.length; ok = code === 0 && bytes > 80; if (!ok) err = code !== 0 ? ("exit " + code) : "汇总文件为空或过短"; } catch (e) { err = String(e && e.message || e); }
    g.synthesisStarted = false; g.synthesisDone = ok;
    emit(ok ? "fanout.synthesis.finished" : "fanout.synthesis.failed", "lead", { case: caseId,
      groupId: g.id, path: outRel, ok, bytes, error: err });
  });
  cp.unref(); try { fs.closeSync(fd); } catch (e) {}
  emit("fanout.synthesis.started", "system", { case: caseId, groupId: g.id, path: outRel,
    pid: cp.pid, log: path.relative(ROOT, logPath), auto: true });
  return cp;
}
function matchNeedItems(caseId, text) {
  const cleanText = String(text || "").replace(/https?:\/\/\S+/g, " ");
  const norm = x => String(x || "").replace(/[\s，。；、：:,.()（）【】\[\]]/g, "");
  const q = norm(cleanText);
  const grams = s => {
    const t = norm(s); const out = new Set();
    for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
    return out;
  };
  const qg = grams(cleanText); const out = [];
  (needs.get(caseId) || []).forEach(n => {
    if (n.status !== "pending" && n.status !== "partial") return;
    (n.spec && n.spec.items || []).forEach((it, i) => {
      if (it.status === "provided") return;
      const hay = norm([it.indicator, it.definition, it.source, n.title].join(" "));
      const hg = grams(hay); let score = 0; const hits = [];
      qg.forEach(g => { if (hg.has(g)) { score += g.length >= 3 ? 1.5 : 0.8; if (hits.length < 8) hits.push(g); } });
      if (q.includes(norm(it.indicator))) score += 6;
      if (q.indexOf("锗价") >= 0 && (hay.indexOf("现货") >= 0 || hay.indexOf("均价") >= 0) && (hay.indexOf("锗锭") >= 0 || hay.indexOf("二氧化锗") >= 0)) { score += 12; hits.push("锗价"); }
      ["锗锭", "二氧化锗", "锗价", "长协", "出口", "产量", "库存", "成本", "许可证", "红外"].forEach(k => {
        if (q.indexOf(k) >= 0) { if (hay.indexOf(k) >= 0) { score += 6; if (hits.length < 8) hits.push(k); } else score -= 1.5; }
      });
      if (score > 0) out.push({ needId: n.id, index: i, indicator: it.indicator, needTitle: n.title,
        score: Math.round(score * 10) / 10, confidence: score >= 7 ? "high" : score >= 3 ? "medium" : "low",
        hits: Array.from(new Set(hits)).slice(0, 6) });
    });
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 6);
}
function isDataSupplementIntent(text) {
  const t = String(text || "").trim();
  if (/[?？]|什么|哪些|怎么|为什么|为何|是否|吗|呢/.test(t)) return false;
  const hasData = /(数据|价格|库存|产量|出口量|金额|财务|估值|持仓|指标|序列|报表|原文|证据|文件)/.test(t);
  const hasAction = /(补充|找|获取|抓取|解析|整理|查询|拉取|下载|上传|缺少|需要|补一下|补全)/.test(t);
  return hasData && hasAction;
}
function createIntake(caseId, agent, text, url, candidates) {
  const list = intakes.get(caseId) || [];
  const wlist = works.get(caseId) || [];
  const running = wlist.find(w => w.agent === agent && w.state === "running") ||
    wlist.find(w => w.agent === agent && w.state === "queued") ||
    wlist.find(w => w.agent === agent && w.state === "failed");
  const top = (candidates || [])[0] || null;
  const second = (candidates || [])[1] || null;
  const uniqueHigh = !!(top && top.confidence === "high" && (!second || top.score - second.score >= 3));
  const id = "I" + (++intakeSeq);
  const it = { id, case: caseId, agent, text, url,
    needId: uniqueHigh ? top.needId : "",
    index: uniqueHigh ? top.index : null,
    parentPlanId: running ? running.planId : "",
    parentStepId: running ? running.nodeId : "",
    candidates: candidates || [], status: uniqueHigh ? (url ? "queued" : "needs_source") : "needs_target",
    attempts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  list.push(it); intakes.set(caseId, list);
  emit("intake.created", "you", { case: caseId, intakeId: id, agent, url, needId: it.needId,
    index: it.index, parentPlanId: it.parentPlanId, parentStepId: it.parentStepId,
    status: it.status, candidates: (candidates || []).slice(0, 3) });
  if (it.status === "queued") spawnIntakeWorker(it);
  return it;
}
function findIntakeFile(caseId, it) {
  if (!it) return "";
  if (it.file) return String(it.file);
  if (it.lastAttempt && it.lastAttempt.file) return String(it.lastAttempt.file);
  const found = String((it.lastAttempt && it.lastAttempt.found) || "");
  const pm = found.match(/([a-zA-Z0-9_./-]+\.(?:csv|xlsx|json|md))/);
  if (pm) return pm[1];
  const base = vaultPath(caseId, "");
  const dirs = ["research/data", "research", "uploads", "reports"];
  const candidates = [];
  const since = Date.parse(it.createdAt) || 0;
  const nid = String(it.needId || "").toLowerCase();
  dirs.forEach(d => {
    const dir = path.join(base, d);
    let names = []; try { names = fs.readdirSync(dir); } catch (e) {}
    names.forEach(n => {
      if (!/\.(csv|xlsx|json|md)$/i.test(n)) return;
      const abs = path.join(dir, n); let st; try { st = fs.statSync(abs); } catch (e) { return; }
      if (st.mtimeMs + 120000 < since) return;
      let score = 0; const low = n.toLowerCase();
      if (nid && low.indexOf(nid) >= 0) score += 6;
      if (/\.csv$/i.test(n)) score += 3;
      if (/monthly/i.test(n)) score += 6;
      if (/daily/i.test(n)) score -= 3;
      if (/price|spot|n80/i.test(n)) score += 2;
      if (/note|probe|readme/i.test(n)) score -= 3;
      candidates.push({ path: d + "/" + n, score, mtime: st.mtimeMs });
    });
  });
  candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return candidates.length ? candidates[0].path : "";
}
function spawnIntakeWorker(it) {
  if (!it || !it.needId || it.status === "running") return;
  const n = (needs.get(it.case) || []).find(x => x.id === it.needId);
  const item = n && n.spec && n.spec.items ? n.spec.items[it.index] : null;
  const task = [
    "【数据补充子请求 " + it.id + "】",
    "URL：" + it.url,
    "目标待补项：" + it.needId + " 第 " + it.index + " 项「" + ((item && item.indicator) || "") + "」",
    "要求：" + JSON.stringify(item ? { frequency: item.frequency, range: item.range, unit: item.unit, format: item.format, definition: item.definition } : {}),
    "先运行 node scripts/collect.js get " + JSON.stringify(it.url) + " --browser 解析页面；不要修改主计划。",
    "不足时：POST /api/intake/update（curl）传 case/id/status=insufficient/found/coverage/requirement/missing；不要标记 need provided。",
    "足够时：先给用户预览，再按 need 入库流程提供；不要编造。",
    "结束回复：发现什么、覆盖多少、仍缺什么、下一步建议。"
  ].join(String.fromCharCode(10));
  it.status = "running"; it.updatedAt = new Date().toISOString();
  emit("intake.updated", "system", { case: it.case, intakeId: it.id, agent: it.agent,
    needId: it.needId, index: it.index, status: "running", note: "启动数据补充 agent" });
  const dir = path.join(ROOT, "runtime/intake-runs"); fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, it.id + "-" + Date.now() + ".log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "runtime/agents/employee.js"),
    "--agent", it.agent, "--case", it.case, "--stage", "INTAKE-" + it.id, "--task", task, "--short-prompt"],
    { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
      env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
  child.on("close", code => {
    try { fs.closeSync(fd); } catch (e) {}
    const cur = (intakes.get(it.case) || []).find(x => x.id === it.id);
    if (cur && (cur.status === "running" || cur.status === "queued")) {
      cur.status = code === 0 ? "needs_review" : "failed";
      cur.updatedAt = new Date().toISOString();
      emit("intake.updated", "system", { case: it.case, intakeId: it.id, agent: it.agent,
        needId: cur.needId, index: cur.index, status: cur.status,
        note: code === 0 ? "数据补充 agent 结束，待用户确认" : ("agent 退出码 " + code) });
    }
  });
  child.unref();
}
let planSeq = 0, coordSeq = 0, workSeq = 0;
let sourceSeq = 0, parseJobSeq = 0, candidateSeq = 0, conflictSeq = 0;
const PLAN_APPROVAL_ROLES = new Set((CONFIG.policy || {}).planApprovalRoles || ["macro", "industry", "stock"]);

function keyOf(caseId, rel) { return caseId + "::" + rel; }
function fileOf(caseId, rel) {
  const k = keyOf(caseId, rel);
  if (!S.files.has(k)) {
    S.files.set(k, { key: k, case: caseId, path: rel, version: 0, sha: null, mode: null,
      holders: [], queue: [], writes: 0, lastWriteAt: null });
  }
  return S.files.get(k);
}
/* 结算规则：一轮能不能算“完成”，由这里统一判定，不让单个角色自说自话 */
function usageOf(caseId) {
  if (!usage.has(caseId)) usage.set(caseId, {});
  return usage.get(caseId);
}

function readinessOf(caseId) {
  const list = reviews.get(caseId) || [];
  const blockers = [];
  list.forEach(r => {
    if (r.status === "waived") return;
    const cur = fileOf(caseId, r.path).version;
    if (r.status === "requested") blockers.push({ kind: "pending_review", id: r.id, service: r.service, path: r.path, version: r.version });
    else if (r.version < cur) blockers.push({ kind: "stale_review", id: r.id, service: r.service, path: r.path, version: r.version, currentVersion: cur });
    else if (r.status === "returned") blockers.push({ kind: "returned", id: r.id, service: r.service, path: r.path, version: r.version });
    else if (r.status === "conditional") blockers.push({ kind: "conditional", id: r.id, service: r.service, path: r.path, version: r.version, findings: (r.findings || []).length });
  });
  const pendingNeeds = (needs.get(caseId) || []).filter(n => n.status === "pending");
  pendingNeeds.forEach(n => blockers.push({ kind: "need", id: n.id, agent: n.agent, title: n.title }));
  return { case: caseId, ready: blockers.length === 0, blockers,
    counts: { reviews: list.length, pendingNeeds: pendingNeeds.length } };
}

function caseOf(caseId) {
  if (!S.cases.has(caseId)) S.cases.set(caseId, { id: caseId, gates: {}, createdAt: Date.now() });
  return S.cases.get(caseId);
}
// mission.md 是给员工看的任务书；标的允许"待定"，所以这里只是把已知字段读出来给面板展示
function parseMission(caseId) {
  try {
    const text = fs.readFileSync(vaultPath(caseId, "mission.md"), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^- ([^:]+): (.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    const target = out["标的"] || "";
    const kind = out["标的类型"] || "";
    return { case: caseId, displayName: out["显示名"] || caseNames.get(caseId) || caseId,
      // 面板上别让一整句"待定（创建后通过对话补齐……）"顶满一行，长说明只留在 mission.md 里
      target: /^待定/.test(target) ? "标的待定" : target,
      kind: /^待定/.test(kind) ? "" : kind,
      task: out["任务"] || "", roles: out["参与角色"] || "",
      audience: out["受众与用途"] || "", horizon: out["期限"] || "" };
  } catch (e) { return null; }
}
function safeRel(rel) {
  const cleaned = String(rel || "").replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some(p => p === ".." || p === "")) return null;
  return cleaned;
}
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

/* ---------------------------------------------------------------- 账本 */
function laneOf(actor) { return AGENT_IDS.has(actor) ? actor : "lead"; }
const runningWork = new Map();  // workItemId -> {case,agent,nodeId,startedAt,heartbeatAt,leaseUntil,owner}
const runningSteps = new Map(); // key -> {case,agent,stage,startedAt,seq}
const runningRuns = new Map();   // key -> {case,agent,startedAt,seq}
const watchdogAlerts = new Map();
let lastWatchdogAt = 0;
const WATCHDOG = Object.assign({ enabled: true, intervalMs: 2000, stepTimeoutMs: 30 * 60 * 1000,
  runTimeoutMs: 30 * 60 * 1000, workHeartbeatMs: 60 * 1000,
  requeueOnLease: true, maxAttempts: 3, backoffMs: 5000, backoffMaxMs: 60000,
  pauseOnExhausted: false, recoverStalled: true, stallThresholdMs: 60000,
  recoverCooldownMs: 120000, autoRetryFailed: true, failedRetryCooldownMs: 30000,
  progressTimeoutMs: 10 * 60 * 1000, progressCooldownMs: 15 * 60 * 1000,
  progressHardTimeoutMs: 25 * 60 * 1000, progressRequeueOnHard: false },
  (CONFIG.watchdog || {}));
const pausedCases = new Set();
const completions = new Map(); // caseId -> latest completion
const completionsByPlan = new Map(); // caseId|planId -> completion
function invalidateCompletionNeed(caseId, needId) {
  const c = completions.get(caseId);
  if (!c || !Array.isArray(c.options)) return false;
  const before = c.options.length;
  c.options = c.options.filter(o => !(o && o.payload && o.payload.needId === needId));
  if (c.options.length === before) return false;
  if (!c.options.length) {
    completions.delete(caseId);
    if (c.planId) completionsByPlan.delete(caseId + "|" + c.planId);
    emit("completion.cleared", "system", { case: caseId, planId: c.planId || "", needId });
  } else {
    c.updatedAt = new Date().toISOString();
    completions.set(caseId, c);
    if (c.planId) completionsByPlan.set(caseId + "|" + c.planId, c);
    emit("completion.updated", "system", { case: caseId, planId: c.planId || "", needId });
  }
  return true;
}
const reportSignatures = new Map(); // caseId -> { path: {by,at,version} }
const completionSeen = new Set(); // case|plan
const autoRuns = new Map(); // case|plan -> pid
function runLockFile(caseId, planId) {
  const c = encodeURIComponent(String(caseId || "default")).replace(/%/g, "_");
  return path.join(ROOT, "runtime/auto-runs", c + "-" + planId + ".lock");
}
function pidInPgrep(pid) {
  try {
    const r = spawnSync("pgrep", ["-x", "node"], { encoding: "utf8" });
    if (r.status === 0 && String(r.stdout || "").split(/\s+/).indexOf(String(pid)) >= 0) return true;
  } catch (e) {}
  try {
    const r = spawnSync("pgrep", ["-fl", String(pid)], { encoding: "utf8" });
    if (r.status === 0) {
      const hit = String(r.stdout || "").split(String.fromCharCode(10)).some(line => String(line).trim().split(/\s+/)[0] === String(pid));
      if (hit) return true;
    }
  } catch (e) {}
  return false;
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e && e.code === "EPERM"; }
  // macOS 上已退出但未被回收的进程是 Z 状态，kill -0 仍返回成功；不能当成活 runner。
  try {
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    const st = String((r && r.stdout) || "").trim();
    if (st) return !/^Z/.test(st);
    // ps 在沙箱/权限受限时可能直接失败；此时用 pgrep 精确核对 PID，避免误判。
    if (r && r.status === 1) return false;
  } catch (e) {}
  return pidInPgrep(pid);
}
function readRunLock(caseId, planId) {
  try {
    const j = JSON.parse(fs.readFileSync(runLockFile(caseId, planId), "utf8"));
    if (j && pidAlive(j.pid)) return j;
  } catch (e) {}
  return null;
}
function writeRunLock(caseId, planId, pid) {
  try {
    fs.mkdirSync(path.join(ROOT, "runtime/auto-runs"), { recursive: true });
    fs.writeFileSync(runLockFile(caseId, planId), JSON.stringify({ case: caseId, planId, pid,
      at: new Date().toISOString() }));
  } catch (e) {}
}
function clearRunLock(caseId, planId, pid) {
  try {
    const f = runLockFile(caseId, planId);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!pid || j.pid === pid) fs.unlinkSync(f);
  } catch (e) {}
}
function adoptRunLocks() {
  const dir = path.join(ROOT, "runtime/auto-runs");
  let adopted = 0, stale = 0;
  try {
    fs.readdirSync(dir).filter(f => /\.lock$/.test(f)).forEach(f => {
      const full = path.join(dir, f);
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        if (j && j.case && j.planId && pidAlive(j.pid)) {
          autoRuns.set(j.case + "|" + j.planId, j.pid); adopted += 1;
        } else { fs.unlinkSync(full); stale += 1; }
      } catch (e) { try { fs.unlinkSync(full); } catch (x) {} }
    });
  } catch (e) {}
  if (adopted || stale) console.log("[broker] run locks: adopted=" + adopted + " stale=" + stale);
}
const stallSince = new Map(); // case|plan -> first seen stalled at
const lastRecovery = new Map(); // case|plan -> last recovery at
const lastFailedRetry = new Map(); // workId -> last auto retry at
const caseTokens = new Map();
const quotaReservations = new Map(); // sourceId -> [{id,cost,until,jobId}]
const QUOTA_FILE = path.join(ROOT, "runtime/data/quota-reservations.json");
let quotaResSeq = 0, quotaLoaded = false;
function loadQuotaReservations() {
  if (quotaLoaded) return;
  quotaLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
    (j.reservations || []).forEach(r => {
      if (!r || !r.sourceId || r.until <= Date.now()) return;
      const list = quotaReservations.get(r.sourceId) || [];
      list.push(r); quotaReservations.set(r.sourceId, list);
      quotaResSeq = Math.max(quotaResSeq, Number(String(r.id || "").replace(/[^0-9]/g, "")) || 0);
    });
  } catch (e) {}
}
function saveQuotaReservations() {
  try {
    const reservations = [];
    for (const list of quotaReservations.values()) for (const r of list) if (r.until > Date.now()) reservations.push(r);
    fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ reservations }, null, 2));
  } catch (e) {}
}
function quotaReserved(sourceId) {
  loadQuotaReservations();
  const now = Date.now(); let sum = 0;
  const list = quotaReservations.get(sourceId) || [];
  for (const r of list) { if (r.until > now) sum += Number(r.cost) || 0; }
  quotaReservations.set(sourceId, list.filter(r => r.until > now));
  return sum;
}
function reserveQuota(source, cost, ttlMs, jobId) {
  const c = Math.max(0, Number(cost) || 0);
  const src = source || {};
  const sourceId = String(src.id || "");
  const a = src.access || {};
  const quota = Number((a.cost && a.cost.dailyQuota) || a.dailyQuota || 0) || 0;
  if (quota > 0 && sourceUsage.usedToday(sourceId) + quotaReserved(sourceId) + c > quota) {
    return { ok: false, error: "今日配额不足：" + (sourceUsage.usedToday(sourceId) + quotaReserved(sourceId)) + "/" + quota };
  }
  const id = "QR" + (++quotaResSeq);
  const list = quotaReservations.get(sourceId) || [];
  list.push({ id, sourceId, cost: c, until: Date.now() + (ttlMs || 120000), jobId: jobId || "" });
  quotaReservations.set(sourceId, list);
  saveQuotaReservations();
  return { ok: true, id, cost: c, quota };
}
const sourceRate = new Map(); // sourceId -> [ms]
const sourceCircuit = new Map(); // sourceId -> {failures, openUntil}
function checkRate(source) {
  const id = String(source && source.id || "");
  const a = (source && source.access) || {};
  const perMin = Number((a.rateLimit && a.rateLimit.perMinute) || a.perMinute || 60) || 60;
  const now = Date.now();
  const arr = (sourceRate.get(id) || []).filter(t => now - t < 60000);
  if (arr.length >= perMin) return { ok: false, error: "来源限流：" + arr.length + "/" + perMin + " per min", code: "rate_limited" };
  arr.push(now); sourceRate.set(id, arr);
  return { ok: true };
}
function circuitState(sourceId) {
  const c = sourceCircuit.get(sourceId);
  if (c && c.openUntil && c.openUntil > Date.now()) return { open: true, until: c.openUntil, failures: c.failures || 0 };
  if (c && c.openUntil && c.openUntil <= Date.now()) { sourceCircuit.delete(sourceId); }
  return { open: false, failures: (c && c.failures) || 0 };
}
function recordCircuit(sourceId, ok) {
  const c = sourceCircuit.get(sourceId) || { failures: 0, openUntil: 0 };
  if (ok) { sourceCircuit.set(sourceId, { failures: 0, openUntil: 0 }); return; }
  c.failures = (c.failures || 0) + 1;
  if (c.failures >= 5) c.openUntil = Date.now() + 10 * 60 * 1000;
  sourceCircuit.set(sourceId, c);
}
function releaseQuota(id) {
  for (const [sid, list] of quotaReservations.entries()) {
    const next = list.filter(r => r.id !== id);
    if (next.length !== list.length) { quotaReservations.set(sid, next); saveQuotaReservations(); return true; }
  }
  return false;
}
const budgetAlerted = new Set();
const BUDGETS = Object.assign({ maxTokensPerCase: 0, maxChildTokensPerParent: 1000000,
  defaultWorkReserve: 60000, reservationTtlMs: 30 * 60 * 1000 }, (CONFIG.budgets || {}));
// 预算预留：claim/loop 启动前先占住上限，结束时释放；agent.usage 仍按实际 token 计入 caseTokens。
const caseReserved = new Map();
const budgetReservations = new Map();
let budgetResSeq = 0;
const BUDGET_RES_TTL_MS = Math.max(60000, Number(BUDGETS.reservationTtlMs) || 30 * 60 * 1000);
function budgetPrune() {
  const now = Date.now();
  for (const [id, r] of Array.from(budgetReservations.entries())) {
    if (!r.expiresAt || r.expiresAt > now) continue;
    budgetReservations.delete(id);
    caseReserved.set(r.case, Math.max(0, (caseReserved.get(r.case) || 0) - r.amount));
    emit("budget.reservation_expired", "system", { case: r.case, reservationId: id,
      amount: r.amount, workId: r.workId, loopId: r.loopId, owner: r.owner });
  }
}
function budgetSnapshot(caseId) {
  budgetPrune();
  const tokens = caseTokens.get(caseId) || 0;
  const reserved = caseReserved.get(caseId) || 0;
  const limit = Number(BUDGETS.maxTokensPerCase) || 0;
  const available = limit > 0 ? Math.max(0, limit - tokens - reserved) : null;
  return { case: caseId, tokens, reserved, limit, available,
    remaining: limit > 0 ? Math.max(0, limit - tokens - reserved) : null,
    exceeded: limit > 0 && tokens + reserved >= limit };
}
function reserveCaseBudget(caseId, amount, meta) {
  budgetPrune();
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const m = meta || {};
  const snap = budgetSnapshot(caseId);
  if (snap.limit <= 0 || amt <= 0) return { ok: true, reservation: null, budget: snap };
  if (snap.tokens + snap.reserved + amt > snap.limit) {
    return { ok: false, reason: "budget", budget: snap, requested: amt,
      available: Math.max(0, snap.limit - snap.tokens - snap.reserved) };
  }
  const id = "BR" + (++budgetResSeq);
  const r = { id, case: caseId, amount: amt, workId: m.workId || "", loopId: m.loopId || "",
    owner: m.owner || "", createdAt: new Date().toISOString(), expiresAt: Date.now() + BUDGET_RES_TTL_MS };
  budgetReservations.set(id, r);
  caseReserved.set(caseId, (caseReserved.get(caseId) || 0) + amt);
  emit("budget.reserved", r.owner || "system", { case: caseId, reservationId: id, amount: amt,
    workId: r.workId, loopId: r.loopId, tokens: snap.tokens, reserved: snap.reserved + amt, limit: snap.limit });
  return { ok: true, reservation: r, budget: budgetSnapshot(caseId) };
}
function releaseCaseBudget(reservationId, opts) {
  const id = String(reservationId || "");
  const r = budgetReservations.get(id);
  if (!r) return { ok: false, error: "reservation not found" };
  budgetReservations.delete(id);
  caseReserved.set(r.case, Math.max(0, (caseReserved.get(r.case) || 0) - r.amount));
  const o = opts || {};
  const actual = (o.actualTokens === undefined || o.actualTokens === null) ? null : Math.max(0, Math.round(Number(o.actualTokens) || 0));
  emit(actual === null ? "budget.released" : "budget.committed", o.owner || r.owner || "system",
    { case: r.case, reservationId: id, amount: r.amount, actualTokens: actual,
      workId: r.workId, loopId: r.loopId, reason: String(o.reason || "").slice(0, 200),
      tokens: caseTokens.get(r.case) || 0, reserved: caseReserved.get(r.case) || 0,
      limit: Number(BUDGETS.maxTokensPerCase) || 0 });
  if (actual !== null && actual > r.amount) {
    emit("budget.overspent", o.owner || r.owner || "system", { case: r.case, reservationId: id,
      amount: r.amount, actualTokens: actual, over: actual - r.amount, workId: r.workId, loopId: r.loopId });
  }
  return { ok: true, reservation: r, actualTokens: actual, budget: budgetSnapshot(r.case) };
}
function releaseWorkBudget(w, reason) {
  if (!w || !w.budgetReservation) return;
  try { releaseCaseBudget(w.budgetReservation, { actualTokens: w.tokens || 0, owner: w.owner || "worker",
    reason: reason || "work.finish" }); } catch (e) {}
  w.budgetReservation = ""; w.budgetReserved = 0;
}
const SCHED = Object.assign({ maxConcurrency: 1, leaseMs: 120000, heartbeatMs: 15000 },
  (CONFIG.scheduler || {}));
function maxSlotsOf(agent) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/workers.json"), "utf8"));
    const w = (reg.workers || []).find(x => x.agent === agent);
    return w && w.maxSlots ? w.maxSlots : 1;
  } catch (e) { return 1; }
}
function watchdogKey(caseId, actor, stage) { return caseId + "|" + actor + "|" + (stage || ""); }
const PROGRESS_TYPES = new Set(["agent.run.started", "agent.step.started", "agent.step.finished",
  "file.written", "file.uploaded", "agent.model_actual"]);
function markWorkProgress(e) {
  if (!e.case || !e.actor) return;
  const list = works.get(e.case) || [];
  const label = e.type === "file.written" ? ("写入 " + String(e.path || "").split("/").pop())
    : e.type === "file.uploaded" ? ("上传 " + String(e.path || e.name || "").split("/").pop())
    : e.type === "agent.step.started" ? ("开始 " + (e.stage || "步骤"))
    : e.type === "agent.step.finished" ? ("完成 " + (e.stage || "步骤"))
    : e.type === "agent.run.started" ? "员工会话启动"
    : "模型调用完成";
  list.forEach(w => {
    if (w.state !== "running" && w.state !== "cancelling") return;
    if (w.agent !== e.actor) return;
    if (e.stage && w.nodeId && e.stage !== w.nodeId) return;
    w.lastProgressAt = e.ts;
    w.lastProgressText = label;
    w.progressStalled = false;
    w.progressAlertedAt = 0;
    w.progressHardAlertedAt = 0;
  });
}
function watchdogObserve(e) {
  if (PROGRESS_TYPES.has(e.type)) markWorkProgress(e);
  if (e.type === "agent.step.started") {
    runningSteps.set(watchdogKey(e.case, e.actor, e.stage), { case: e.case, agent: e.actor,
      stage: e.stage || "", startedAt: Date.parse(e.ts) || Date.now(), seq: e.seq });
  } else if (e.type === "agent.step.finished" || e.type === "agent.step.failed") {
    runningSteps.delete(watchdogKey(e.case, e.actor, e.stage));
    watchdogAlerts.delete(watchdogKey(e.case, e.actor, e.stage));
  } else if (e.type === "agent.run.started") {
    runningRuns.set(watchdogKey(e.case, e.actor, ""), { case: e.case, agent: e.actor,
      startedAt: Date.parse(e.ts) || Date.now(), seq: e.seq });
  } else if (e.type === "agent.run.finished" || e.type === "agent.run.failed") {
    runningRuns.delete(watchdogKey(e.case, e.actor, ""));
    watchdogAlerts.delete(watchdogKey(e.case, e.actor, ""));
  }
  if (e.type === "work.started") {
    runningWork.set(e.workId, { case: e.case, agent: e.agent, nodeId: e.nodeId,
      startedAt: Date.parse(e.ts) || Date.now(), heartbeatAt: Date.now(), owner: e.owner || "" });
    const wi = (works.get(e.case) || []).find(x => x.id === e.workId);
    if (wi) { wi.lastProgressAt = e.ts; wi.lastProgressText = "任务开始：" + (wi.name || e.nodeId || ""); }
  } else if (e.type === "work.heartbeat") {
    const w = runningWork.get(e.workId); if (w) w.heartbeatAt = Date.now();
  } else if (e.type === "work.finished" || e.type === "work.failed" || e.type === "work.cancelled") {
    runningWork.delete(e.workId);
    watchdogAlerts.delete("work|" + e.workId);
  } else if (e.type === "work.requeued") {
    runningWork.delete(e.workId);
    watchdogAlerts.delete("work|" + e.workId);
  }
}
function emit(type, actor, payload) {
  S.seq += 1;
  const lane = (payload && payload.lane) ||
    (type === "task.assigned" && payload && payload.agent ? payload.agent : laneOf(actor));
  const isGraph = GRAPH_TYPES.has(type);
  const parents = isGraph && lastGraphSeq.has(lane) ? [lastGraphSeq.get(lane)] : [];
  const e = Object.assign({ seq: S.seq, ts: new Date().toISOString(), type, actor, lane, parents },
    payload || {});
  if (isGraph) lastGraphSeq.set(lane, e.seq);
  try { fs.appendFileSync(LEDGER, JSON.stringify(e) + "\n"); } catch (err) { console.error("ledger write failed", err); }
  S.events.push(e);
  if (S.events.length > 4000) S.events.splice(0, S.events.length - 4000);
  if (type === "agent.usage" && payload && payload.case) {
    const tok = payload.totalTokens || payload.total || 0;
    caseTokens.set(payload.case, (caseTokens.get(payload.case) || 0) + tok);
    if (payload.workId) {
      const w = (works.get(payload.case) || []).find(x => x.id === payload.workId);
      if (w) { w.tokens = (w.tokens || 0) + tok; w.inputTokens = (w.inputTokens || 0) + (payload.inputTokens || 0);
        w.outputTokens = (w.outputTokens || 0) + (payload.outputTokens || 0); }
    }
  }
  watchdogObserve(e);
  broadcast(e);
  return e;
}

const GRAPH_TYPES = new Set(["file.written", "gate.passed", "gate.failed", "file.conflict",
  "lock.expired", "lock.queued", "lock.timeout", "broker.started", "task.assigned",
  "capability.requested", "capability.approved", "capability.denied", "report.published"]);
const lastGraphSeq = new Map();

const sseClients = new Set();
function broadcast(e) {
  const line = "data: " + JSON.stringify(e) + "\n\n";
  for (const res of sseClients) { try { res.write(line); } catch (_) { sseClients.delete(res); } }
}

/* ---------------------------------------------------------------- 锁 */
function grant(f, waiter) {
  lockSeq += 1;
  const ttl = waiter.ttl || 120;
  const lock = {
    id: "L" + lockSeq, key: f.key, path: f.path, case: f.case,
    actor: waiter.actor, mode: waiter.mode, note: waiter.note || "",
    ttl, until: Date.now() + ttl * 1000, grantedAt: Date.now()
  };
  f.holders.push(lock);
  f.mode = waiter.mode === "W" ? "W" : "R";
  S.locks.set(lock.id, lock);
  S.stats.grants += 1;
  emit("lock.granted", lock.actor, {
    case: f.case, path: f.path, lockId: lock.id, mode: lock.mode, ttl,
    holders: f.holders.length
  });
  waiter.done = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.resolve({ status: 200, body: { lock: publicLock(lock) } });
  return lock;
}

function publicLock(l) {
  return { id: l.id, case: l.case, path: l.path, actor: l.actor, mode: l.mode,
    ttl: l.ttl, expiresInMs: Math.max(0, l.until - Date.now()), note: l.note };
}

function canGrantNow(f, mode) {
  if (f.queue.length > 0) return false;
  if (f.holders.length === 0) return true;
  return mode === "R" && f.mode === "R";
}

function pump(f) {
  if (f.mode === "W") return;
  while (f.queue.length > 0) {
    const head = f.queue[0];
    if (head.done) { f.queue.shift(); continue; }
    if (head.mode === "W") {
      if (f.holders.length > 0) return;      // 等读者排空
      f.queue.shift();
      grant(f, head);
      return;
    }
    const hasWriter = f.queue.some(w => w.mode === "W" && !w.done);
    if (hasWriter) { f.queue.shift(); grant(f, head); return; }   // 写优先：只放一个读
    while (f.queue.length && f.queue[0].mode === "R" && !f.queue[0].done) grant(f, f.queue.shift());
    return;
  }
}

function releaseLock(lockId, reason) {
  const lock = S.locks.get(lockId);
  if (!lock) return null;
  const f = S.files.get(lock.key);
  S.locks.delete(lockId);
  if (f) {
    f.holders = f.holders.filter(h => h.id !== lockId);
    if (f.holders.length === 0) f.mode = null;
    emit("lock.released", lock.actor, { case: lock.case, path: lock.path, lockId, reason: reason || "released" });
    pump(f);
  }
  return lock;
}

/* 租约回收：每 250ms 扫一次 */
setInterval(() => {
  const now = Date.now();
  for (const [lockId, lock] of Array.from(S.locks.entries())) {
    if (lock.until <= now) {
      S.stats.expired += 1;
      const f = S.files.get(lock.key);
      if (f) {
        f.holders = f.holders.filter(h => h.id !== lockId);
        if (f.holders.length === 0) f.mode = null;
        emit("lock.expired", lock.actor, { case: lock.case, path: lock.path, lockId, heldMs: now - lock.grantedAt });
        S.locks.delete(lockId);
        pump(f);
      } else { S.locks.delete(lockId); }
    }
  }
}, 250).unref();

/* ---------------------------------------------------------------- HTTP 工具 */
const CORS = { "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type" };
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, Object.assign({ "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s) }, CORS));
  res.end(s);
}
function html(res, status, body) {
  res.writeHead(status, Object.assign({ "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body), "cache-control": "no-store" }, CORS));
  res.end(body);
}
function servePanel(res, file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return json(res, 404, { error: "panel not built", path: file });
  const body = fs.readFileSync(abs);
  res.writeHead(200, Object.assign({ "content-type": "text/html; charset=utf-8",
    "content-length": body.length, "cache-control": "no-store" }, CORS));
  res.end(body);
}
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = "";
    const max = maxBytes || 8e6;
    req.on("data", c => { data += c; if (data.length > max) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e5) reject(new Error("body too large")); });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on("error", reject);
  });
}

/* ---------------------------------------------------------------- 访问口令
 * 默认只听 127.0.0.1，不需要口令。要 --host 0.0.0.0 暴露到局域网时，必须 --token：
 * 浏览器第一次带 ?token= 或走 /login，之后靠 cookie；本机回环进程（员工/desk/pipeline）免口令。
 */
function isLoopback(req) {
  if (!TRUST_LOOPBACK) return false;
  const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}
function tokenMatches(x) {
  if (!TOKEN || typeof x !== "string" || !x) return false;
  const a = crypto.createHash("sha256").update(x).digest();
  const h = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(a, h);
}
function tokenOk(req, u) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)dsh_panel=([^;]*)/);
  if (m && tokenMatches(decodeURIComponent(m[1]))) return true;
  return tokenMatches(u.searchParams.get("token") || "");
}
function cookieHeader() {
  return "dsh_panel=" + encodeURIComponent(TOKEN) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000";
}
function loginHTML(err) {
  return ["<!doctype html><html lang=zh><head><meta charset=utf-8>",
    "<meta name=viewport content='width=device-width,initial-scale=1'>",
    "<title>AlphaDesk · 输入口令</title><style>",
    "body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;",
    "font:14px/1.6 -apple-system,'PingFang SC',sans-serif;background:#f6f7f9;color:#1e293b}",
    ".box{background:#fff;border:1px solid #d8dee7;border-radius:12px;padding:28px 32px;width:320px;",
    "box-shadow:0 8px 24px rgba(15,23,42,.08)}h1{font-size:16px;margin:0 0 4px}",
    "p{margin:0 0 18px;color:#64748b;font-size:12px}input{width:100%;box-sizing:border-box;",
    "padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}",
    "button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:8px;background:#2563eb;",
    "color:#fff;font-size:14px;cursor:pointer}.err{margin-top:12px;color:#b42318;font-size:12px}",
    "</style></head><body><form class=box method=post action=/login>",
    "<h1>AlphaDesk 面板</h1><p>这台 broker 开了访问口令（--token）</p>",
    "<input name=token type=password placeholder=访问口令 autofocus autocomplete=off>",
    "<button type=submit>进入面板</button>",
    err ? "<div class=err>" + err + "</div>" : "",
    "</form></body></html>"].join("");
}

/* ---------------------------------------------------------------- 路由 */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    // 口令门：只有设了 --token / PANEL_TOKEN 才启用；本机回环请求（员工、desk、pipeline）免口令
    if (TOKEN && !isLoopback(req)) {
      if (p === "/login" && req.method === "POST") {
        const form = await readForm(req);
        if (!tokenMatches(form.token || "")) return html(res, 401, loginHTML("口令不对，再试一次"));
        res.writeHead(302, { "set-cookie": cookieHeader(), location: "/live" });
        return res.end();
      }
      if (!tokenOk(req, u)) {
        if (p.startsWith("/api/")) return json(res, 401, { error: "需要口令：先访问 /login 或带 ?token=" });
        return html(res, 200, loginHTML(""));
      }
      if (u.searchParams.has("token")) {
        // 用 ?token= 进来后换成 cookie，地址栏里不留口令
        const q2 = new URLSearchParams(u.search);
        q2.delete("token");
        const loc = p + (q2.toString() ? "?" + q2.toString() : "");
        res.writeHead(302, { "set-cookie": cookieHeader(), location: loc });
        return res.end();
      }
    }
    if (p === "/live" || p === "/live/") {
      // 保留调用方带来的全部参数（sel / model / case …），只补 live=1
      const qs = new URLSearchParams(u.search);
      qs.set("live", "1");
      // 不强行补 case：让前端从 localStorage 恢复上次 case；没有则用默认
      res.writeHead(302, Object.assign({ location: "/?" + qs.toString() }, CORS));
      return res.end();
    }
    if (p === "/" || p === "/panel" || p === "/index.html") return servePanel(res, "dashboard/mockup.html");
    if (p === "/api/agents" && req.method === "GET") {
      const dir = path.join(ROOT, "agents");
      const read = f => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } };
      return json(res, 200, {
        common: read(path.join(dir, "_COMMON.md")),
        roles: AGENT_LIST.map(a => ({ id: a.id, name: a.name, glyph: a.glyph,
          tier: a.tier || "base", prompt: read(path.join(ROOT, a.role)) }))
      });
    }
    function loadDataRegistry() {
      const metrics = [];
      const sources = [];
      try {
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
        (j.metrics || []).forEach(m => metrics.push(m));
      } catch (e) {}
      try {
        const dir = path.join(ROOT, "config/data/domains");
        fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
          try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            (j.metrics || []).forEach(m => metrics.push(Object.assign({ domain: j.id }, m))); } catch (e) {}
        });
      } catch (e) {}
      try {
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/sources.json"), "utf8"));
        (j.sources || []).forEach(x => sources.push(x));
      } catch (e) {}
      return { metrics, sources };
    }
    function metricMatches(m, q) {
      const s = String(q || "").toLowerCase();
      if (!s) return true;
      return [m.id, m.name, m.domain, ...(m.aliases || [])].join(" ").toLowerCase().indexOf(s) >= 0;
    }
    function metricSources(metric, sources) {
      // 显式 sources 数组顺序 = fallback 顺序（免费优先，积分/账号源在后）。
      return sourceChain.metricSources(metric, sources);
    }
    if (p === "/api/data/jobs" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "";
      const status = u.searchParams.get("status") || "";
      return json(res, 200, { jobs: listDataJobs(caseId).filter(j => !status || j.status === status) });
    }
    if (p === "/api/data/gateway" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const sourceId = String(b.sourceId || "").slice(0, 80);
      if ((b.mode === "web_agent" || b.mode === "raw") && b.url) {
        let u = null; try { u = new URL(String(b.url)); } catch (e) { return json(res, 400, { error: "invalid url" }); }
        if (!/^https?:$/.test(u.protocol)) return json(res, 400, { error: "only http(s)" });
        const host = String(u.hostname || "").toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || /^10\./.test(host) ||
          /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return json(res, 400, { error: "内网/本机地址被策略阻断：" + host, code: "private_host" });
        }
        const key = String(b.idempotencyKey || dataGateway.hash([caseId, "web_agent", b.url, b.goal || ""].join("|"))).slice(0, 120);
        const r = await dataGateway.request({ case: caseId, sourceId: "__url__",
          query: { mode: b.mode, url: b.url, goal: b.goal || "", maxSteps: b.maxSteps, maxPages: b.maxPages },
          idempotencyKey: key, forceRefresh: b.forceRefresh === true });
        emit("data.gateway", b.by || "datatask", { case: caseId, sourceId: "__url__", mode: b.mode,
          cached: !!r.cached, ok: !!r.ok, snapshot: r.snapshot || null });
        return json(res, r.ok ? 200 : 502, r);
      }
      if (!sourceId) return json(res, 400, { error: "sourceId required" });
      const reg = loadDataRegistry();
      const src = (reg.sources || []).find(s => s.id === sourceId || s.configSource === sourceId) || null;
      if (!src) return json(res, 404, { error: "source not found: " + sourceId });
      const cs = circuitState(sourceId);
      if (cs.open) return json(res, 503, { error: "来源熔断中，稍后重试", code: "circuit_open",
        sourceId, openUntil: cs.until, failures: cs.failures });
      const rate = checkRate(src);
      if (!rate.ok) return json(res, 429, { error: rate.error, code: rate.code, sourceId });
      const pc = sourcePolicy.checkSource(src, { allowPaid: b.allowPaid === true });
      if (!pc.ok) return json(res, 409, { error: pc.reason, code: pc.code, sourceId, cost: pc.cost || null });
      const metric = (reg.metrics || []).find(m => m.id === b.metricId || (m.aliases || []).indexOf(b.metricId) >= 0) || null;
      const query = b.query && typeof b.query === "object" ? b.query : { range: b.range || "" };
      const key = String(b.idempotencyKey || dataGateway.hash([caseId, b.metricId || "", sourceId, JSON.stringify(query)].join("|"))).slice(0, 120);
      const qr = reserveQuota(src, pc.cost && pc.cost.perCall || 0, 180000, b.jobId || "");
      if (!qr.ok) return json(res, 409, { error: qr.error, code: "quota_exhausted", sourceId });
      let r = null;
      try {
        r = await dataGateway.request({ case: caseId, sourceId, metricId: b.metricId || "", metric,
          query, idempotencyKey: key, jobId: b.jobId || "", forceRefresh: b.forceRefresh === true });
      } catch (e) {
        releaseQuota(qr.id);
        return json(res, 500, { error: String(e && e.message || e), sourceId });
      }
      if (!r || !r.ok) {
        releaseQuota(qr.id);
        recordCircuit(sourceId, false);
        return json(res, 502, { ok: false, sourceId, error: (r && r.error) || "gateway failed",
          records: (r && r.records) || [], idempotencyKey: key });
      }
      recordCircuit(sourceId, true);
      if (!r.cached) {
        sourceUsage.record({ sourceId, cost: qr.cost, case: caseId, jobId: b.jobId || "", status: "ok", note: "gateway" });
      }
      releaseQuota(qr.id);
      emit("data.gateway", b.by || "data-worker", { case: caseId, sourceId, metricId: b.metricId || "",
        jobId: b.jobId || "", cached: !!r.cached, count: (r.records || []).length, cost: r.cached ? 0 : qr.cost,
        snapshot: r.snapshot || null });
      return json(res, 200, r);
    }
    if (p === "/api/data/request" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.needId);
      if (!n) return json(res, 404, { error: "no such need" });
      const idx = b.itemIndex === undefined || b.itemIndex === null ? null : Number(b.itemIndex);
      const item = (n.spec && n.spec.items || [])[idx];
      const reg = loadDataRegistry();
      let metric = b.metric ? reg.metrics.find(m => m.id === b.metric || (m.aliases || []).indexOf(b.metric) >= 0) : null;
      if (!metric && item) {
        const rr = metricResolver.resolve(item, reg.metrics);
        if (rr && rr.metricId) metric = reg.metrics.find(m => m.id === rr.metricId);
      }
      const range = String(b.range || (item && item.range) || "").slice(0, 60);
      if (metric) {
        const sel = sourcePolicy.selectSource(metric, reg.sources, {
          allowPaid: b.allowPaid === true, allowCredential: b.allowCredential !== false,
          requireStructured: true });
        if (sel.source) {
          const job = createDataJob(caseId, metric, sel.source.id, range, n.id, idx,
            b.by || "you", n.agent, [sel.source.id], b.allowPaid === true, b.forceRefresh === true);
          return json(res, 200, { ok: true, kind: "data_job", metric: metric.id,
            sourceId: sel.source.id, job, skipped: sel.skipped });
        }
        const code = sel.check ? sel.check.code : "no_source";
        if (code === "needs_credential" || code === "needs_paid_approval") {
          return json(res, 409, { ok: false, kind: code, metric: metric.id,
            sourceId: sel.check.sourceId || "", reason: sel.check.reason,
            homepage: sel.check.homepage || "", cost: sel.check.cost || null, skipped: sel.skipped });
        }
        if (b.url || (Array.isArray(b.sources) && b.sources.length)) {
          const r = createDataTaskForNeed(caseId, n, idx === null ? [] : [idx], b.sources || [{ kind: "url", ref: b.url }],
            b.policy, b.by);
          if (r.error) return json(res, 409, { error: r.error, kind: "data_task_error" });
          return json(res, 200, { ok: true, kind: "data_task", metric: metric.id, task: dataTaskView(r.task) });
        }
        return json(res, 409, { ok: false, kind: "needs_source", metric: metric.id,
          reason: sourceChain.noSourceReason(sel.skipped || [], metric), skipped: sel.skipped || [] });
      }
      if (b.url || (Array.isArray(b.sources) && b.sources.length)) {
        const r = createDataTaskForNeed(caseId, n, idx === null ? [] : [idx], b.sources || [{ kind: "url", ref: b.url }],
          b.policy, b.by);
        if (r.error) return json(res, 409, { error: r.error, kind: "data_task_error" });
        return json(res, 200, { ok: true, kind: "data_task", task: dataTaskView(r.task) });
      }
      return json(res, 409, { ok: false, kind: "needs_source",
        reason: "没有匹配 metric，也没有提供 URL/文件；请建 draft 指标或提供来源" });
    }
    if (p === "/api/data/jobs" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const metric = String(b.metric || "").slice(0, 80);
      if (!metric) return json(res, 400, { error: "metric required" });
      let sourceId = String(b.sourceId || "").slice(0, 60);
      const url = String(b.url || "").slice(0, 1000);
      // 手工建任务也走免费优先链：只给 metric 时自动选可用来源。
      let chain = [];
      if (!sourceId && !url) {
        const reg = loadDataRegistry();
        const m = reg.metrics.find(x => x.id === metric || (x.aliases || []).indexOf(metric) >= 0);
        if (m) { const bc = sourceChain.buildChain(m, reg.sources); chain = bc.chain;
          if (!chain.length) return json(res, 409, { error: "no available source", reason: sourceChain.noSourceReason(bc.skipped, m), skipped: bc.skipped }); }
      }
      if (!sourceId && !url && chain.length) sourceId = chain[0];
      if (!sourceId && !url) return json(res, 400, { error: "sourceId or url required" });
      const id = "DJ" + Date.now().toString(36) + (++dataJobSeq);
      const jobChain = (Array.isArray(b.sourceChain) && b.sourceChain.length
        ? b.sourceChain.map(x => String(x).slice(0, 60)).slice(0, 20)
        : (chain.length ? chain : (sourceId ? [sourceId] : [])));
      if (!sourceId && jobChain.length) sourceId = jobChain[0];
      const job = { id, case: caseId, metric, sourceId, sourceChain: jobChain, sourceAttempts: [], url, vars: b.vars || {},
        needId: String(b.needId || ""), index: b.index === undefined || b.index === null ? null : Number(b.index),
        agent: String(b.agent || "industry").slice(0, 20),
        range: String(b.range || "").slice(0, 40), status: "queued", attempts: 0,
        allowPaid: b.allowPaid === true, forceRefresh: b.forceRefresh === true,
        maxAttempts: Number(b.maxAttempts) || 3, lastError: "",
        records: [], coverage: 0, expected: 0, missing: [], raw: "", out: "",
        error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: "" };
      writeDataJob(job);
      emit("data.job.queued", b.by || "you", { case: caseId, jobId: id, metric, sourceId, url });
      return json(res, 200, { job });
    }
    if (p === "/api/data/job/claim" && req.method === "POST") {
      const b = await readBody(req);
      const job = readDataJob(String(b.id || ""));
      if (!job) return json(res, 404, { error: "job not found" });
      if (job.status !== "queued") return json(res, 409, { error: "not queued", status: job.status });
      job.status = "running"; job.owner = b.owner || "data-worker"; job.attempts += 1; job.updatedAt = new Date().toISOString();
      writeDataJob(job);
      emit("data.job.started", job.owner, { case: job.case, jobId: job.id, metric: job.metric, sourceId: job.sourceId });
      return json(res, 200, { job });
    }
    if (p === "/api/data/job/update" && req.method === "POST") {
      const b = await readBody(req);
      const job = readDataJob(String(b.id || ""));
      if (!job) return json(res, 404, { error: "job not found" });
      const prevSourceId = job.sourceId;
      if (b.status) job.status = String(b.status).slice(0, 30);
      if (b.sourceId) job.sourceId = String(b.sourceId).slice(0, 60);
      if (Array.isArray(b.sourceChain)) job.sourceChain = b.sourceChain.map(x => String(x).slice(0, 60)).slice(0, 20);
      if (Array.isArray(b.sourceAttempts)) job.sourceAttempts = b.sourceAttempts.slice(0, 20);
      if (b.crossCheck) job.crossCheck = b.crossCheck;
      if (b.failureNeedId) job.failureNeedId = String(b.failureNeedId).slice(0, 20);
      if (b.lastError) job.lastError = String(b.lastError).slice(0, 1000);
      if (Array.isArray(b.records)) job.records = b.records.slice(0, 5000);
      if (b.coverage !== undefined) job.coverage = Number(b.coverage) || 0;
      if (b.expected !== undefined) job.expected = Number(b.expected) || 0;
      if (Array.isArray(b.missing)) job.missing = b.missing.slice(0, 200);
      if (b.raw) job.raw = String(b.raw).slice(0, 1000);
      if (b.out) job.out = String(b.out).slice(0, 1000);
      if (b.snapshot) job.snapshot = b.snapshot;
      if (b.error) job.error = String(b.error).slice(0, 1000);
      const cov = dataCoverage(job.metric, job.range, job.records);
      job.expected = cov.expected; job.coverage = cov.coverage;
      // 确定性质量门禁：结构/单位/连续/新鲜度任一失败 → 不自动关闭缺口。
      let metricDef = null;
      try { metricDef = (loadDataRegistry().metrics || []).find(m => m.id === job.metric) || null; } catch (e) {}
      let q = null;
      try { q = dataQuality.check(metricDef, job.records, { range: job.range }); } catch (e) {}
      if (q) { job.quality = q; job.dataAsOf = q.dataAsOf || ""; job.stale = !q.fresh; }
      // 自动采集成功后写一条 S# 证据（含 raw snapshot / sha256 / 数据截至），报告和审计才能引用。
      if (job.status === "extracted" && job.records && job.records.length) {
        const beforeEv = job.evidenceId || "";
        try { ensureDataJobEvidence(job); } catch (e) {}
        if (!beforeEv && job.evidenceId) {
          emit("data.job.evidence", "system", { case: job.case, jobId: job.id, metric: job.metric,
            sourceId: job.sourceId, evidenceId: job.evidenceId, sha256: job.evidenceSha || "",
            dataAsOf: job.dataAsOf || "", qualityOk: !!(job.quality && job.quality.ok) &&
              (!job.crossCheck || job.crossCheck.status !== "mismatch"),
            crossCheck: job.crossCheck ? job.crossCheck.status : "" });
        }
      }
      job.updatedAt = new Date().toISOString();
      if (job.status === "failed" && !job.deadLettered) { job.deadLettered = true; appendDeadLetter(job, job.error); }
      writeDataJob(job);
      if (b.sourceId && prevSourceId && b.sourceId !== prevSourceId) {
        emit("data.job.fallback", b.by || job.owner || "data-worker", { case: job.case, jobId: job.id,
          metric: job.metric, from: prevSourceId, to: b.sourceId, attempts: job.sourceAttempts || [] });
      }
      // 采集失败但未到上限时，data-worker 会把 job 放回 queued；这里重新拉起 worker 做退避重试，避免队列卡死。
      if (job.status === "queued" && b.status === "queued") {
        const t = setTimeout(() => { try { spawnDataWorker(job.case); } catch (e) {} }, 5000);
        if (t.unref) t.unref();
      }
      if (job.needId) {
        const n2 = (needs.get(job.case) || []).find(x => x.id === job.needId);
        const it2 = n2 && n2.spec && n2.spec.items ? n2.spec.items[job.index] : null;
        if (it2) {
          const crossOk = !job.crossCheck || job.crossCheck.status !== "mismatch";
          const qualityOk = (!q || q.ok) && crossOk;
          const st = job.status === "extracted"
            ? (!qualityOk ? "needs_review" : (job.coverage >= 100 ? "done" : "partial"))
            : (job.status === "failed" ? "failed" : (job.status === "needs_review" ? "failed" : (job.status === "queued" ? "queued" : "running")));
          let failReason = "";
          if (st === "needs_review") {
            const parts = [];
            if (job.crossCheck && job.crossCheck.status === "mismatch") {
              parts.push("多源校验不一致：" + (job.crossCheck.issues || []).slice(0, 4).join("；"));
            }
            if (q && q.issues && q.issues.length) parts.push("数据质量门禁：" + q.issues.join("；"));
            failReason = parts.join("；") || "数据质量待确认";
          } else if (st === "failed" || st === "no_source") failReason = String(job.lastError || job.error || "").slice(0, 400);
          it2.auto = { status: st, jobId: job.id, metric: job.metric, sourceId: job.sourceId,
            sourceChain: job.sourceChain || [], coverage: job.coverage, reason: failReason,
            evidenceId: job.evidenceId || "", dataAsOf: job.dataAsOf || "",
            quality: q ? { ok: q.ok, issues: q.issues || [], structural: q.structural, fresh: q.fresh } : null,
            crossCheck: job.crossCheck || null,
            at: new Date().toISOString() };
          emit("need.auto", "system", { case: job.case, needId: job.needId, index: job.index, indicator: it2.indicator, auto: it2.auto });
          // 自动采集成功且质量门禁通过、覆盖 100%：回填并关闭缺口。
          if (st === "done" && it2.status !== "provided") {
            it2.status = "provided";
            it2.value = (job.records || []).slice(0, 60).map(r => JSON.stringify(r)).join("\n").slice(0, 4000);
            it2.source = job.url || job.sourceId || "自动采集";
            it2.file = job.out || "";
            it2.note = "自动采集完成（" + (job.id || "") + "）" +
              (job.evidenceId ? " · 证据 [" + job.evidenceId + "]" : "") +
              (job.dataAsOf ? " · 数据截至 " + job.dataAsOf : "");
            it2.providedAt = new Date().toISOString();
            it2.providedBy = "data-worker";
            if (job.evidenceId) it2.evidenceId = job.evidenceId;
            if (job.dataAsOf) it2.dataAsOf = job.dataAsOf;
            markNeedProgress(job.case, n2);
          }
        }
      }
      if (job.needId && job.records && job.records.length) {
        const at = { at: new Date().toISOString(), by: "data-worker", url: job.url || job.sourceId,
          found: "job " + job.id + " records=" + job.records.length,
          coverage: job.coverage, requirement: job.range,
          missing: job.expected && job.coverage < 100 ? "coverage " + job.coverage + "%" : "",
          note: "data queue auto attempt" };
        const n = (needs.get(job.case) || []).find(x => x.id === job.needId);
        const item = n && n.spec && n.spec.items ? n.spec.items[job.index] : null;
        if (item && item.status !== "provided") {
          item.lastIntake = { jobId: job.id, at: at.at, status: job.status, coverage: job.coverage,
            found: at.found, missing: at.missing };
          // 不覆盖上面已经算好的 auto（done/partial/needs_review）；这里只记录一次采集尝试。
          emit("need.item.attempt", "data-worker", { case: job.case, needId: job.needId,
            index: job.index, indicator: item.indicator, attempt: at });
        }
      }
      emit(b.status === "failed" ? "data.job.failed" : (b.status === "queued" ? "data.job.retry" : "data.job.updated"), b.by || job.owner || "data-worker",
        { case: job.case, jobId: job.id, metric: job.metric, status: job.status, coverage: job.coverage,
          sourceId: job.sourceId, sourceChain: job.sourceChain || [], sourceAttempts: job.sourceAttempts || [] });
      return json(res, 200, { job });
    }
    if (p === "/api/archive" && req.method === "GET") {
      const p2 = path.join(ROOT, "runtime/archive/index.json");
      if (!fs.existsSync(p2)) return json(res, 404, { error: "archive index not built", hint: "node scripts/archive_index.js" });
      try { return json(res, 200, JSON.parse(fs.readFileSync(p2, "utf8"))); }
      catch (e) { return json(res, 500, { error: String(e) }); }
    }
    if (p === "/api/archive/rebuild" && req.method === "POST") {
      const ex = await runNode([path.join(ROOT, "scripts/archive_index.js")]);
      let j = null; try { j = JSON.parse(String(ex.out || "").trim()); } catch (e) {}
      return json(res, ex.status === 0 ? 200 : 500, j || { ok: false, error: String(ex.err || "").slice(0, 300) });
    }
    if (p === "/api/coverage" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const agent = u.searchParams.get("agent") || "";
      const ex = await runNode([path.join(ROOT, "scripts/check-coverage.js"), "--case", caseId, "--agent", agent]);
      let j = null; try { j = JSON.parse(String(ex.out || "").trim()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { ok: false, error: String(ex.err || "").slice(0, 300) });
    }
    if (p === "/api/quality" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const ev = (() => { try { return fs.readFileSync(vaultPath(caseId, "evidence/sources.jsonl"), "utf8").trim().split(String.fromCharCode(10)).filter(Boolean).length; } catch (e) { return 0; } })();
      const items = (works.get(caseId) || []).filter(x => x.kind !== "child");
      const reports = (() => { try { return fs.readdirSync(path.join(VAULT, caseId, "reports")).filter(f => /\.docx$/.test(f)); } catch (e) { return []; } })();
      return json(res, 200, { case: caseId, evidence: ev,
        work: { total: items.length, done: items.filter(x => x.state === "done").length,
          failed: items.filter(x => x.state === "failed").length,
          partial: items.filter(x => x.partial).length },
        needs: (needs.get(caseId) || []).filter(n => n.status === "pending" || n.status === "partial").length,
        reports, tokens: caseTokens.get(caseId) || 0 });
    }
    if (p === "/api/industry/draft" && req.method === "GET") {
      const id = String(u.searchParams.get("id") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
      if (!id) return json(res, 400, { error: "id required" });
      const p2 = path.join(ROOT, "config/checklists/learned", id + ".json");
      try { return json(res, 200, { ok: true, draft: JSON.parse(fs.readFileSync(p2, "utf8")) }); }
      catch (e) { return json(res, 404, { error: "draft not found" }); }
    }
    if (p === "/api/industry/update" && req.method === "POST") {
      const b = await readBody(req);
      const id = String(b.id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
      if (!id) return json(res, 400, { error: "id required" });
      const p2 = path.join(ROOT, "config/checklists/learned", id + ".json");
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(p2, "utf8")); } catch (e) { return json(res, 404, { error: "draft not found" }); }
      if (cur.status === "active") return json(res, 409, { error: "active pack cannot be edited; create a new draft" });
      const patch = b.patch && typeof b.patch === "object" ? b.patch : {};
      const merged = Object.assign({}, cur, patch, { id: cur.id, status: "draft", updatedAt: new Date().toISOString() });
      if (!Array.isArray(merged.required) || merged.required.length > 8) return json(res, 400, { error: "required max 8" });
      if (!Array.isArray(merged.optional) || merged.optional.length > 6) return json(res, 400, { error: "optional max 6" });
      if (!Array.isArray(merged.reportSections) || merged.reportSections.length > 5) return json(res, 400, { error: "reportSections max 5" });
      const ids = new Set();
      for (const m of merged.required.concat(merged.optional)) {
        if (!m || !m.id || !m.name) return json(res, 400, { error: "module id/name required" });
        if (ids.has(m.id)) return json(res, 400, { error: "duplicate module: " + m.id });
        ids.add(m.id);
      }
      fs.writeFileSync(p2, JSON.stringify(merged, null, 2));
      return json(res, 200, { ok: true, draft: merged });
    }
    if (p === "/api/industry/learned" && req.method === "GET") {
      const ex = await runNode([path.join(ROOT, "scripts/learn-industry.js"), "--list"]);
      let j = null; try { j = JSON.parse(String(ex.out || "").trim()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { ok: false, error: String(ex.err || "").slice(0, 300) });
    }
    if (p === "/api/industry/draft" && req.method === "POST") {
      const b = await readBody(req);
      const industry = String(b.industry || "").slice(0, 80);
      if (!industry) return json(res, 400, { error: "industry required" });
      const ex = await runNode([path.join(ROOT, "scripts/learn-industry.js"), "--draft", "--industry", industry,
        "--case", b.case || "", "--text", String(b.text || "").slice(0, 800)]);
      let j = null; try { j = JSON.parse(String(ex.out || "").trim()); } catch (e) {}
      if (j && j.ok) emit("industry.draft", b.by || "you", { case: b.case || "", industry, id: j.draft.id });
      return json(res, j && j.ok ? 200 : 500, j || { ok: false, error: String(ex.err || "").slice(0, 300) });
    }
    if (p === "/api/industry/approve" && req.method === "POST") {
      const b = await readBody(req);
      const id = String(b.id || "").replace(/[^a-zA-Z0-9_.-]/g, "");
      if (!id) return json(res, 400, { error: "id required" });
      const ex = await runNode([path.join(ROOT, "scripts/learn-industry.js"), "--approve", "--id", id]);
      let j = null; try { j = JSON.parse(String(ex.out || "").trim()); } catch (e) {}
      if (j && j.ok) emit("industry.approved", b.by || "you", { case: b.case || "", id });
      return json(res, j && j.ok ? 200 : 500, j || { ok: false, error: String(ex.err || "").slice(0, 300) });
    }
    function enqueueAsyncJob(caseId, type, payload, by) {
      const id = "J" + Date.now().toString(36) + (++asyncJobSeq);
      const job = { id, case: caseId, type: String(type), agent: String((payload && payload.agent) || ""), payload: payload || {}, status: "queued",
        attempts: 0, output: "", result: null, error: "", owner: "",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      writeAsyncJob(job);
      emit("job.queued", by || "system", { case: caseId, jobId: id, jobType: type });
      try {
        const dir = path.join(ROOT, "runtime/job-runs"); fs.mkdirSync(dir, { recursive: true });
        const fd = fs.openSync(path.join(dir, id + ".log"), "a");
        const cp = spawn(process.execPath, [path.join(ROOT, "scripts/job-worker.js"), "--case", caseId, "--once"],
          { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
            env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref(); try { fs.closeSync(fd); } catch (e) {}
      } catch (e) {}
      return job;
    }
    if (p === "/api/jobs" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "";
      const type = u.searchParams.get("type") || "";
      const status = u.searchParams.get("status") || "";
      return json(res, 200, { jobs: listAsyncJobs(caseId, type, status) });
    }
    if (p === "/api/jobs" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      if (!b.type) return json(res, 400, { error: "type required" });
      return json(res, 200, { job: enqueueAsyncJob(caseId, b.type, b.payload || {}, b.by) });
    }
    if (p === "/api/job/retry" && req.method === "POST") {
      const b = await readBody(req);
      const job = readAsyncJob(String(b.id || ""));
      if (!job) return json(res, 404, { error: "job not found" });
      if (job.status === "running" || job.status === "queued") return json(res, 409, { error: "job still active", status: job.status });
      const fresh = enqueueAsyncJob(job.case, job.type, job.payload || {}, b.by || "you");
      return json(res, 200, { ok: true, job: fresh });
    }
    if (p === "/api/job/claim" && req.method === "POST") {
      const b = await readBody(req);
      const job = readAsyncJob(String(b.id || ""));
      if (!job) return json(res, 404, { error: "job not found" });
      if (job.status !== "queued") return json(res, 409, { error: "not queued", status: job.status });
      job.status = "running"; job.owner = b.owner || "job-worker"; job.workerPid = b.pid || 0; job.attempts += 1;
      job.updatedAt = new Date().toISOString(); writeAsyncJob(job);
      emit("job.started", job.owner, { case: job.case, jobId: job.id, jobType: job.type });
      return json(res, 200, { job });
    }
    if (p === "/api/job/update" && req.method === "POST") {
      const b = await readBody(req);
      const job = readAsyncJob(String(b.id || ""));
      if (!job) return json(res, 404, { error: "job not found" });
      if (b.status) job.status = String(b.status).slice(0, 20);
      if (b.output) job.output = String(b.output).slice(0, 1000);
      if (b.result !== undefined) job.result = b.result;
      if (b.error) job.error = String(b.error).slice(0, 1000);
      job.updatedAt = new Date().toISOString(); writeAsyncJob(job);
      emit(job.status === "failed" ? "job.failed" : "job.finished", b.by || job.owner || "job-worker",
        { case: job.case, jobId: job.id, jobType: job.type, status: job.status });
      return json(res, 200, { job });
    }
    if (p === "/api/cross-review/semantic" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const job = enqueueAsyncJob(caseId, "semantic_review", {}, b.by || "you");
      return json(res, 200, { ok: true, job });
    }
    if (p === "/api/data/registry/sync" && req.method === "POST") {
      const r = await runNode([path.join(ROOT, "scripts/sync-data-registry.js")], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, j || { ok: false });
    }
    if (p === "/api/data/sources" && req.method === "GET") {
      const reg = loadDataRegistry();
      return json(res, 200, { sources: reg.sources });
    }
    if (p === "/api/alerts" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const now = Date.now();
      const alerts = [];
      const add = (level, kind, id, message, detail) => alerts.push({ level, kind, id, message,
        detail: String(detail || "").slice(0, 300), at: new Date().toISOString() });
      (works.get(caseId) || []).forEach(w => {
        if (w.state === "running") {
          const hb = Date.parse(w.heartbeatAt || w.startedAt || w.createdAt) || now;
          const st = Date.parse(w.startedAt || w.createdAt) || now;
          const op = parseInt(String(w.owner || "").replace(/^dag-/, ""), 10);
          if (op > 0 && !pidAlive(op)) add("error", "work_owner_dead", w.id,
            w.id + " " + (w.nodeId || "") + " 的 run-dag 进程已退出", "owner=" + w.owner);
          else if (now - hb > 5 * 60 * 1000) add("error", "work_heartbeat", w.id,
            w.id + " " + (w.nodeId || "") + " 超过 5 分钟无心跳", w.error || "");
          else if (now - st > 45 * 60 * 1000) add("warn", "work_long", w.id,
            w.id + " " + (w.nodeId || "") + " 已运行超过 45 分钟", w.name || "");
        } else if (w.state === "queued") {
          const created = Date.parse(w.createdAt) || now;
          const all = works.get(caseId) || [];
          const deps = Array.isArray(w.depends) ? w.depends : [];
          const blockedByDep = deps.some(d => all.some(x => x.nodeId === d && x.state !== "done"));
          const planRunning = all.some(x => x.planId === w.planId && (x.state === "running" || x.state === "cancelling"));
          if (!blockedByDep && !planRunning && now - created > 15 * 60 * 1000 &&
            !autoRuns.has(caseId + "|" + w.planId))
            add("warn", "work_queued", w.id, w.id + " " + (w.nodeId || "") + " 排队超过 15 分钟", w.name || "");
        }
      });
      (plans.get(caseId) || []).forEach(p => {
        if (p.status === "approved" && !autoRuns.has(caseId + "|" + p.id)) {
          const list = (works.get(caseId) || []).filter(w => w.planId === p.id);
          if (list.some(w => w.state === "queued")) add("warn", "plan_not_running", p.id,
            p.id + " 已批准但 run-dag 未运行", p.agent || "");
        }
      });
      try {
        const dir = path.join(ROOT, "runtime/agent-loops");
        fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
          const st = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (!st || st.status !== "running" || (st.case && st.case !== caseId)) return;
          const age = now - (Date.parse(st.updatedAt) || fs.statSync(path.join(dir, f)).mtimeMs);
          if (age <= 10 * 60 * 1000) return;
          const w = (works.get(caseId) || []).find(x => x.id === st.workId);
          const op = w ? parseInt(String(w.owner || "").replace(/^dag-/, ""), 10) : 0;
          const ownerAlive = op > 0 && pidAlive(op);
          if (st.pid && !pidAlive(st.pid))
            add("error", "loop_stuck", st.id || f.replace(/\.json$/, ""),
              "Agent Loop " + (st.agent || "") + " 进程已退出", st.error || "");
          else if (!st.pid && (!w || w.state !== "running" || !ownerAlive))
            add("error", "loop_stuck", st.id || f.replace(/\.json$/, ""),
              "Agent Loop " + (st.agent || "") + " 超过 10 分钟无进展", st.error || "");
        });
      } catch (e) {}
      const order = { error: 0, warn: 1, info: 2 };
      alerts.sort((a, b) => (order[a.level] || 9) - (order[b.level] || 9));
      return json(res, 200, { case: caseId, alerts, count: alerts.length,
        errors: alerts.filter(a => a.level === "error").length });
    }
    if (p === "/api/data/metrics" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "";
      const jobs = caseId ? listDataJobs(caseId) : [];
      const byStatus = {};
      jobs.forEach(j => { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
      let dead = 0;
      try { dead = fs.readFileSync(path.join(ROOT, "runtime/data/dead-letter.jsonl"), "utf8").split(String.fromCharCode(10)).filter(Boolean).length; } catch (e) {}
      const usage = sourceUsage.summary(loadDataRegistry().sources || []);
      return json(res, 200, { case: caseId, jobs: { total: jobs.length, byStatus }, deadLetter: dead,
        usage: { sources: usage.length, callsToday: usage.reduce((n, x) => n + (x.callsToday || 0), 0),
          costToday: usage.reduce((n, x) => n + (x.usedToday || 0), 0) },
        gateway: { rateLimited: sourceRate.size, circuits: Array.from(sourceCircuit.entries()).filter(([k, v]) => v.openUntil > Date.now()).length } });
    }
    if (p === "/api/data/dead-letter" && req.method === "GET") {
      const rows = [];
      try {
        const lines = fs.readFileSync(path.join(ROOT, "runtime/data/dead-letter.jsonl"), "utf8").split(String.fromCharCode(10));
        for (const line of lines) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch (e) {} }
      } catch (e) {}
      return json(res, 200, { rows: rows.slice(-100).reverse() });
    }
    if (p === "/api/data/dead-letter/replay" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const job = listDataJobs(caseId).find(j => j.id === b.id);
      if (!job) return json(res, 404, { error: "job not found" });
      job.status = "queued"; job.attempts = 0; job.error = ""; job.deadLettered = false;
      job.updatedAt = new Date().toISOString(); writeDataJob(job);
      emit("data.dead_letter.replay", b.by || "you", { case: caseId, jobId: job.id });
      spawnDataWorker(caseId);
      return json(res, 200, { ok: true, job });
    }
    if (p === "/api/data/source-usage" && req.method === "GET") {
      const reg = loadDataRegistry();
      return json(res, 200, { rows: sourceUsage.summary(reg.sources), file: "runtime/data/source-usage.jsonl" });
    }
    if (p === "/api/data/source-usage/record" && req.method === "POST") {
      const b = await readBody(req);
      const e = sourceUsage.record({ sourceId: String(b.sourceId || "").slice(0, 80),
        cost: Math.max(0, Number(b.cost) || 0), case: b.case || "", jobId: b.jobId || "",
        status: b.status || "ok", note: String(b.note || "").slice(0, 200) });
      emit("source.usage", b.by || "data-worker", { case: b.case || "", sourceId: e.sourceId,
        cost: e.cost, jobId: e.jobId, status: e.status });
      return json(res, 200, { ok: true, usage: e });
    }
    if (p === "/api/data/source-probe" && req.method === "POST") {
      const b = await readBody(req);
      const sourceId = String(b.sourceId || "").slice(0, 80);
      if (!sourceId) return json(res, 400, { error: "sourceId required" });
      let j = null;
      try {
        const gr = await dataGateway.request({ sourceId, metricId: String(b.metricId || ""),
          query: { range: "" }, idempotencyKey: "probe:" + sourceId + ":" + Date.now(), forceRefresh: true });
        j = { ok: !!gr.ok, sourceId, metricId: b.metricId || "", checkedAt: new Date().toISOString(),
          count: (gr.records || []).length, fields: gr.records && gr.records[0] ? Object.keys(gr.records[0]) : [],
          sample: (gr.records || []).slice(0, 5), error: gr.error || "", snapshot: gr.snapshot || null };
      } catch (e) { j = { ok: false, error: String(e && e.message || e) }; }
      if (!j) return json(res, 500, { error: "probe failed" });
      const cacheFile = path.join(ROOT, "runtime/data/source-probe.json");
      let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (e) {}
      cache[sourceId] = Object.assign({}, j, { at: new Date().toISOString() });
      try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); } catch (e) {}
      emit("source.probe", b.by || "you", { sourceId, metricId: b.metricId || "", ok: !!j.ok, count: j.count || 0 });
      return json(res, 200, { ok: !!j.ok, probe: j });
    }
    if (p === "/api/data/source-matrix" && req.method === "GET") {
      const reg = loadDataRegistry();
      const health = sourceHealth.healthAll(reg.sources);
      const hmap = {};
      (health.sources || []).forEach(h => { hmap[h.id] = h; });
      let probeCache = {}; try { probeCache = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/data/source-probe.json"), "utf8")); } catch (e) {}
      const rows = reg.sources.map(s => {
        const h = hmap[s.id] || {};
        const cov = s.coverage || {};
        const derived = reg.metrics.filter(m => (m.sources || []).some(x => x === s.id || x === s.configSource)).map(m => m.id);
        const metrics = (Array.isArray(cov.metrics) && cov.metrics.length) ? cov.metrics : derived;
        return { id: s.id, name: s.name || s.id, tier: h.tier || sourceHealth.tierOf(s),
          tierLabel: h.tierLabel || sourceHealth.tierLabel(h.tier || sourceHealth.tierOf(s)),
          available: h.available !== false, reason: h.reason || "", status: s.status || "active",
          structured: s.structured !== false, auth: s.auth || "none",
          metrics, fields: Array.isArray(cov.fields) ? cov.fields : [],
          frequency: Array.isArray(cov.frequency) ? cov.frequency : [], history: cov.history || "",
          unit: cov.unit || s.unit || "", sampleProbe: probeCache[s.id] || s.sampleProbe || null,
          license: s.license || null,
          cost: (s.access && s.access.cost) || { perCall: Number((s.access || {}).costPerCall || 0) || 0 },
          lastOkAt: h.lastOkAt || "", checkedAt: h.checkedAt || "" };
      });
      return json(res, 200, { rows, metrics: reg.metrics.map(m => ({ id: m.id, name: m.name, frequency: m.frequency, unit: m.unit })) });
    }
    if (p === "/api/source/promote" && req.method === "POST") {
      const b = await readBody(req);
      const id = String(b.id || "").trim().toLowerCase();
      const name = String(b.name || "").trim().slice(0, 120);
      const url = String(b.url || "").trim();
      const kind = ["json", "html", "pdf"].indexOf(b.kind) >= 0 ? b.kind : "json";
      if (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(id)) return json(res, 400, { error: "source id 只允许小写字母/数字/._-，2-61 字符" });
      if (!name) return json(res, 400, { error: "name required" });
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "url 必须是 http(s)" });
      const srcFile = path.join(ROOT, "config/sources", id + ".json");
      if (fs.existsSync(srcFile)) return json(res, 409, { error: "source 已存在：" + id });
      const regFile = path.join(ROOT, "config/data/sources.json");
      let reg = { sources: [] };
      try { reg = JSON.parse(fs.readFileSync(regFile, "utf8")); } catch (e) {}
      reg.sources = reg.sources || [];
      if (reg.sources.some(s => s.id === id)) return json(res, 409, { error: "registry 已存在：" + id });
      const structured = kind === "json" && b.structured !== false;
      const status = b.status === "draft" ? "draft" : "active";
      const source = {
        id, name, category: String(b.category || "custom").slice(0, 40), kind,
        url, force: true, tier: String(b.tier || "official").slice(0, 40),
        evidenceField: name, notes: "由 DataTask 沉淀：" + String(b.note || "").slice(0, 300),
        periodField: String(b.periodField || "").slice(0, 80),
        valueField: String(b.valueField || "").slice(0, 80),
        unit: String(b.unit || "").slice(0, 40),
        status, structured, license: b.license && typeof b.license === "object" ? b.license : { reportUse: true, redistribute: false },
        coverage: { metrics: b.metricId ? [String(b.metricId)] : [], fields: Array.isArray(b.fields) ? b.fields.slice(0, 20) : [],
          frequency: b.frequency ? [String(b.frequency)] : [], history: String(b.history || "").slice(0, 80), unit: String(b.unit || "").slice(0, 40) },
        sampleProbe: b.sampleProbe && typeof b.sampleProbe === "object" ? b.sampleProbe : null,
        promotedFrom: { case: b.case || "", taskId: b.taskId || "", at: new Date().toISOString() }
      };
      fs.mkdirSync(path.dirname(srcFile), { recursive: true });
      fs.writeFileSync(srcFile, JSON.stringify(source, null, 2) + String.fromCharCode(10));
      const domain = String(b.metricId || "").split(".")[0] || "custom";
      reg.sources.push({
        id, name, configSource: id, capabilities: Array.isArray(b.capabilities) ? b.capabilities.slice(0, 10) : [domain],
        formats: [kind], auth: "none", priority: 5, status, structured, license: source.license,
        connector: structured ? "promoted" : "", periodField: source.periodField, valueField: source.valueField,
        unit: source.unit, coverage: source.coverage, sampleProbe: source.sampleProbe,
        access: { tier: String(b.tier || "free").slice(0, 20) }, promotedFrom: source.promotedFrom
      });
      fs.mkdirSync(path.dirname(regFile), { recursive: true });
      fs.writeFileSync(regFile, JSON.stringify(reg, null, 2) + String.fromCharCode(10));
      if (b.metricId && status === "active") {
        const cfg = loadMetricConfig();
        const m = (cfg.metrics || []).find(x => x.id === b.metricId || (x.aliases || []).indexOf(b.metricId) >= 0);
        if (m) {
          m.sources = Array.isArray(m.sources) ? m.sources : [];
          if (m.sources.indexOf(id) < 0) m.sources.push(id);
          saveMetricConfig(cfg);
        }
      }
      emit("source.promoted", b.by || "you", { case: b.case || "", sourceId: id, name, url, kind,
        metricId: b.metricId || "", structured, status, taskId: b.taskId || "" });
      return json(res, 200, { ok: true, source, registry: reg.sources[reg.sources.length - 1] });
    }
    // 数据源体检：免费源默认可用；token/积分源缺凭据时明确说明，而不是让任务反复失败。
    if (p === "/api/data/source-health" && req.method === "GET") {
      const reg = loadDataRegistry();
      return json(res, 200, sourceHealth.healthAll(reg.sources));
    }
    if (p === "/api/data/source-health/refresh" && req.method === "POST") {
      try {
        const cp = spawn(process.execPath, [path.join(ROOT, "scripts/source-doctor.js"), "--refresh"],
          { cwd: ROOT, detached: true, stdio: "ignore", env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref();
      } catch (e) {}
      return json(res, 200, { ok: true, started: true, hint: "后台检测中，约 5-20 秒后刷新" });
    }
    // 数据源凭据：只写 runtime/secrets，不回传明文；保存后立即 probe 一次。
    if (p === "/api/data/credentials" && req.method === "GET") {
      const readStatus = (rel, field) => {
        const abs = path.resolve(ROOT, rel);
        let configured = false, detail = "未配置";
        try {
          const j = JSON.parse(fs.readFileSync(abs, "utf8"));
          configured = !!(j && (j[field] || j.token || j.api_key || j.apiKey || j.key));
          detail = configured ? "已配置（不回显）" : "文件存在但没有 key";
        } catch (e) { if (fs.existsSync(abs)) detail = "文件存在但无法解析"; }
        return { configured, path: rel, detail };
      };
      return json(res, 200, {
        tushare: Object.assign(readStatus("runtime/secrets/tushare.json", "token"), {
          label: "Tushare token", hint: "可选；需积分；免费用户无需配置" }),
        fred: Object.assign(readStatus("runtime/secrets/fred.json", "api_key"), {
          label: "FRED API key", hint: "免费申请：https://fredaccount.stlouisfed.org/apikeys" })
      });
    }
    if (p === "/api/data/credentials" && req.method === "POST") {
      const b = await readBody(req);
      const dir = path.join(ROOT, "runtime/secrets");
      fs.mkdirSync(dir, { recursive: true });
      const reg = loadDataRegistry();
      const probes = {};
      const writeOne = (file, field, value) => {
        const abs = path.join(dir, file);
        if (value === null || value === undefined) return;
        const s = String(value).trim();
        if (!s) { try { fs.unlinkSync(abs); } catch (e) {} return; }
        if (s.length < 8 || s.length > 300) throw new Error(file + " 长度不合法（8-300）");
        fs.writeFileSync(abs, JSON.stringify({ [field]: s }, null, 2) + String.fromCharCode(10), { mode: 0o600 });
        try { fs.chmodSync(abs, 0o600); } catch (e) {}
      };
      try {
        if (b.tushare !== undefined) writeOne("tushare.json", "token", b.tushare);
        if (b.fred !== undefined) writeOne("fred.json", "api_key", b.fred);
      } catch (e) { return json(res, 400, { error: String((e && e.message) || e) }); }
      const probeAndMark = async (provider) => {
        if (provider === "tushare") {
          const src = { id: "tushare-cn-m1", access: { tier: "credit", auth: "token",
            secret: "runtime/secrets/tushare.json", minPoints: 2000,
            probe: { type: "tushare", api: "cn_m", params: { start_m: "202601", end_m: "202601" }, fields: "month,m1_yoy" } } };
          const r = await sourceHealth.probeSource(src);
          probes.tushare = r;
          for (const s of reg.sources.filter(x => /^tushare/.test(x.id))) {
            try { if (r.available) sourceHealth.markAvailable(s.id); else sourceHealth.markUnavailable(s.id, r.reason || "Tushare 不可用"); } catch (e) {}
          }
        }
        if (provider === "fred") {
          const src = { id: "fred-us10y", access: { tier: "free-key", auth: "token",
            secret: "runtime/secrets/fred.json", probe: { type: "fred", series: "DGS10" } } };
          const r = await sourceHealth.probeSource(src);
          probes.fred = r;
          try { if (r.available) sourceHealth.markAvailable("fred-us10y"); else sourceHealth.markUnavailable("fred-us10y", r.reason || "FRED 不可用"); } catch (e) {}
        }
        emit("data.credentials.updated", b.by || "you", { case: b.case || "default", provider,
          configured: (() => { try { return fs.existsSync(path.join(dir, provider === "tushare" ? "tushare.json" : "fred.json")); } catch (e) { return false; } })(),
          available: !!(probes[provider] && probes[provider].available), reason: (probes[provider] && probes[provider].reason) || "" });
      };
      if (b.tushare !== undefined) await probeAndMark("tushare");
      if (b.fred !== undefined) await probeAndMark("fred");
      return json(res, 200, { ok: true, probes });
    }
    // case 总预算：Agent Loop / WorkItem / 面板共用 caseTokens；reserved 是启动前占住的上限。
    if (p === "/api/budget" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const snap = budgetSnapshot(caseId);
      return json(res, 200, Object.assign({}, snap, {
        reservations: Array.from(budgetReservations.values()).filter(x => x.case === caseId) }));
    }
    if (p === "/api/budget/reserve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const r = reserveCaseBudget(caseId, b.amount, { workId: b.workId, loopId: b.loopId, owner: b.owner });
      if (!r.ok) return json(res, 409, { error: "case token 预算不足", code: "budget_exceeded",
        requested: r.requested, available: r.available, budget: r.budget });
      return json(res, 200, { ok: true, reservation: r.reservation, budget: r.budget });
    }
    if (p === "/api/budget/release" && req.method === "POST") {
      const b = await readBody(req);
      const r = releaseCaseBudget(b.reservationId, { actualTokens: b.actualTokens,
        reason: b.reason, owner: b.owner });
      if (!r.ok) return json(res, 404, { error: r.error || "reservation not found" });
      return json(res, 200, { ok: true, reservation: r.reservation, actualTokens: r.actualTokens,
        budget: r.budget });
    }
    // 双层 Agent Loop：Lead / Employee 有界自主循环。
    if (p === "/api/agent/loop" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = String(b.case || "default").slice(0, 80);
      if (BUDGETS.maxTokensPerCase > 0 && (caseTokens.get(caseId) || 0) >= BUDGETS.maxTokensPerCase) {
        emit("budget.exceeded", "system", { case: caseId, tokens: caseTokens.get(caseId) || 0,
          limit: BUDGETS.maxTokensPerCase, scope: "agent.loop" });
        return json(res, 409, { error: "case token 预算已用尽", code: "budget_exceeded",
          tokens: caseTokens.get(caseId) || 0, limit: BUDGETS.maxTokensPerCase });
      }
      const kind = b.kind === "lead" ? "lead" : "employee";
      if (kind === "lead") {
        const cur = leadLeases.get(caseId);
        if (cur && Number(cur.until) > Date.now()) {
          return json(res, 409, { error: "Lead 循环已在运行", code: "lead_lease_held",
            loopId: cur.loopId, until: cur.until, hint: "等待当前 Lead 完成，或停止后重试" });
        }
      }
      const agent = String(b.agent || (kind === "lead" ? "lead" : "industry")).slice(0, 20);
      const task = String(b.task || b.objective || "").slice(0, 4000);
      const workId = String(b.workId || "").slice(0, 40);
      if (kind === "employee" && !task && !workId) return json(res, 400, { error: "employee loop 需要 task 或 workId" });
      const loopId = "AL" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const mode = b.mode === "fake" ? "fake" : "real";
      const runtime = ["fake", "dsh", "openai"].indexOf(b.runtime) >= 0 ? b.runtime : "dsh";
      const maxRounds = Math.max(1, Math.min(8, Number(b.maxRounds) || (kind === "lead" ? 4 : 3)));
      const maxTokens = Math.max(0, Number(b.maxTokens) || (kind === "lead" ? 160000 : 120000));
      const maxWallMs = Math.max(1000, Number(b.maxWallMs) || (kind === "lead" ? 40 * 60 * 1000 : 30 * 60 * 1000));
      const maxSubagents = Math.max(0, Math.min(2, Number(b.maxSubagents) || 0));
      const script = kind === "lead" ? "scripts/lead-loop.js" : "scripts/employee-loop.js";
      const args = [path.join(ROOT, script), "--case", caseId, "--mode", mode, "--runtime", runtime,
        "--max-rounds", String(maxRounds), "--max-tokens", String(maxTokens), "--max-wall-ms", String(maxWallMs),
        "--loop-id", loopId];
      if (kind === "lead") {
        args.push("--objective", task || "完成 case 研究并产出可审阅报告");
        args.push("--lease-id", loopId);
        if (["workflow", "supervised", "autonomous"].indexOf(b.autonomy) >= 0) args.push("--autonomy", b.autonomy);
        // 测试/回放用：fake 模式可注入固定决策，不进入真实模型。
        if (mode === "fake" && b.fakeDecision && typeof b.fakeDecision === "object") {
          args.push("--fake-decision", JSON.stringify(b.fakeDecision));
        }
      }
      else {
        args.push("--agent", agent, "--task", task, "--max-subagents", String(maxSubagents));
        if (workId) args.push("--work-id", workId);
      }
      const dir = path.join(ROOT, "runtime/agent-loops"); fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, loopId + ".log"), "a");
      let childPid = 0;
      // 先占租约再启动，避免子进程快速完成并发 release 时出现“先 release 后 set”的竞态。
      if (kind === "lead") leadLeases.set(caseId, { loopId, pid: 0, until: Date.now() + 120000 });
      try {
        const cp = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref(); childPid = cp.pid || 0;
      } catch (e) { try { fs.closeSync(fd); } catch (e2) {} if (kind === "lead") leadLeases.delete(caseId); return json(res, 500, { error: String((e && e.message) || e) }); }
      try { fs.closeSync(fd); } catch (e) {}
      if (kind === "lead") {
        const cur = leadLeases.get(caseId);
        if (cur && cur.loopId === loopId) { cur.pid = childPid; leadLeases.set(caseId, cur); }
      }
      emit("agent.loop.queued", b.by || "you", { case: caseId, loopId, kind, agent, mode, maxRounds });
      return json(res, 200, { ok: true, loopId, kind, agent, mode, maxRounds });
    }
    if (p === "/api/agent/loop/heartbeat" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = String(b.case || "default").slice(0, 80);
      const loopId = String(b.loopId || "").slice(0, 60);
      const cur = leadLeases.get(caseId);
      if (!cur || cur.loopId !== loopId) return json(res, 409, { error: "lead lease not held", code: "lead_lease_lost" });
      cur.until = Date.now() + 120000;
      leadLeases.set(caseId, cur);
      return json(res, 200, { ok: true, until: cur.until });
    }
    if (p === "/api/agent/loop/release" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = String(b.case || "default").slice(0, 80);
      const loopId = String(b.loopId || "").slice(0, 60);
      const cur = leadLeases.get(caseId);
      if (cur && cur.loopId === loopId) leadLeases.delete(caseId);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/agent/loop/resume" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = String(b.case || "default").slice(0, 80);
      const id = String(b.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!id) return json(res, 400, { error: "id required" });
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/agent-loops", id + ".json"), "utf8")); } catch (e) {}
      if (!j) return json(res, 404, { error: "loop not found" });
      if (j.kind !== "lead") return json(res, 400, { error: "only lead loop can resume" });
      const stateAlive = j.status === "running" && j.pid && pidAlive(j.pid);
      if (stateAlive) return json(res, 409, { error: "loop still running" });
      if (j.status === "done") return json(res, 409, { error: "loop already done" });
      const cur = leadLeases.get(caseId);
      if (cur && Number(cur.until) > Date.now() && cur.pid && pidAlive(cur.pid))
        return json(res, 409, { error: "Lead 循环已在运行", code: "lead_lease_held", loopId: cur.loopId });
      if (cur && cur.pid && !pidAlive(cur.pid)) leadLeases.delete(caseId);
      const loopId = "AL" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rounds = Number(j.rounds) || 0;
      const maxRounds = Math.min(12, Math.max(Number(j.maxRounds) || 4, rounds + 2));
      const maxTokens = Math.max(0, Number(j.budget && j.budget.maxTokens) || 160000);
      const maxWallMs = Math.max(1000, Number(j.budget && j.budget.maxWallMs) || 40 * 60 * 1000);
      const mode = j.mode === "real" ? "real" : "fake";
      const runtime = ["fake", "dsh", "openai"].indexOf(j.runtime) >= 0 ? j.runtime : "dsh";
      const args = [path.join(ROOT, "scripts/lead-loop.js"), "--case", caseId, "--mode", mode, "--runtime", runtime,
        "--max-rounds", String(maxRounds), "--max-tokens", String(maxTokens), "--max-wall-ms", String(maxWallMs),
        "--loop-id", loopId, "--resume-of", id, "--lease-id", loopId,
        "--objective", String(j.objective || "继续完成 case 研究").slice(0, 4000)];
      if (["workflow", "supervised", "autonomous"].indexOf(j.autonomy) >= 0) args.push("--autonomy", j.autonomy);
      const dir = path.join(ROOT, "runtime/agent-loops"); fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, loopId + ".log"), "a");
      leadLeases.set(caseId, { loopId, pid: 0, until: Date.now() + 120000 });
      let childPid = 0;
      try {
        const cp = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref(); childPid = cp.pid || 0;
      } catch (e) {
        try { fs.closeSync(fd); } catch (e2) {}
        leadLeases.delete(caseId);
        return json(res, 500, { error: String((e && e.message) || e) });
      }
      try { fs.closeSync(fd); } catch (e) {}
      const lease = leadLeases.get(caseId); if (lease && lease.loopId === loopId) { lease.pid = childPid; leadLeases.set(caseId, lease); }
      emit("agent.loop.resumed", b.by || "you", { case: caseId, loopId, resumeOf: id, kind: "lead", mode, runtime, maxRounds });
      return json(res, 200, { ok: true, loopId, resumeOf: id, kind: "lead", mode, runtime, maxRounds });
    }
    if (p === "/api/agent/loop/replay" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = String(b.case || "default").slice(0, 80);
      const id = String(b.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!id) return json(res, 400, { error: "id required" });
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/agent-loops", id + ".json"), "utf8")); } catch (e) {}
      if (!j) return json(res, 404, { error: "loop not found" });
      if (j.status === "running") return json(res, 409, { error: "loop still running" });
      const loopCase = j.case || caseId;
      const kind = j.kind === "lead" ? "lead" : "employee";
      const loopId = "AL" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const mode = j.mode === "real" ? "real" : "fake";
      const runtime = ["fake", "dsh", "openai"].indexOf(j.runtime) >= 0 ? j.runtime : "dsh";
      const maxRounds = Math.max(1, Math.min(8, Number(j.maxRounds) || (kind === "lead" ? 4 : 3)));
      const maxTokens = Math.max(0, Number(j.budget && j.budget.maxTokens) || (kind === "lead" ? 160000 : 120000));
      const maxWallMs = Math.max(1000, Number(j.budget && j.budget.maxWallMs) || (kind === "lead" ? 40 * 60 * 1000 : 30 * 60 * 1000));
      const script = kind === "lead" ? "scripts/lead-loop.js" : "scripts/employee-loop.js";
      const args = [path.join(ROOT, script), "--case", loopCase, "--mode", mode, "--runtime", runtime,
        "--max-rounds", String(maxRounds), "--max-tokens", String(maxTokens), "--max-wall-ms", String(maxWallMs),
        "--loop-id", loopId, "--replay-of", id];
      if (kind === "lead") {
        args.push("--objective", String(j.objective || "完成 case 研究并产出可审阅报告").slice(0, 4000));
        if (["workflow", "supervised", "autonomous"].indexOf(j.autonomy) >= 0) args.push("--autonomy", j.autonomy);
      } else args.push("--agent", String(j.agent || "industry").slice(0, 20),
        "--task", String(j.task || "").slice(0, 4000),
        "--max-subagents", String((j.budget && j.budget.maxSubagents) || 0));
      const dir = path.join(ROOT, "runtime/agent-loops"); fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, loopId + ".log"), "a");
      try {
        const cp = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref();
      } catch (e) { try { fs.closeSync(fd); } catch (e2) {} return json(res, 500, { error: String((e && e.message) || e) }); }
      try { fs.closeSync(fd); } catch (e) {}
      emit("agent.loop.replayed", b.by || "you", { case: loopCase, loopId, replayOf: id, kind,
        agent: j.agent || "", mode, runtime, maxRounds });
      return json(res, 200, { ok: true, loopId, replayOf: id, kind, mode, runtime });
    }
    if (p === "/api/agent/loops" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "";
      const dir = path.join(ROOT, "runtime/agent-loops");
      const out = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.json$/.test(f)) continue;
          try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            if (j && (!caseId || j.case === caseId)) out.push(j); } catch (e) {}
        }
      } catch (e) {}
      out.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
      return json(res, 200, { loops: out });
    }
    if (p === "/api/agent/loop" && req.method === "GET") {
      const id = u.searchParams.get("id") || "";
      let j = null; try { j = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/agent-loops", id + ".json"), "utf8")); } catch (e) {}
      if (!j) return json(res, 404, { error: "loop not found" });
      return json(res, 200, { loop: j });
    }
    if (p === "/api/agent/loop/stop" && req.method === "POST") {
      const b = await readBody(req);
      const id = String(b.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (!id) return json(res, 400, { error: "id required" });
      try { fs.writeFileSync(path.join(ROOT, "runtime/agent-loops", id + ".stop"), "1"); } catch (e) {}
      emit("agent.loop.stop_requested", b.by || "you", { case: b.case || "default", loopId: id });
      return json(res, 200, { ok: true, loopId: id });
    }
    // Tool Gateway：统一工具目录 + 调用入口（Agent Loop / MCP / function calling 共用）。
    if (p === "/api/tools" && req.method === "GET") {
      return json(res, 200, { tools: toolGateway.catalog() });
    }
    if (p.indexOf("/api/tools/") === 0 && req.method === "POST") {
      const name = decodeURIComponent(p.slice("/api/tools/".length));
      const b = await readBody(req);
      try {
        let args = b.args;
        if (!args || typeof args !== "object") {
          args = {};
          for (const k of Object.keys(b)) {
            if (["case", "by", "actor", "traceId", "approved", "args"].indexOf(k) < 0) args[k] = b[k];
          }
        }
        if (args.case === undefined && b.case) args.case = b.case;
        const r = await toolGateway.invoke(name, args, { actor: b.by || b.actor || "agent",
          case: b.case || "default", traceId: b.traceId || "", approved: b.approved === true });
        const code = r.ok ? 200 : (r.status === "pending_approval" ? 202 : 400);
        return json(res, code, r);
      } catch (e) {
        return json(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
    }
    // 运行前预检：把当前未补齐的数据缺口映射到来源链，告诉用户“哪些能自动采、哪些会转人工”。
    if (p === "/api/data/preflight" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const reg = loadDataRegistry();
      const items = [];
      for (const n of (needs.get(caseId) || [])) {
        if (n.kind !== "data") continue;
        if (["answered", "waived", "superseded"].indexOf(n.status) >= 0) continue;
        const its = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
        its.forEach((it, index) => {
          if (!it || it.status === "provided" || it.status === "waived") return;
          if ((n.waivedItems || []).some(w => w.index === index)) return;
          const rr = metricResolver.resolve(it, reg.metrics);
          const metric = reg.metrics.find(m => m.id === rr.metricId);
          if (!metric) {
            items.push({ needId: n.id, index, indicator: it.indicator, metricId: "", ready: false,
              chain: [], skipped: [], reason: "指标未匹配：" + ((rr.reasons || []).join("；") || rr.state) });
            return;
          }
          const bc = sourceChain.buildChain(metric, reg.sources);
          items.push({ needId: n.id, index, indicator: it.indicator, metricId: metric.id,
            ready: bc.chain.length > 0, chain: bc.chain, skipped: bc.skipped,
            reason: bc.chain.length ? "" : sourceChain.noSourceReason(bc.skipped, metric) });
        });
      }
      const h = sourceHealth.healthAll(reg.sources);
      return json(res, 200, { ok: true, case: caseId, items, checkedAt: h.checkedAt,
        summary: { total: items.length, ready: items.filter(x => x.ready).length,
          gaps: items.filter(x => !x.ready).length,
          freeAvailable: h.sources.filter(s => s.available && s.tier === "free").length,
          optionalUnavailable: h.sources.filter(s => !s.available && (s.tier === "credit" || s.tier === "free-key")).length } });
    }
    if (p === "/api/data/metrics" && req.method === "GET") {
      const reg = loadDataRegistry();
      const q = u.searchParams.get("q") || "";
      const domain = u.searchParams.get("domain") || "";
      return json(res, 200, { metrics: reg.metrics.filter(m => (!domain || m.domain === domain) && metricMatches(m, q)) });
    }
    if (p === "/api/data/plan" && req.method === "GET") {
      const reg = loadDataRegistry();
      const id = u.searchParams.get("metric") || "";
      const metric = reg.metrics.find(m => m.id === id || (m.aliases || []).indexOf(id) >= 0);
      if (!metric) return json(res, 404, { error: "unknown metric", hint: "先注册 metric 或使用 /api/data/metrics?q=" });
      const candidates = metricSources(metric, reg.sources);
      return json(res, 200, { metric, sources: candidates, coverage: 0,
        status: candidates.length ? "planned" : "no-source" });
    }
    if (p === "/api/data/extract-schema" && req.method === "POST") {
      const b = await readBody(req);
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/extract-schema.js"),
        "--url", String(b.url || ""), "--field", String(b.field || ""), "--source", String(b.source || "")],
        { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 400, j || { error: String(r.stderr || "").slice(0, 300) });
    }
    if (p === "/api/data/precheck" && req.method === "POST") {
      const b = await readBody(req);
      const args = [path.join(ROOT, "scripts/data-precheck.js"),
        "--value", String(b.value || ""), "--unit", String(b.unit || ""), "--asOf", String(b.asOf || ""),
        "--url", String(b.url || ""), "--source", String(b.source || ""), "--expectedUnit", String(b.expectedUnit || ""),
        "--otherValue", String(b.otherValue || ""), "--otherSource", String(b.otherSource || ""),
        "--coverage", String(b.coverage || ""), "--expectedMin", String(b.expectedMin || ""), "--expectedMax", String(b.expectedMax || ""),
        "--history", String(b.history || ""), "--periodsExpected", String(b.periodsExpected || ""), "--periodsActual", String(b.periodsActual || "")];
      const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 30000 });
      let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 400, j || { error: String(r.stderr || "").slice(0, 300) });
    }
    function sourcePrefPath() { return path.join(ROOT, "config/data/preferences.json"); }
    function readSourcePrefs() { try { return JSON.parse(fs.readFileSync(sourcePrefPath(), "utf8")); } catch (e) { return {}; } }
    function sourceTestCachePath(url) { const h = sha256(String(url || "")).slice(0, 16); return path.join(ROOT, "runtime/cache/source-schema", h + ".json"); }
    if (p === "/api/tushare/financials" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const code = String(u.searchParams.get("ts_code") || "");
      const args = [path.join(ROOT, "scripts/tushare-financials.js"), "--case", caseId];
      if (code) args.push("--ts-code", code);
      const r = await runNode(args, process.env, 60000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j && j.ok ? 200 : 500, j || { error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/tushare/industry-valuation" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/industry-valuation.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/tushare/peers" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/tushare-peers.js"), "--case", caseId], process.env, 180000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/tushare/industry-tree" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/tushare-industry-tree.js"), "--case", caseId], process.env, 120000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/tushare/industries" && req.method === "GET") {
      const level = u.searchParams.get("level") || "L1";
      const r = await runNode([path.join(ROOT, "scripts/tushare-industry.js"), "--level", level, "--src", "SW2021"], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, j ? 200 : 500, j || { error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/sector-pack" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/sector-pack.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, j || { ok: false });
    }
    if (p === "/api/data/source/test" && req.method === "POST") {
      const b = await readBody(req);
      const url = String(b.url || "").trim();
      if (!/^https?:\/\//.test(url)) return json(res, 400, { error: "url required" });
      const cp = sourceTestCachePath(url + "|" + String(b.field || ""));
      try { const cj = JSON.parse(fs.readFileSync(cp, "utf8")); if (cj && Date.now() - new Date(cj.fetchedAt).getTime() < 7 * 86400000) return json(res, 200, Object.assign({}, cj.preview, { cached: true, schema: cj.schema || null })); } catch (e) {}
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/url_preview.js"), "--url", url,
        "--field", String(b.field || "").slice(0, 200)], { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      let pj = null; try { pj = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      let schema = null;
      if (pj && pj.ok !== false) {
        const fields = Array.from(new Set(((pj.candidates || []).map(c0 => c0.field).filter(Boolean))));
        schema = { version: 1, url, kind: pj.kind || "html", field: b.field || "", fields,
          tableCount: Array.isArray(pj.tables) ? pj.tables.length : 0, fetchedAt: new Date().toISOString() };
        try { fs.mkdirSync(path.dirname(cp), { recursive: true }); fs.writeFileSync(cp, JSON.stringify({ url, field: b.field || "", fetchedAt: new Date().toISOString(), schema, preview: pj }, null, 2)); } catch (e) {}
      }
      return json(res, pj && pj.ok !== false ? 200 : 400, Object.assign({}, pj || { error: String(r.stderr || "").slice(0, 300) }, { schema }));
    }
    if (p === "/api/data/source/propose" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const r = await runNode([path.join(ROOT, "scripts/source-propose.js"), "--case", caseId,
        "--need", String(b.needId || ""), "--text", String(b.text || "").slice(0, 1500)], process.env, 130000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, j || { ok: false, sources: [] });
    }
    if (p === "/api/data/source/register" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const src = b.source || {};
      const id = String(src.id || ("custom-" + Date.now().toString(36))).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 50);
      const name = String(src.name || id).slice(0, 80);
      const url = String(src.url || "").trim();
      if (!/^https?:\/\//.test(url)) return json(res, 400, { error: "valid url required" });
      const kind = ["html", "pdf", "json"].indexOf(src.kind) >= 0 ? src.kind : "html";
      let schema = src.schema || null;
      try { const cp = sourceTestCachePath(url + "|" + String(src.field || "")); const cj = JSON.parse(fs.readFileSync(cp, "utf8")); if (cj && cj.schema) schema = cj.schema; } catch (e) {}
      const unit = String(src.unit || "").slice(0, 20);
      const frequency = String(src.frequency || "").slice(0, 20);
      const cfgSrc = { id, name, category: "custom", kind, url, force: true,
        evidenceField: String(src.field || src.fields && src.fields[0] || "").slice(0, 100),
        tier: "custom", status: "draft", schema,
        access: { tier: "free", auth: "none", homepage: url } };
      fs.writeFileSync(path.join(ROOT, "config/sources", id + ".json"), JSON.stringify(cfgSrc, null, 2) + String.fromCharCode(10));
      const sp = path.join(ROOT, "config/data/sources.json");
      let sj = { version: 1, sources: [] }; try { sj = JSON.parse(fs.readFileSync(sp, "utf8")); } catch (e) {}
      sj.sources = (sj.sources || []).filter(x => x.id !== id);
      sj.sources.push({ id, name, configSource: id, capabilities: ["custom"], formats: [kind], auth: "none", priority: 3,
        status: "draft", structured: kind === "json", access: cfgSrc.access });
      fs.writeFileSync(sp, JSON.stringify(sj, null, 2) + String.fromCharCode(10));
      const mp = path.join(ROOT, "config/data/metrics.json");
      let mj = { version: 1, metrics: [] }; try { mj = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (e) {}
      const mid = "custom." + id.replace(/[^a-z0-9_]/g, "_");
      const mname = String(src.metricName || (src.fields && src.fields[0]) || name).slice(0, 100);
      mj.metrics = (mj.metrics || []).filter(x => x.id !== mid);
      mj.metrics.push({ id: mid, name: mname, aliases: [String(b.indicator || "").slice(0, 80)].filter(Boolean),
        domain: "custom", frequency, unit, sources: [id], status: "draft" });
      fs.writeFileSync(mp, JSON.stringify(mj, null, 2) + String.fromCharCode(10));
      // 登记后立即做一次可达性/解析测试；失败不删除配置，方便用户改 URL 后重试。
      let probe = null;
      if (b.test !== false) {
        try {
          const pr = await runNode([path.join(ROOT, "scripts/collect.js"), "source", id], process.env, 60000);
          let pj = null;
          try { pj = JSON.parse(String(pr.out || "").trim()); } catch (e) {
            try { pj = JSON.parse(String(pr.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e2) {}
          }
          probe = { ok: !!(pj && pj.ok), error: String((pj && pj.error) || pr.err || "").slice(0, 300),
            chars: (pj && pj.chars) || 0, preview: String((pj && pj.preview) || "").slice(0, 200) };
        } catch (e) { probe = { ok: false, error: String((e && e.message) || e).slice(0, 300) }; }
      }
      if (b.activate === true && (!probe || probe.ok)) {
        cfgSrc.status = "active"; fs.writeFileSync(path.join(ROOT, "config/sources", id + ".json"), JSON.stringify(cfgSrc, null, 2) + String.fromCharCode(10));
        (sj.sources || []).forEach(x => { if (x.id === id) x.status = "active"; });
        fs.writeFileSync(sp, JSON.stringify(sj, null, 2) + String.fromCharCode(10));
        (mj.metrics || []).forEach(x => { if ((x.sources || []).indexOf(id) >= 0) x.status = "active"; });
        fs.writeFileSync(mp, JSON.stringify(mj, null, 2) + String.fromCharCode(10));
      }
      emit("data.source.registered", b.by || "you", { case: caseId, sourceId: id, metricId: mid, url,
        active: cfgSrc.status === "active", probeOk: !!(probe && probe.ok) });
      return json(res, 200, { ok: true, source: cfgSrc, metricId: mid, probe });
    }
    if (p === "/api/data/source/schema" && req.method === "GET") {
      const url = String(u.searchParams.get("url") || ""); const field = String(u.searchParams.get("field") || "");
      const sid = String(u.searchParams.get("source") || "");
      try { for (const f of fs.readdirSync(path.join(ROOT, "config/sources"))) { if (!/\.json$/.test(f)) continue; const j = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sources", f), "utf8")); if ((sid && j.id === sid) || (url && j.url === url)) return json(res, 200, { schema: j.schema || null, cached: true, source: "registered" }); } } catch (e) {}
      try { const cj = JSON.parse(fs.readFileSync(sourceTestCachePath(url + "|" + field), "utf8")); return json(res, 200, { schema: cj.schema || null, cached: true, source: "cache" }); } catch (e) {}
      return json(res, 200, { schema: null, cached: false, source: "none" });
    }
    if (p === "/api/data/source/activate" && req.method === "POST") {
      const b = await readBody(req); const id = String(b.id || "").replace(/[^a-z0-9_.-]/g, "").slice(0, 50);
      if (!id) return json(res, 400, { error: "id required" });
      const sp = path.join(ROOT, "config/sources", id + ".json");
      let src = null; try { src = JSON.parse(fs.readFileSync(sp, "utf8")); } catch (e) {}
      if (!src) return json(res, 404, { error: "source not found" });
      src.status = "active"; fs.writeFileSync(sp, JSON.stringify(src, null, 2) + String.fromCharCode(10));
      const dp = path.join(ROOT, "config/data/sources.json"); let dj = { version: 1, sources: [] }; try { dj = JSON.parse(fs.readFileSync(dp, "utf8")); } catch (e) {}
      (dj.sources || []).forEach(x => { if (x.id === id) x.status = "active"; }); fs.writeFileSync(dp, JSON.stringify(dj, null, 2) + String.fromCharCode(10));
      const mp = path.join(ROOT, "config/data/metrics.json"); let mj = { version: 1, metrics: [] }; try { mj = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (e) {}
      (mj.metrics || []).forEach(x => { if ((x.sources || []).indexOf(id) >= 0) x.status = "active"; }); fs.writeFileSync(mp, JSON.stringify(mj, null, 2) + String.fromCharCode(10));
      const prefs = readSourcePrefs(); const cid = b.case || "default"; prefs[cid] = prefs[cid] || {};
      prefs[cid][id] = { activatedAt: new Date().toISOString(), uses: (prefs[cid][id] && prefs[cid][id].uses || 0) + 1 };
      try { fs.mkdirSync(path.dirname(sourcePrefPath()), { recursive: true }); fs.writeFileSync(sourcePrefPath(), JSON.stringify(prefs, null, 2)); } catch (e) {}
      emit("data.source.activated", b.by || "you", { case: cid, sourceId: id });
      return json(res, 200, { ok: true, source: src });
    }
    if (p === "/api/data/register" && req.method === "POST") {
      const b = await readBody(req);
      const m = b.metric || b;
      if (!m || !m.id || !m.name) return json(res, 400, { error: "id/name required" });
      const p2 = path.join(ROOT, "config/data/metrics.json");
      let j = { version: 1, metrics: [] };
      try { j = JSON.parse(fs.readFileSync(p2, "utf8")); } catch (e) {}
      j.version = j.version || 1;
      j.metrics = (j.metrics || []).filter(x => x.id !== m.id);
      j.metrics.push({ id: String(m.id), name: String(m.name), domain: m.domain || "",
        frequency: m.frequency || "", unit: m.unit || "", definition: m.definition || "",
        aliases: Array.isArray(m.aliases) ? m.aliases.slice(0, 10) : [],
        sources: Array.isArray(m.sources) ? m.sources.slice(0, 10) : [],
        required: !!m.required, status: m.status || "draft" });
      fs.writeFileSync(p2, JSON.stringify(j, null, 2) + String.fromCharCode(10));
      return json(res, 200, { ok: true, metric: m.id });
    }
    if (p === "/api/data/coverage" && req.method === "GET") {
      const id = u.searchParams.get("metric") || "";
      const range = u.searchParams.get("range") || "";
      const dir = path.join(ROOT, "runtime/data/indicators", id.replace(/[^a-zA-Z0-9_.-]/g, "_"));
      let periods = [];
      try { periods = fs.readdirSync(dir).filter(f => /\.json$/.test(f)).map(f => f.replace(/\.json$/, "")); } catch (e) {}
      let expected = 0;
      const mm = String(range).match(/^(\d{4})-(\d{2})\.\.(\d{4})-(\d{2})$/);
      if (mm) {
        const a = parseInt(mm[1]) * 12 + parseInt(mm[2]), b = parseInt(mm[3]) * 12 + parseInt(mm[4]);
        expected = Math.max(0, b - a + 1);
      }
      const coverage = expected ? Math.round(Math.min(periods.length, expected) / expected * 100) : (periods.length ? 100 : 0);
      return json(res, 200, { metric: id, range, periods, expected, coverage,
        status: coverage >= 95 ? "sufficient" : (coverage >= 70 ? "partial" : "insufficient") });
    }
    // 面板/脚本读取的运行配置（角色名单、品牌、默认模型策略等）
    if (p === "/api/config" && req.method === "GET") {
      return json(res, 200, { brand: CONFIG.brand || "AlphaDesk",
        language: CONFIG.language || "zh",
        agents: CONFIG.agents,
        caseDefaults: CONFIG.case,
        modelsDefault: CONFIG.models.default || null,
        skillsDir: CONFIG.skills.dir || "skills" });
    }
    // 缺数据怎么取：面板「待你确认」里的「怎么取？」按钮读它
    if (p === "/api/data-guide" && req.method === "GET") {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data-sources.json"), "utf8"));
        return json(res, 200, g);
      } catch (e) {
        return json(res, 200, { guides: [] });
      }
    }
    if (p === "/api/health") {
      return json(res, 200, { ok: true, seq: S.seq, uptimeMs: Date.now() - S.startedAt,
        runtime: RUNTIME, locks: S.locks.size, stats: S.stats });
    }
    /* --- 采集中心：来源模板 / 缓存 / 配额配置 --- */
    if (p === "/api/collect/status") {
      const dir = path.join(ROOT, "config/sources");
      const sources = [];
      try {
        fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
            sources.push({ id: j.id, name: j.name, tier: j.tier || "", kind: j.kind, category: j.category });
          } catch (e) {}
        });
      } catch (e) {}
      let cacheFiles = 0, cacheBytes = 0;
      try {
        const cdir = path.join(ROOT, ((CONFIG.collect || {}).cacheDir) || "runtime/cache/collect");
        fs.readdirSync(cdir).forEach(f => {
          const st = fs.statSync(path.join(cdir, f)); if (st.isFile()) { cacheFiles += 1; cacheBytes += st.size; }
        });
      } catch (e) {}
      return json(res, 200, { sources, cache: { files: cacheFiles, bytes: cacheBytes },
        collect: CONFIG.collect || {}, quotas: (CONFIG.collect || {}).quotas || {} });
    }
    if (p === "/api/watchdog" && req.method === "GET") {
      return json(res, 200, { enabled: WATCHDOG.enabled, config: WATCHDOG,
        runningSteps: Array.from(runningSteps.values()),
        runningRuns: Array.from(runningRuns.values()),
        alerts: Array.from(watchdogAlerts.keys()).map(k => {
          const parts = k.split("|");
          return { case: parts[0], agent: parts[1], stage: parts[2] || "", at: watchdogAlerts.get(k) };
        }) });
    }
    /* --- 环境自检：DSH / Node / 配置 / 凭据 / 目录可写 / Python（抽取用） --- */
    if (p === "/api/doctor") {
      const spawnSync = require("child_process").spawnSync;
      const checks = [];
      const add = (id, label, ok, detail, hint, required) =>
        checks.push({ id, label, ok: !!ok, detail: detail || "", hint: hint || "", required: !!required });
      const major = parseInt(String(process.version).replace(/^v/, "").split(".")[0], 10);
      add("node", "Node.js", major >= 18, process.version, "安装 Node.js 18+（推荐 22 LTS）", true);
      let dshVersion = "", dshOk = !!DSH_BIN;
      if (DSH_BIN) {
        try {
          const r = spawnSync(DSH_BIN, ["--version"], { encoding: "utf8", timeout: 8000,
            shell: process.platform === "win32" });
          dshVersion = String(r.stdout || r.stderr || "").trim().split("\n")[0];
        } catch (e) {}
      }
      add("dsh", "DeepSeek Harness CLI", dshOk, dshVersion || DSH_BIN || "未找到 dsh",
        process.platform === "win32"
          ? "安装 DSH：npm i -g @deepseek-ai/dsh，或设置 DSH_BIN 指向 dsh.cmd"
          : "安装 DeepSeek Harness，或设置 DSH_BIN 指向 dsh 可执行文件", true);
      let cfgOk = false, agents = 0;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8"));
        agents = (cfg.agents || []).length; cfgOk = agents > 0;
      } catch (e) {}
      add("config", "config/desk.json", cfgOk, cfgOk ? agents + " 名员工已配置" : "缺失或没有 agents",
        "复制 config/desk.example.json 为 config/desk.json 并按需修改", true);
      // 凭据只看"有没有"，绝不回传内容
      let credOk = false, credDetail = "未检测到模型 Key";
      try {
        const credFile = path.join(os.homedir(), ".dsh/.credentials.yaml");
        if (fs.existsSync(credFile)) {
          const txt = fs.readFileSync(credFile, "utf8");
          credOk = /(OPENCODE|DEEPSEEK|API_KEY|api[_-]?key)/i.test(txt);
          credDetail = credOk ? "已配置（~/.dsh/.credentials.yaml）" : "文件存在但没看到 Key";
        }
      } catch (e) {}
      ["OPENCODE_GO_API_KEY", "DEEPSEEK_API_KEY"].forEach(k => { if (process.env[k]) { credOk = true; credDetail = "环境变量已设置"; } });
      add("credentials", "模型凭据", credOk, credDetail,
        "在 DSH 里配好 provider，或设置 OPENCODE_GO_API_KEY / DSH_BIN 对应 key", false);
      // vault 可写
      let vaultOk = false;
      try {
        fs.mkdirSync(path.join(ROOT, "vault"), { recursive: true });
        const t = path.join(ROOT, "vault", ".doctor-" + process.pid);
        fs.writeFileSync(t, "ok"); fs.unlinkSync(t); vaultOk = true;
      } catch (e) {}
      add("vault", "vault 目录可写", vaultOk, vaultOk ? "可写" : "不可写",
        "检查目录权限，或把项目放到用户可写的路径", true);
      // Python（可选，仅数据抽取）
      let pyOk = false, pyVer = "";
      try {
        const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
        const r = spawnSync(PY, ["--version"], { encoding: "utf8", timeout: 5000, shell: process.platform === "win32" });
        pyVer = String(r.stdout || r.stderr || "").trim();
        pyOk = r.status === 0;
      } catch (e) {}
      add("python", "Python（可选，解析 xlsx/pdf）", pyOk, pyVer || "未找到 Python",
        "安装 Python 3 并 pip install openpyxl pypdf（或设置 PYTHON）", false);
      let scrOk = false, scrDetail = "未安装 Scrapling（静态网页用内置采集器即可）";
      try {
        const scr = path.join(ROOT, "runtime/py/bin/scrapling");
        if (fs.existsSync(scr)) {
          const PY2 = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
          const chk = spawnSync(PY2, ["-c", "import scrapling, patchright"], { encoding: "utf8", timeout: 8000,
            shell: process.platform === "win32",
            env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }) });
          if (chk.status === 0) { scrOk = true; scrDetail = "已安装（JS 渲染/反爬页面用 collect --browser）"; }
          else scrDetail = "已装基础包但缺 fetchers 依赖（需要时补装）";
        }
      } catch (e) {}
      add("scrapling", "Scrapling（可选，动态网页）", scrOk, scrDetail,
        "已装 fetchers 时：collect.js get URL --browser（复用本机 Chromium）；见 docs/DATA-COLLECTION.md", false);
      // 数据源自检：免费源应零配置可用；可选源未配置只提示、不阻塞。
      let dsFree = 0, dsOptional = 0;
      try {
        const reg = loadDataRegistry();
        const h = sourceHealth.healthAll(reg.sources);
        dsFree = h.sources.filter(s => s.available && s.tier === "free").length;
        dsOptional = h.sources.filter(s => !s.available && (s.tier === "credit" || s.tier === "free-key")).length;
      } catch (e) {}
      if (dsFree === 0) {
        add("data_sources", "数据源", false, "免费源当前不可用；可选源未配置 " + dsOptional + " 个",
          "检查网络，或在右栏「数据源」查看原因；也可上传 CSV/Excel", false);
      } else {
        add("data_sources", "数据源", true, "免费可用 " + dsFree + " 个" +
          (dsOptional ? "；可选未配置 " + dsOptional + " 个（不影响使用）" : ""),
          "免费源无需配置；右栏「数据源」可查看/配置；缺口时也可上传 CSV", false);
      }
      const requiredOk = checks.filter(c => c.required).every(c => c.ok);
      return json(res, 200, { ok: requiredOk, platform: process.platform, runtime: RUNTIME,
        node: process.version, dsh: DSH_BIN || null, dshVersion, checks });
    }
    if (p === "/api/snapshot") {
      const caseId = u.searchParams.get("case") || "default";
      const files = [];
      for (const f of S.files.values()) if (f.case === caseId) files.push(pubFile(f));
      return json(res, 200, { case: caseId, files, gates: caseOf(caseId).gates,
        mission: parseMission(caseId), runtime: RUNTIME,
        actualModels: caseOf(caseId).actualModels || {},
        locks: Array.from(S.locks.values()).map(publicLock), seq: S.seq });
    }
    if (p === "/api/events") {
      if (u.searchParams.get("stream") === "1") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      const since = parseInt(u.searchParams.get("since") || "0", 10);
      return json(res, 200, { events: S.events.filter(e => e.seq > since) });
    }

    /* --- 锁 --- */
    if (p === "/api/lock" && req.method === "POST") {
      const b = await readBody(req);
      const rel = safeRel(b.path);
      if (!rel) return json(res, 400, { error: "bad path" });
      if (b.mode !== "R" && b.mode !== "W") return json(res, 400, { error: "mode must be R or W" });
      if (!b.actor) return json(res, 400, { error: "actor required" });
      const caseId = b.case || "default";
      const f = fileOf(caseId, rel);
      S.stats.acquires += 1;
      if (canGrantNow(f, b.mode)) {
        const lock = grant(f, { actor: b.actor, mode: b.mode, note: b.note, ttl: b.ttl,
          resolve: () => {}, done: false });
        return json(res, 200, { lock: publicLock(lock), waitedMs: 0 });
      }
      const waitMs = Math.min(120000, Math.max(0, parseInt(b.waitMs == null ? 30000 : b.waitMs, 10)));
      const waiter = { actor: b.actor, mode: b.mode, note: b.note, ttl: b.ttl || 120,
        enqueuedAt: Date.now(), resolve: null, done: false, timer: null, id: "Q" + (++reqSeq) };
      f.queue.push(waiter);
      emit("lock.queued", b.actor, { case: caseId, path: rel, mode: b.mode,
        position: f.queue.length, queueId: waiter.id });
      const started = Date.now();
      const result = await new Promise(resolve => {
        waiter.resolve = resolve;
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          const idx = f.queue.indexOf(waiter);
          if (idx >= 0) f.queue.splice(idx, 1);
          S.stats.timeouts += 1;
          emit("lock.timeout", b.actor, { case: caseId, path: rel, mode: b.mode,
            waitedMs: Date.now() - started, position: idx + 1 });
          resolve({ status: 202, body: { queued: false, position: idx + 1,
            queueLength: f.queue.length, waitedMs: Date.now() - started } });
        }, waitMs);
      });
      if (result.status === 200) result.body.waitedMs = Date.now() - started;
      return json(res, result.status, result.body);
    }

    const lockMatch = p.match(/^\/api\/lock\/([^/]+)(\/renew)?$/);
    if (lockMatch) {
      const lockId = decodeURIComponent(lockMatch[1]);
      const lock = S.locks.get(lockId);
      if (!lock) return json(res, 404, { error: "lock not found or expired" });
      if (lockMatch[2] === "/renew" && req.method === "POST") {
        const b = await readBody(req);
        const ttl = Math.min(600, Math.max(5, parseInt(b.ttl || lock.ttl, 10)));
        lock.ttl = ttl; lock.until = Date.now() + ttl * 1000;
        emit("lock.renewed", lock.actor, { case: lock.case, path: lock.path, lockId, ttl });
        return json(res, 200, { lock: publicLock(lock) });
      }
      if (req.method === "DELETE") {
        releaseLock(lockId, "cli-release");
        return json(res, 200, { released: true });
      }
      if (req.method === "GET") return json(res, 200, { lock: publicLock(lock) });
    }

    /* --- 文件 --- */
    if (p === "/api/file" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const rel = safeRel(u.searchParams.get("path"));
      if (!rel) return json(res, 400, { error: "bad path" });
      const f = fileOf(caseId, rel);
      const abs = vaultPath(caseId, rel);
      const exists = fs.existsSync(abs);
      const actor = u.searchParams.get("actor");
      if (actor && exists) emit("file.accessed", actor, { case: caseId, path: rel, v: f.version, mode: "peek" });
      return json(res, 200, { case: caseId, path: rel, version: f.version, sha: f.sha,
        exists, content: exists ? fs.readFileSync(abs, "utf8") : "",
        holders: f.holders.map(h => ({ actor: h.actor, mode: h.mode })),
        queue: f.queue.map((w, i) => ({ position: i + 1, actor: w.actor, mode: w.mode })) });
    }

    /* --- 本地资料转文本：xlsx→CSV / pdf→text（面板预览 + 员工读取共用） --- */
    if (p === "/api/extract" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const rel = safeRel(u.searchParams.get("path"));
      if (!rel) return json(res, 400, { error: "bad path" });
      if (!fs.existsSync(vaultPath(caseId, rel))) return json(res, 404, { error: "file not found" });
      try {
        const r = await runNode([path.join(ROOT, "scripts/extract.js"), "--case", caseId, "--path", rel]);
        if (r.code !== 0) return json(res, 200, { case: caseId, path: rel, ok: false,
          text: "（无法解析：" + String(r.err || "").trim().slice(0, 300) + "）" });
        return json(res, 200, { case: caseId, path: rel, ok: true, text: String(r.out || "").slice(0, 200000) });
      } catch (e) {
        return json(res, 500, { error: String(e && e.message || e) });
      }
    }

    /* --- 下载：原样返回文件字节（预览用 file，下载用 download） --- */
    if (p === "/api/download" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const rel = safeRel(u.searchParams.get("path"));
      if (!rel) return json(res, 400, { error: "bad path" });
      const abs = vaultPath(caseId, rel);
      if (!fs.existsSync(abs)) return json(res, 404, { error: "file not found" });
      const buf = fs.readFileSync(abs);
      const ext = path.extname(rel).toLowerCase();
      const type = { ".md": "text/markdown; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".jsonl": "application/x-ndjson; charset=utf-8", ".csv": "text/csv; charset=utf-8",
        ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".pdf": "application/pdf", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
      const disp = (u.searchParams.get("inline") === "1" ? "inline" : "attachment") +
        '; filename="' + path.basename(rel).replace(/"/g, "") + '"';
      res.writeHead(200, { "content-type": type, "content-disposition": disp,
        "content-length": buf.length, "cache-control": "no-store" });
      return res.end(buf);
    }

    if (p === "/api/file" && req.method === "PUT") {
      const b = await readBody(req);
      const rel = safeRel(b.path);
      if (!rel) return json(res, 400, { error: "bad path" });
      const caseId = b.case || "default";
      const lock = S.locks.get(b.lock);
      if (!lock) return json(res, 403, { error: "no such lock", hint: "acquire W first" });
      if (lock.mode !== "W") return json(res, 403, { error: "write requires W lock" });
      if (lock.key !== keyOf(caseId, rel)) return json(res, 403, { error: "lock does not match path" });
      const f = fileOf(caseId, rel);
      const expected = parseInt(b.expectedVersion, 10);
      if (!Number.isNaN(expected) && expected !== f.version) {
        S.stats.conflicts += 1;
        emit("file.conflict", lock.actor, { case: caseId, path: rel, expectedVersion: expected, currentVersion: f.version });
        return json(res, 409, { error: "version conflict", currentVersion: f.version,
          hint: "re-read then retry with currentVersion" });
      }
      const content = String(b.content == null ? "" : b.content);
      const sha = sha256(content);
      f.version += 1; f.sha = sha; f.writes += 1; f.lastWriteAt = new Date().toISOString();
      const abs = vaultPath(caseId, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      const hpath = path.join(HISTORY, caseId, rel.replace(/\//g, "__") + ".v" + f.version + "." + sha.slice(0, 8));
      fs.mkdirSync(path.dirname(hpath), { recursive: true });
      fs.writeFileSync(hpath, content, "utf8");
      S.stats.writes += 1;
      emit("file.written", lock.actor, { case: caseId, path: rel, v: f.version, sha,
        bytes: Buffer.byteLength(content), note: b.note || "", lockId: lock.id });
      releaseLock(lock.id, "written");
      return json(res, 200, { version: f.version, sha, bytes: Buffer.byteLength(content) });
    }

    /* --- 员工实际运行模型上报 --- */
    if (p === "/api/agent/model" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      if (!b.agent || !b.model) return json(res, 400, { error: "agent and model required" });
      const c = caseOf(caseId);
      c.actualModels = c.actualModels || {};
      c.actualModels[b.agent] = { model: b.model, provider: b.provider || null, at: new Date().toISOString() };
      emit("agent.model_actual", b.agent, { case: caseId, agent: b.agent, model: b.model,
        provider: b.provider || null });
      // 配置只是意向；真实跑的是 DSH 会话模型。不一致就记账，让面板显示出来，不假装改成功了。
      const ms = modelsOf(caseId);
      const cfg = ms.byAgent[b.agent] || ms.default;
      const mismatch = !!(cfg && (cfg.model !== b.model || (b.provider && cfg.provider && cfg.provider !== b.provider)));
      if (mismatch) {
        emit("agent.model_mismatch", b.agent, { case: caseId, agent: b.agent,
          configured: cfg, actual: { provider: b.provider || null, model: b.model } });
      }
      return json(res, 200, { ok: true, actual: c.actualModels[b.agent],
        configured: cfg || null, mismatch });
    }

    /* --- 技能与插件 --- */
    if (p === "/api/skills" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, skillsOf(caseId));
    }
    if (p === "/api/skill/install" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const st = skillsOf(caseId);
      const sk = st.catalog.find(x => x.id === b.id);
      if (!sk) return json(res, 404, { error: "no such skill" });
      const on = b.installed !== false;
      if (sk.installed === on) return json(res, 200, st);
      sk.installed = on;
      if (!on) Object.keys(st.byAgent).forEach(a => { st.byAgent[a] = st.byAgent[a].filter(x => x !== b.id); });
      emit(on ? "skill.installed" : "skill.uninstalled", "you", { case: caseId, skill: sk.id, name: sk.name });
      return json(res, 200, st);
    }
    if (p === "/api/skill/assign" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const st = skillsOf(caseId);
      const sk = st.catalog.find(x => x.id === b.id);
      if (!sk) return json(res, 404, { error: "no such skill" });
      if (!sk.installed) return json(res, 400, { error: "未安装的技能不能装配" });
      const list = st.byAgent[b.agent] = st.byAgent[b.agent] || [];
      const has = list.indexOf(b.id) >= 0;
      const on = b.on === undefined ? !has : !!b.on;
      if (on && !has) list.push(b.id);
      if (!on && has) st.byAgent[b.agent] = list.filter(x => x !== b.id);
      emit(on ? "skill.granted" : "skill.revoked", "you", { case: caseId, agent: b.agent, skill: b.id, name: sk.name });
      return json(res, 200, st);
    }
    if (p === "/api/skills/catalog" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const st = skillsOf(caseId);
      if (!b.id || !b.name) return json(res, 400, { error: "id and name required" });
      if (st.catalog.some(x => x.id === b.id)) return json(res, 409, { error: "技能已存在" });
      if (b.kind === "plugin" && b.key_ref && !/^(env|keychain):/.test(b.key_ref))
        return json(res, 400, { error: "凭据只接受 env:/keychain: 引用" });
      const entry = { id: b.id, name: b.name, cat: b.cat || "other", kind: b.kind || "skill",
        ver: b.ver || "0.1.0", author: b.author || "workspace", source: "workspace",
        installed: true, size: b.size || "—", desc: b.desc || "", doc: b.doc || "",
        perms: b.perms || {} };
      st.catalog.push(entry);
      emit("skill.added", "you", { case: caseId, skill: entry.id, name: entry.name, kind: entry.kind });
      return json(res, 200, st);
    }

    /* --- 模型配置 --- */
    if (p === "/api/models" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, Object.assign({}, modelsOf(caseId),
        { routes: (CONFIG.models && CONFIG.models.routes) || {} }));
    }
    if (p === "/api/model" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const ms = modelsOf(caseId);
      if (!b.provider || !b.model) return json(res, 400, { error: "provider and model required" });
      const known = ms.catalog.some(m => m.provider === b.provider && m.model === b.model);
      if (!known) return json(res, 400, { error: "模型不在目录里，先 POST /api/models/catalog" });
      const entry = ms.catalog.find(m => m.provider === b.provider && m.model === b.model) || {};
      const verified = entry.verified !== false;
      if (b.agent) ms.byAgent[b.agent] = { provider: b.provider, model: b.model, verified };
      else ms.default = { provider: b.provider, model: b.model, verified };
      emit("model.changed", "you", { case: caseId, agent: b.agent || null,
        provider: b.provider, model: b.model, verified });
      return json(res, 200, Object.assign({ verified }, ms));
    }
    if (p === "/api/models/catalog" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const ms = modelsOf(caseId);
      if (!b.provider || !b.model) return json(res, 400, { error: "provider and model required" });
      if (!/^[a-z0-9._-]+$/i.test(b.provider)) return json(res, 400, { error: "provider 只能字母数字与 . _ -" });
      if (ms.catalog.some(m => m.provider === b.provider && m.model === b.model))
        return json(res, 409, { error: "该 provider 下已存在同名模型" });
      if (b.key_ref && !/^(env|keychain):/.test(b.key_ref))
        return json(res, 400, { error: "key_ref 只接受 env:XXX 或 keychain:XXX，不能存明文" });
      // 自建 provider：有 base_url 就可以被 employee.js 写成"手写网关"路由（wired=可试跑），
      // 但没实测过，verified 仍为 false；跑成功一轮后 employee.js 会回调 /api/model/verified 打上实测标记
      let headers = {};
      if (b.headers !== undefined) {
        if (!b.headers || typeof b.headers !== "object" || Array.isArray(b.headers))
          return json(res, 400, { error: "headers 必须是 JSON 对象" });
        for (const k of Object.keys(b.headers)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(k) || typeof b.headers[k] !== "string")
            return json(res, 400, { error: "headers 的 key/value 必须是字符串，key 只允许字母数字 _ -" });
        }
        headers = b.headers;
      }
      const entry = { id: b.provider + "/" + b.model, provider: b.provider, model: b.model,
        label: b.label || b.model, ctx: parseInt(b.ctx, 10) || 128000, tag: "自建",
        builtin: false, verified: false, base_url: b.base_url || "", key_ref: b.key_ref || "",
        api: b.api || "", headers };
      ms.catalog.push(entry);
      emit("model.added", "you", { case: caseId, provider: entry.provider, model: entry.model,
        label: entry.label, ctx: entry.ctx, key_ref: entry.key_ref,
        base_url: entry.base_url, api: entry.api, headers: entry.headers || {} });
      return json(res, 200, ms);
    }
    // 员工跑通一轮后回报"这个模型实测可用"（只有自建 provider 会走这里）
    if (p === "/api/model/verified" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const ms = modelsOf(caseId);
      const m = ms.catalog.find(x => x.provider === b.provider && x.model === b.model);
      if (!m) return json(res, 404, { error: "模型不在目录里" });
      m.verified = true;
      emit("model.verified", b.by || "employee", { case: caseId, provider: m.provider, model: m.model });
      return json(res, 200, { ok: true, provider: m.provider, model: m.model, verified: true });
    }
    const catDel = p.match(/^\/api\/models\/catalog\/(.+)$/);
    if (catDel && req.method === "DELETE") {
      const caseId = u.searchParams.get("case") || "default";
      const ms = modelsOf(caseId);
      const id = decodeURIComponent(catDel[1]);
      const m = ms.catalog.find(x => x.id === id);
      if (!m) return json(res, 404, { error: "not found" });
      if (m.builtin) return json(res, 400, { error: "内置模型不可删" });
      ms.catalog = ms.catalog.filter(x => x.id !== id);
      Object.keys(ms.byAgent).forEach(a => {
        if (ms.byAgent[a].provider === m.provider && ms.byAgent[a].model === m.model) delete ms.byAgent[a];
      });
      if (ms.default.provider === m.provider && ms.default.model === m.model)
        ms.default = CONFIG.models.default && CONFIG.models.default.provider
          ? { provider: CONFIG.models.default.provider, model: CONFIG.models.default.model } : null;
      emit("model.removed", "you", { case: caseId, provider: m.provider, model: m.model });
      return json(res, 200, ms);
    }

    /* --- 派活 --- */
    if (p === "/api/task" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = b.agent;
      if (!agent) return json(res, 400, { error: "agent required" });
      if (!b.text) return json(res, 400, { error: "text required" });
      if (SCHED.legacyTaskApi !== true) {
        return json(res, 409, { error: "legacy task API 已停用：当前使用 WorkItem 双层执行",
          hint: "请用 /api/plan 或 /api/work/*；WorkItem 状态由 run-dag 管理" });
      }
      if ((works.get(caseId) || []).length) {
        return json(res, 409, { error: "该 case 已启用 WorkItem 双层执行，legacy task API 已停用",
          hint: "请用 /api/plan 或 /api/work/*；WorkItem 状态由 run-dag 管理" });
      }
      taskSeq += 1;
      const task = { id: "T" + taskSeq, case: caseId, agent, text: b.text,
        name: b.name || String(b.text).replace(/^【[^】]*】/, "").trim().slice(0, 40),
        target: b.target || null, status: "queued", createdAt: new Date().toISOString(),
        by: b.by || "you", model: b.model || "" };
      if (!tasks.has(caseId)) tasks.set(caseId, []);
      tasks.get(caseId).push(task);
      emit("task.assigned", b.by || "you", { case: caseId, agent, taskId: task.id,
        text: b.text, target: task.target });
      return json(res, 200, { task });
    }
    if (p === "/api/tasks" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { tasks: tasks.get(caseId) || [] });
    }
    if (p === "/api/task/done" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = tasks.get(caseId) || [];
      const t = (b.id ? list.find(x => x.id === b.id) : null) ||
        (b.agent ? list.filter(x => x.agent === b.agent && x.status !== "done").pop() : null);
      if (!t) return json(res, 404, { error: "no such task" });
      if (t.status === "done") return json(res, 200, { task: t, unchanged: true });
      t.status = "done";
      t.doneAt = new Date().toISOString();
      if (b.summary) t.summary = b.summary;
      if (Array.isArray(b.deliverables)) t.deliverables = b.deliverables;
      emit("task.delivered", t.agent, { case: caseId, agent: t.agent, taskId: t.id,
        summary: b.summary || "", deliverables: b.deliverables || [] });
      return json(res, 200, { task: t });
    }
    if (p === "/api/task/update" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = tasks.get(caseId) || [];
      const t = list.find(x => x.id === b.id);
      if (!t) return json(res, 404, { error: "no such task" });
      if (typeof b.name === "string" && b.name.trim()) t.name = b.name.trim().slice(0, 80);
      if (typeof b.model === "string") t.model = b.model.trim().slice(0, 200);
      emit("task.updated", b.by || "you", { case: caseId, agent: t.agent, taskId: t.id,
        name: t.name || "", model: t.model || "" });
      return json(res, 200, { task: t });
    }

    function planDepsDone(caseId, plan) {
      const deps = (plan && plan.dependsOn) || [];
      return deps.every(id => {
        const p0 = (plans.get(caseId) || []).find(x => x.id === id);
        if (!p0) return false;
        const ws = (works.get(caseId) || []).filter(w => w.planId === p0.id && w.kind !== "child");
        return ws.length > 0 && ws.every(w => w.state === "done");
      });
    }
    function nextPlanId() {
      const used = new Set();
      for (const list of plans.values()) (list || []).forEach(p => used.add(p.id));
      let id;
      do { id = "PL" + (++planSeq); } while (used.has(id));
      return id;
    }
    function resumeApprovedPlans(caseId, trigger) {
      const out = [];
      (plans.get(caseId) || []).filter(p => p.status === "approved" && !(p.blockedOnNeed || []).length)
        .forEach(p => {
          const r = autoRunPlan(caseId, p.id, trigger || "resume");
          if (r) out.push({ planId: p.id, run: r });
        });
      return out;
    }
    function autoRunPlan(caseId, planId, trigger) {
      if ((CONFIG.scheduler || {}).autoRun === false) return null;
      const key = caseId + "|" + planId;
      if (autoRuns.has(key)) return { skipped: "already-running", pid: autoRuns.get(key) };
      const lock = readRunLock(caseId, planId);
      if (lock) { autoRuns.set(key, lock.pid); return { skipped: "already-running", pid: lock.pid }; }
      const plan = (plans.get(caseId) || []).find(x => x.id === planId);
      if (!plan || plan.status !== "approved") return null;
      if (!planDepsDone(caseId, plan)) return { skipped: "waiting-dependencies", deps: plan.dependsOn };
      const dir = path.join(ROOT, "runtime/auto-runs");
      fs.mkdirSync(dir, { recursive: true });
      const logPath = path.join(dir, planId + "-" + Date.now() + ".log");
      let fd = null;
      try {
        fd = fs.openSync(logPath, "a");
        const child = spawn(process.execPath, [path.join(ROOT, "scripts/run-dag.js"),
          "--case", caseId, "--plan", planId, "--max-concurrency", String(Math.max(1, Number((CONFIG.scheduler || {}).maxConcurrency) || 1))],
          { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
            env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        autoRuns.set(key, child.pid);
        writeRunLock(caseId, planId, child.pid);
        child.on("exit", () => { autoRuns.delete(key); clearRunLock(caseId, planId, child.pid); });
        child.unref();
        emit("plan.autorun", "system", { case: caseId, planId, agent: plan.agent,
          pid: child.pid, trigger: trigger || "update", log: path.relative(ROOT, logPath) });
        return { pid: child.pid, log: path.relative(ROOT, logPath) };
      } catch (e) {
        return { error: String(e && e.message || e) };
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
      }
    }
    function intentReplyText(caseId, agent, kind) {
      if (kind === "ack") return "收到。";
      const pending = (needs.get(caseId) || []).filter(n => n.status !== "answered");
      const list = (plans.get(caseId) || []).filter(p => p.agent === agent);
      const plan = list.filter(p => p.status === "approved").pop() || list[list.length - 1];
      const items = plan ? (works.get(caseId) || []).filter(w => w.planId === plan.id) : [];
      const done = items.filter(w => w.state === "done").length;
      const running = items.filter(w => w.state === "running").length;
      let txt = "这是询问，不新增任务。";
      if (plan) txt += "当前计划 " + plan.id + "（" + plan.steps.length + " 个任务，" + plan.status + "）" +
        (items.length ? "，调度进度 " + done + "/" + items.length + (running ? "，正在执行 " + running + " 个节点" : "") : "，尚无调度节点");
      else txt += "当前还没有已生成的任务计划；先描述目标/要做什么，我再拆任务。";
      txt += pending.length ? "。待补数据：" + pending.slice(0, 5).map(n => n.title).join("；") : "。暂无待补数据。";
      return txt.slice(0, 900);
    }
    function parseIndicatorDef(text) {
      const s = String(text || "");
      let id = "", name = "", aliases = [];
      if (s.indexOf("|") >= 0) {
        const parts = s.split("|").map(x => x.trim()).filter(Boolean);
        id = parts[1] || ""; name = parts[2] || "";
        aliases = (parts[3] || "").split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      } else {
        const mid = s.match(/(?:id|ID)\s*[=:：]\s*([a-zA-Z0-9._-]+)/);
        const mname = s.match(/(?:名称|name)\s*[=:：]\s*([^,，;；\n]+)/i);
        const mal = s.match(/(?:别名|aliases)\s*[=:：]\s*([^\n]+)/i);
        id = mid ? mid[1] : ""; name = mname ? mname[1].trim() : "";
        aliases = mal ? mal[1].split(/[,，、]/).map(x => x.trim()).filter(Boolean) : [];
      }
      return { id: id.trim(), name: name.trim(), aliases };
    }
    function saveIndicator(def, by) {
      const p = path.join(ROOT, "config/indicators.json");
      let cfg = { version: 1, indicators: [] };
      try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {}
      cfg.indicators = cfg.indicators || [];
      if (!/^[a-z][a-z0-9._-]{2,60}$/.test(def.id))
        return { error: "指标 ID 需小写字母开头，只含小写字母/数字/._-，长度 3-60" };
      if (cfg.indicators.some(x => x.id === def.id))
        return { error: "指标 ID 已存在：" + def.id };
      const aliases = Array.from(new Set((def.aliases || []).map(x => String(x).trim()).filter(Boolean)));
      const item = { id: def.id, name: def.name || def.id, aliases,
        dimensions: def.dimensions || {}, addedAt: new Date().toISOString(), addedBy: by || "you" };
      cfg.indicators.push(item);
      fs.writeFileSync(p + ".tmp", JSON.stringify(cfg, null, 2) + "\n");
      fs.renameSync(p + ".tmp", p);
      if (indicatorApi && indicatorApi.reload) indicatorApi.reload();
      emit("indicator.added", by || "you", { id: item.id, name: item.name, aliases: item.aliases });
      return { indicator: item };
    }
    if (p === "/api/indicator/add" && req.method === "POST") {
      const b = await readBody(req);
      const def = { id: String(b.id || "").trim(), name: String(b.name || "").trim(),
        aliases: Array.isArray(b.aliases) ? b.aliases : [], dimensions: b.dimensions || {} };
      const r = saveIndicator(def, b.by);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, r);
    }
    if (p === "/api/indicator/remove" && req.method === "POST") {
      const b = await readBody(req);
      const fp = path.join(ROOT, "config/indicators.json");
      const cfg = JSON.parse(fs.readFileSync(fp, "utf8"));
      const before = (cfg.indicators || []).length;
      cfg.indicators = (cfg.indicators || []).filter(x => x.id !== b.id);
      if (cfg.indicators.length === before) return json(res, 404, { error: "not found" });
      fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + "\n");
      if (indicatorApi && indicatorApi.reload) indicatorApi.reload();
      emit("indicator.removed", b.by || "you", { id: b.id });
      return json(res, 200, { ok: true, id: b.id });
    }
    /* --- 用户在中栏对话：规则快筛 → 明确问题直接回复；任务/歧义交给 planner --- */
    if (p === "/api/intent" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = String(b.agent || "");
      const text = String(b.text || "").trim();
      if (!agent || !text) return json(res, 400, { error: "agent/text required" });
      // 对话式登记新指标：不生成任务、不调用模型
      if (/^(新增|登记|添加|落)(一个)?指标/.test(text) || /^新增指标/.test(text) || /登记指标/.test(text)) {
        const def = parseIndicatorDef(text);
        if (!def.id || !def.name) {
          const usage = "用法：新增指标 | cn.xxx | 指标名称 | 别名1,别名2（ID 需小写字母开头）";
          emit("agent.reply", agent, { case: caseId, agent, kind: "indicator", text: usage, by: "rule" });
          return json(res, 200, { ok: false, kind: "indicator", reply: usage });
        }
        const saved = saveIndicator(def, "you");
        if (saved.error) {
          emit("agent.reply", agent, { case: caseId, agent, kind: "indicator", text: saved.error, by: "rule" });
          return json(res, 400, { error: saved.error });
        }
        const reply = "已登记指标 " + saved.indicator.id + "（" + saved.indicator.name + "）" +
          (saved.indicator.aliases.length ? "，别名：" + saved.indicator.aliases.join("、") : "") +
          "。后续 need 解析会用这个 ID 去重。";
        emit("agent.reply", agent, { case: caseId, agent, kind: "indicator", text: reply, by: "rule" });
        return json(res, 200, { ok: true, kind: "indicator", indicator: saved.indicator, reply });
      }
      // 明确的“研究行业/个股：X”是派活指令；必须先于数据补充路由判断，
      // 否则“研究个股：补齐…”会因为含“价格/数据”被截成 intake，永远进不了模型规划。
      const explicitResearch = /^(研究行业|研究个股|研究公司|分析行业|分析个股)\s*[：:]/.test(text);
      // URL 数据解析：绑定 need 的 intake 子请求，不进入主计划
      const isUrl = /https?:\/\//.test(text);
      const wantsData = /(解析|抓取|提取|整理|补充|入库|数据|价格)/.test(text);
      const isPunctuatedQuestion = /[?？]\s*$/.test(text) || /(吗|呢)\s*$/.test(text);
      if (!explicitResearch && isUrl && wantsData && !isPunctuatedQuestion) {
        const candidates = matchNeedItems(caseId, text);
        const url0 = (text.match(/https?:\/\/[^\s)]+/) || [""])[0];
        const existing = (intakes.get(caseId) || []).slice().reverse().find(x => x.agent === agent &&
          (x.status === "needs_source" || x.status === "needs_target"));
        let it;
        if (existing) {
          existing.url = url0; existing.text = text; existing.updatedAt = new Date().toISOString();
          const top = candidates.find(c => c.confidence === "high" && (c === candidates[0] || candidates[0].score - c.score < 3));
          if (existing.status === "needs_target" && candidates[0] && candidates[0].confidence === "high" &&
              (!candidates[1] || candidates[0].score - candidates[1].score >= 3)) {
            existing.needId = candidates[0].needId; existing.index = candidates[0].index;
          }
          existing.status = existing.needId ? "queued" : "needs_target";
          existing.candidates = candidates;
          it = existing;
          if (it.status === "queued") spawnIntakeWorker(it);
        } else {
          it = createIntake(caseId, agent, text, url0, candidates);
        }
        emit("intent.classified", "you", { case: caseId, agent, kind: "data_intake",
          method: "url-rule", candidates: candidates.slice(0, 3) });
        let reply;
        if (it.status === "queued") {
          reply = "已登记为数据补充子请求 " + it.id + "，目标：" + it.needId + " 第 " + it.index +
            " 项「" + ((candidates[0] || {}).indicator || "") + "」。不进入主任务列表；我会按网页解析结果判断覆盖是否足够，不足会保持 pending 并提示继续补 URL。";
        } else if (candidates.length) {
          reply = "已登记为数据补充子请求 " + it.id + "，但无法唯一确定目标待补项。候选：" +
            candidates.slice(0, 3).map(c => c.needId + " 第 " + c.index + " 项「" + c.indicator + "」").join("；") +
            "。请回复要补哪一项。";
        } else {
          reply = "已登记为数据补充子请求 " + it.id + "，但没有找到匹配的待补项。请指定要补的 need/指标。";
        }
        emit("agent.reply", agent, { case: caseId, agent, kind: "data_intake", text: reply, by: "rule" });
        return json(res, 200, { ok: true, kind: "data_intake", intake: it, reply });
      }
      // 非 URL 的数据补充请求：同样进入 need 级 intake，不进主计划
      if (!explicitResearch && isDataSupplementIntent(text)) {
        const candidates = matchNeedItems(caseId, text);
        const it = createIntake(caseId, agent, text, "", candidates);
        emit("intent.classified", "you", { case: caseId, agent, kind: "data_request",
          method: "data-rule", candidates: candidates.slice(0, 3) });
        let reply;
        if (it.status === "needs_source" && it.needId) {
          reply = "已登记为数据补充子请求 " + it.id + "，目标：" + it.needId + " 第 " + it.index +
            " 项「" + ((candidates[0] || {}).indicator || "") + "」。不进入主任务列表；请提供 URL 或文件，我再解析并判断覆盖。";
        } else if (candidates.length) {
          reply = "已登记为数据补充子请求 " + it.id + "，但目标待补项不唯一。候选：" +
            candidates.slice(0, 3).map(c => c.needId + " 第 " + c.index + " 项「" + c.indicator + "」").join("；") +
            "。请指定要补哪一项。";
        } else {
          reply = "已登记为数据补充子请求 " + it.id + "，但没有找到匹配的待补项。请指定 need/指标，或先创建数据缺口。";
        }
        emit("agent.reply", agent, { case: caseId, agent, kind: "data_intake", text: reply, by: "rule" });
        return json(res, 200, { ok: true, kind: "data_request", intake: it, reply });
      }
      // 明确的“研究行业/个股：X”是派活指令，不能被规则分类器降级成 ambiguous。
      const cls = explicitResearch ? { kind: "task", method: "explicit", scores: { q: 0, t: 9 }, reasons: ["explicit research prefix"] }
        : (classifyIntentRule ? classifyIntentRule(text)
        : { kind: "ambiguous", method: "fallback", scores: { q: 0, t: 0 }, reasons: [] });
      emit("intent.classified", "you", { case: caseId, agent, kind: cls.kind,
        method: cls.method, scores: cls.scores, reasons: cls.reasons });
      if (cls.kind === "question" || cls.kind === "ack") {
        const reply = intentReplyText(caseId, agent, cls.kind);
        emit("agent.reply", agent, { case: caseId, agent, kind: cls.kind, text: reply, by: "rule" });
        return json(res, 200, { ok: true, kind: cls.kind, answered: true, reply });
      }
      const planner = path.join(ROOT, "scripts/planner.js");
      const args = [planner, "--case", caseId, "--agent", agent, "--intent", text];
      if (b.forceNew === true) args.push("--force-new");
      else args.push("--use-model");
      if (cls.kind === "ambiguous" || cls.kind === "mixed") args.push("--classify-only");
      try {
        const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: "ignore",
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        child.unref();
      } catch (e) {}
      emit("intent.received", "you", { case: caseId, agent, text: text.slice(0, 500), kind: cls.kind });
      return json(res, 200, { ok: true, planning: true, kind: cls.kind, method: cls.method });
    }
    if (p === "/api/plan" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = String(b.agent || "").slice(0, 20);
      if (!agent) return json(res, 400, { error: "agent required" });
      const rawSteps = Array.isArray(b.steps) ? b.steps : [];
      if (!rawSteps.length) return json(res, 400, { error: "steps required" });
      const steps = rawSteps.slice(0, 12).map((x, i) => ({
        id: String(x.id || ("S" + i)).slice(0, 20),
        name: String(x.name || ("任务" + (i + 1))).slice(0, 60),
        tier: ["fast", "strong", "verify"].indexOf(x.tier) >= 0 ? x.tier : "strong",
        task: String(x.task || "").slice(0, 1000),
        outputs: Array.isArray(x.outputs) ? x.outputs.slice(0, 6) : [],
        depends: Array.isArray(x.depends) ? x.depends.slice(0, 6) : [],
        dependsExplicit: x.dependsExplicit === true,
        agent, failurePolicy: ["required", "degradable", "optional"].indexOf(x.failurePolicy) >= 0 ? x.failurePolicy : "required",
        parentId: String(x.parentId || ""), branchId: String(x.branchId || ""),
        merge_from: Array.isArray(x.merge_from || x.mergeFrom) ? (x.merge_from || x.mergeFrom).slice(0, 5) : [],
        modelChain: Array.isArray(x.modelChain) ? x.modelChain : [],
        waitForPlans: Array.isArray(x.waitForPlans) ? x.waitForPlans.map(String).slice(0, 5) : [],
        maxTokens: Math.max(0, Math.round(Number(x.maxTokens) || 0)),
        envelope: (x.envelope && typeof x.envelope === "object") ? x.envelope : null
      }));
      const serviceAgent = agent === "audit" || agent === "legal" || agent === "trader";
      const status = b.status || (serviceAgent ? "approved" : "pending");
      const now = new Date().toISOString();
      const plan = { id: nextPlanId(), case: caseId, agent,
        goal: String(b.goal || "研究计划").slice(0, 300), steps,
        planner: b.planner || null, version: 1, history: [], status,
        planning: status === "planning", blockedOnNeed: [],
        createdAt: now, approvedAt: status === "approved" ? now : null,
        approvedBy: status === "approved" ? (b.by || "you") : "", note: "",
        parentPlanId: b.parentPlanId || "", relation: b.relation || "" };
      if (!plans.has(caseId)) plans.set(caseId, []);
      plans.get(caseId).push(plan);
      emit("plan.created", b.by || "planner", { case: caseId, planId: plan.id, agent,
        goal: plan.goal, steps: plan.steps, stepCount: plan.steps.length, status: plan.status,
        planner: plan.planner, version: plan.version, parentPlanId: plan.parentPlanId });
      return json(res, 200, { plan });
    }
    if (p === "/api/plan/merge" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = String(b.agent || "").slice(0, 20);
      let plan = (plans.get(caseId) || []).find(x => x.id === b.planId) ||
        (plans.get(caseId) || []).filter(x => x.agent === agent && x.status !== "rejected").pop();
      if (!plan) {
        if (!plans.has(caseId)) plans.set(caseId, []);
        plan = { id: nextPlanId(), case: caseId, agent, goal: String(b.goal || "研究计划").slice(0, 300),
          steps: [], planner: null, version: 1, history: [], status: "pending", blockedOnNeed: [],
          createdAt: new Date().toISOString(), approvedAt: null, approvedBy: "", note: "" };
        plans.get(caseId).push(plan);
        emit("plan.created", b.by || "planner", { case: caseId, planId: plan.id, agent,
          goal: plan.goal, steps: [], stepCount: 0, status: "pending", planner: null, version: 1 });
      }
      const before = JSON.parse(JSON.stringify(plan.steps || []));
      const oldVer = plan.version || 1;
      plan.version = oldVer + 1;
      plan.history = (plan.history || []).slice(-12).concat([{ version: oldVer, at: new Date().toISOString(),
        by: b.by || "planner", reason: b.reason || "merge", steps: before }]);
      let skipped = 0;
      (Array.isArray(b.remove) ? b.remove : []).forEach(id => {
        const n = plan.steps.length; plan.steps = plan.steps.filter(x => x.id !== id); if (n === plan.steps.length) skipped += 1;
      });
      (Array.isArray(b.update) ? b.update : []).forEach(u => {
        const cur = plan.steps.find(x => x.id === u.id);
        if (!cur) { skipped += 1; return; }
        Object.assign(cur, u);
        const wi = (works.get(caseId) || []).find(x => x.planId === plan.id && x.nodeId === u.id);
        if (wi && wi.state !== "running" && wi.state !== "cancelling") {
          if (typeof u.task === "string" && u.task.trim()) wi.task = u.task;
          if (typeof u.name === "string" && u.name.trim()) wi.name = u.name;
          emit("work.updated", b.by || "you", { case: caseId, workId: wi.id, planId: plan.id,
            nodeId: wi.nodeId, name: wi.name, task: wi.task.slice(0, 160) });
        }
      });
      (Array.isArray(b.add) ? b.add : []).forEach(x => {
        let id = String(x.id || ("A" + Date.now().toString(36)));
        while (plan.steps.some(y => y.id === id)) id += "x";
        plan.steps.push(Object.assign({ tier: "strong", task: "", outputs: [], depends: [], agent,
          failurePolicy: "required", parentId: "", branchId: "", merge_from: [], modelChain: [] }, x, { id }));
      });
      // 已批准计划一旦被改动，必须重新走人工审批，避免“先批准、后改步骤”绕过审批。
      const changed = (b.add || []).length + (b.remove || []).length + (b.update || []).length;
      let approvalRevoked = false;
      if (plan.status === "approved" && changed) {
        plan.status = "pending"; plan.approvedAt = null; plan.approvedBy = "";
        approvalRevoked = true;
        emit("plan.approval_revoked", b.by || "planner", { case: caseId, planId: plan.id, agent,
          reason: "计划在批准后被修改，需重新审批", version: plan.version, steps: plan.steps.length });
      }
      emit("plan.revised", b.by || "planner", { case: caseId, planId: plan.id, agent,
        version: plan.version, added: (b.add || []), removed: (b.remove || []), updated: (b.update || []),
        steps: plan.steps.length, stepsData: plan.steps, skipped, approvalRevoked });
      return json(res, 200, { plan, skipped });
    }
    if (p === "/api/plan/resume" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const runs = resumeApprovedPlans(caseId, b.trigger || "manual-resume");
      return json(res, 200, { ok: true, runs });
    }
    if (p === "/api/plan/autorun" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.id);
      if (!plan) return json(res, 404, { error: "no such plan" });
      if (plan.status !== "approved") return json(res, 409, { error: "plan not approved", status: plan.status });
      const run = autoRunPlan(caseId, plan.id, b.trigger || "manual");
      return json(res, 200, { ok: true, run });
    }
    if (p === "/api/plan/run" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.id);
      if (!plan) return json(res, 404, { error: "no such plan" });
      if (plan.status !== "approved") return json(res, 409, { error: "plan not approved" });
      try {
        const child = spawn(process.execPath, [path.join(ROOT, "scripts/run-plan.js"),
          "--case", caseId, "--plan", plan.id], { cwd: ROOT, detached: true, stdio: "ignore",
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        child.unref();
      } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
      emit("plan.run", "you", { case: caseId, planId: plan.id, agent: plan.agent });
      return json(res, 200, { ok: true, started: true });
    }

    function needSpecUnion(a, b) {
      const itemsA = (a && a.spec && a.spec.items) || [];
      const itemsB = (b && b.spec && b.spec.items) || [];
      const map = {};
      itemsA.forEach(it => { const id = indicatorApi ? indicatorApi.resolve(it) : (it.indicator || ""); map[id] = it; });
      itemsB.forEach(it => { const id = indicatorApi ? indicatorApi.resolve(it) : (it.indicator || ""); if (!map[id]) map[id] = it; });
      const items = Object.keys(map).map(k => map[k]);
      return { summary: (a.spec && a.spec.summary) || (b.spec && b.spec.summary) || "合并后的数据缺口", items };
    }
    function canonicalNeedIds(need) {
      if (indicatorApi) return indicatorApi.needIndicatorIds(need);
      return [];
    }
    /* --- 员工主动提问 / 申请（数据、技能、信息、插件、权限） --- */
    function appendDeadLetter(job, reason) {
      try {
        const f = path.join(ROOT, "runtime/data/dead-letter.jsonl");
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), jobId: job.id, case: job.case,
          metric: job.metric, sourceId: job.sourceId, range: job.range, error: String(reason || job.error || "").slice(0, 800) }) + String.fromCharCode(10));
      } catch (e) {}
    }
    function spawnDataWorker(caseId) {
      try {
        const dir = path.join(ROOT, "runtime/data/workers"); fs.mkdirSync(dir, { recursive: true });
        const fd = fs.openSync(path.join(dir, Date.now() + ".log"), "a");
        const cp = spawn(process.execPath, [path.join(ROOT, "scripts/data-worker.js"),
          "--case", caseId, "--once"], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref(); try { fs.closeSync(fd); } catch (e) {}
      } catch (e) {}
    }
    function createDataJob(caseId, metric, sourceId, range, needId, index, by, agent, chain, allowPaid, forceRefresh) {
      if (!metric || !sourceId) return null;
      const existing = listDataJobs(caseId).find(j => j.metric === metric.id && j.range === (range || "") &&
        j.needId === (needId || "") && ["queued", "running", "extracted"].indexOf(j.status) >= 0);
      if (existing) return existing;
      const id = "DJ" + Date.now().toString(36) + (++dataJobSeq);
      const sourceChain = (Array.isArray(chain) && chain.length ? chain : [sourceId]).slice(0, 20);
      const job = { id, case: caseId, metric: metric.id, sourceId, sourceChain, sourceAttempts: [], url: "", vars: {},
        needId: needId || "", index: index === undefined ? null : index, agent: agent || "industry",
        range: String(range || "").slice(0, 40), status: "queued", attempts: 0, allowPaid: allowPaid === true,
        forceRefresh: forceRefresh === true,
        records: [], coverage: 0, expected: 0, missing: [], raw: "", out: "",
        error: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), owner: "" };
      writeDataJob(job);
      emit("data.job.queued", by || "system", { case: caseId, jobId: id, metric: metric.id, sourceId,
        needId: job.needId, index: job.index, auto: true });
      spawnDataWorker(caseId);
      return job;
    }
    function autoEnqueueNeed(caseId, need) {
      if (!need || need.kind !== "data" || !need.spec || !Array.isArray(need.spec.items)) return [];
      const reg = loadDataRegistry();
      const created = [];
      need.spec.items.forEach((item, index) => {
        if (!item || item.status === "provided" || item.status === "waived") return;
        if (item.auto && ["queued", "running", "done"].indexOf(item.auto.status) >= 0) return;
        const rr = metricResolver.resolve(item, reg.metrics);
        item.match = rr;
        emit("metric.resolved", "system", { case: caseId, needId: need.id, index, indicator: item.indicator,
          state: rr.state, metricId: rr.metricId || "", method: rr.method, confidence: rr.confidence, reasons: rr.reasons || [] });
        if (rr.state !== "confirmed") {
          item.auto = { status: rr.state === "draft" ? "no_source" : "needs_review",
            metric: rr.metricId || "", reason: (rr.reasons && rr.reasons.join("；")) || (rr.state === "draft" ? "无匹配 metric，需人工确认/建 draft" : "指标匹配待确认"),
            matchState: rr.state, at: new Date().toISOString() };
          emit("need.auto", "system", { case: caseId, needId: need.id, index, indicator: item.indicator, auto: item.auto, match: rr });
          return;
        }
        const metric = reg.metrics.find(m => m.id === rr.metricId);
        if (!metric) { item.auto = { status: "no_source", reason: "匹配 metric 不存在", at: new Date().toISOString() };
          emit("need.auto", "system", { case: caseId, needId: need.id, index, indicator: item.indicator, auto: item.auto, match: rr }); return; }
        // 免费优先 fallback 链：不可用来源（缺 token / 积分不足 / 账号源 / draft）在这里被跳过并留下原因。
        const bc = sourceChain.buildChain(metric, reg.sources);
        if (!bc.chain.length) {
          item.auto = { status: "no_source", metric: metric.id, reason: sourceChain.noSourceReason(bc.skipped, metric),
            skipped: bc.skipped, at: new Date().toISOString() };
          emit("need.auto", "system", { case: caseId, needId: need.id, index, indicator: item.indicator, auto: item.auto, match: rr });
          return;
        }
        const chosenId = bc.chain[0];
        const chosenSrc = reg.sources.find(s => s.id === chosenId || s.configSource === chosenId) || {};
        const pc = sourcePolicy.checkSource(chosenSrc, { allowPaid: false });
        if (!pc.ok && (pc.code === "needs_paid_approval" || pc.code === "quota_exhausted")) {
          item.auto = { status: pc.code, metric: metric.id, sourceId: chosenId,
            reason: pc.reason, cost: pc.cost || null, at: new Date().toISOString() };
          emit("need.auto", "system", { case: caseId, needId: need.id, index, indicator: item.indicator, auto: item.auto, match: rr });
          return;
        }
        const job = createDataJob(caseId, metric, chosenId, item.range || need.spec.range || "",
          need.id, index, "system", need.agent, bc.chain);
        if (job) { item.auto = { status: "queued", jobId: job.id, metric: metric.id, sourceId: chosenId,
          sourceChain: bc.chain, skipped: bc.skipped, at: new Date().toISOString() };
          emit("need.auto", "system", { case: caseId, needId: need.id, index, indicator: item.indicator, auto: item.auto, match: rr });
          created.push(job.id); }
      });
      return created;
    }
    if (p === "/api/need" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = b.agent || "system";
      const kind = ["data", "skill", "info", "plugin", "permission", "other"].indexOf(b.kind) >= 0 ? b.kind : "other";
      if (!b.title) return json(res, 400, { error: "title required（一句话说清缺什么）" });
      needSeq += 1;
      const need = { id: "N" + needSeq, case: caseId, agent, kind,
        title: String(b.title).slice(0, 300), detail: String(b.detail || "").slice(0, 2000),
        blocking: b.blocking !== false, planId: b.planId || "", stepId: b.stepId || "",
        spec: b.spec && typeof b.spec === "object" ? b.spec : null,
        status: "pending", createdAt: new Date().toISOString(),
        answer: null, answeredAt: null, answeredBy: null };
      // 指标级去重：规范 ID + 子集/超集合并
      need.indicatorIds = canonicalNeedIds(need);
      need.dedupeKey = sha256((need.indicatorIds || []).join("|") || need.title).slice(0, 12);
      const pending = (needs.get(caseId) || []).filter(x => x.status === "pending");
      // 新需求是已有需求的子集 → 复用已有（更宽）需求
      const superset = pending.filter(p => (need.indicatorIds || []).length &&
        (p.indicatorIds || []).length && indicatorApi.isSubset(need.indicatorIds, p.indicatorIds))
        .sort((a, b) => (b.indicatorIds || []).length - (a.indicatorIds || []).length)[0];
      if (superset) {
        emit("need.merged", agent, { case: caseId, needId: superset.id, canonicalId: superset.id,
          mergedFrom: [superset.id], subset: true, title: need.title, agent });
        return json(res, 200, { need: superset, merged: true, subset: true });
      }
      // 已有需求是新需求的子集 → 扩展已有需求，不再新增
      const subsets = pending.filter(p => (p.indicatorIds || []).length &&
        (need.indicatorIds || []).length && indicatorApi.isSubset(p.indicatorIds, need.indicatorIds));
      if (subsets.length) {
        const target = subsets[0];
        const union = needSpecUnion(target, need);
        target.spec = union;
        target.indicatorIds = canonicalNeedIds(target);
        target.detail = (target.detail || "") + (target.detail ? "\n" : "") +
          "已并入：" + need.title + "（" + need.indicatorIds.join(", ") + "）";
        target.blocking = target.blocking || need.blocking;
        const mergedIds = subsets.map(p => p.id);
        subsets.slice(1).forEach(p => {
          p.status = "superseded"; p.supersededBy = target.id;
          emit("need.superseded", "system", { case: caseId, needId: p.id, canonicalId: target.id, agent: p.agent });
        });
        emit("need.merged", agent, { case: caseId, needId: target.id, canonicalId: target.id,
          mergedFrom: mergedIds, added: need.indicatorIds.length, title: target.title, agent });
        return json(res, 200, { need: target, merged: true, expanded: true });
      }
      // 部分重叠：不自动合并，交给小模型判断 + 人工确认
      const partial = pending.filter(p => {
        const a = need.indicatorIds || [], b = p.indicatorIds || [];
        if (!a.length || !b.length) return false;
        const inter = a.filter(x => b.indexOf(x) >= 0);
        if (!inter.length) return false;
        const aSubB = indicatorApi.isSubset(a, b), bSubA = indicatorApi.isSubset(b, a);
        return !aSubB && !bSubA;
      });
      if (partial.length) {
        need.pendingDedupe = { candidateIds: partial.map(p => p.id), status: "checking" };
        try {
          const planner = path.join(ROOT, "scripts/planner.js");
          const child = spawn(process.execPath, [planner, "--case", caseId, "--agent", agent,
            "--need-dedupe", need.id], { cwd: ROOT, detached: true, stdio: "ignore",
            env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
          child.unref();
        } catch (e) {}
      }
      if (!needs.has(caseId)) needs.set(caseId, []);
      needs.get(caseId).push(need);
      if (need.blocking && need.planId) {
        const p = (plans.get(caseId) || []).find(x => x.id === need.planId);
        if (p) {
          p.blockedOnNeed = p.blockedOnNeed || [];
          if (p.blockedOnNeed.indexOf(need.id) < 0) p.blockedOnNeed.push(need.id);
          emit("plan.blocked", agent, { case: caseId, planId: p.id, needId: need.id, stepId: need.stepId });
        }
      }
      emit("need.requested", agent, { case: caseId, agent, needId: need.id, kind,
        title: need.title, blocking: need.blocking, planId: need.planId, stepId: need.stepId,
        spec: need.spec, indicatorIds: need.indicatorIds });
      const jobs = b.autoCollect === false ? [] : autoEnqueueNeed(caseId, need);
      return json(res, 200, { need, jobs });
    }
    if (p === "/api/intakes" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { intakes: intakes.get(caseId) || [] });
    }
    if (p === "/api/intake/decision" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const it = (intakes.get(caseId) || []).find(x => x.id === b.id);
      if (!it) return json(res, 404, { error: "no such intake" });
      const decision = String(b.decision || "");
      if (b.dryRun === true) return json(res, 200, { intake: it, file: findIntakeFile(caseId, it) });
      if (decision === "continue") {
        it.status = "needs_source"; it.updatedAt = new Date().toISOString();
        emit("intake.updated", b.by || "you", { case: caseId, intakeId: it.id, agent: it.agent,
          needId: it.needId, index: it.index, status: "needs_source", note: "用户不接受当前口径，继续找来源" });
        return json(res, 200, { intake: it, reply: "已保留待补项，请继续提供官方月均/可用 URL 或文件。" });
      }
      if (decision === "later") {
        it.updatedAt = new Date().toISOString();
        emit("intake.updated", b.by || "you", { case: caseId, intakeId: it.id, agent: it.agent,
          needId: it.needId, index: it.index, status: it.status, note: "用户暂不处理" });
        return json(res, 200, { intake: it });
      }
      if (decision !== "accept") return json(res, 400, { error: "decision must be accept|continue|later" });
      if (!it.needId || it.index === null || it.index === undefined) return json(res, 400, { error: "intake 未绑定 need item" });
      const n = (needs.get(caseId) || []).find(x => x.id === it.needId);
      const item = n && n.spec && n.spec.items ? n.spec.items[it.index] : null;
      if (!item) return json(res, 404, { error: "need item not found" });
      const file = String(b.file || findIntakeFile(caseId, it) || "");
      if (!file) return json(res, 400, { error: "未找到解析产物文件", hint: "数据 agent 没有记录输出文件；请让它把 CSV 路径写入 /api/intake/update 的 file 字段" });
      item.status = "provided"; item.value = "文件：" + file; item.source = it.url || "数据补充 " + it.id;
      item.file = file; item.note = "用户确认口径后入库（" + it.id + "）"; item.providedAt = new Date().toISOString();
      item.providedBy = b.by || "you";
      const complete = markNeedProgress(caseId, n);
      if (!complete) emit("need.item.provided", b.by || "you", { case: caseId, needId: n.id,
        agent: n.agent, index: it.index, indicator: item.indicator, value: item.value,
        source: item.source, done: n.providedCount, total: n.totalCount });
      it.status = "provided"; it.updatedAt = new Date().toISOString();
      emit("intake.updated", b.by || "you", { case: caseId, intakeId: it.id, agent: it.agent,
        needId: it.needId, index: it.index, status: "provided", note: "用户接受口径并入库" });
      return json(res, 200, { intake: it, item, complete: !!complete });
    }
    if (p === "/api/intake/run" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const it = (intakes.get(caseId) || []).find(x => x.id === b.id);
      if (!it) return json(res, 404, { error: "no such intake" });
      if (b.needId !== undefined) it.needId = String(b.needId || "");
      if (b.index !== undefined) it.index = b.index === null ? null : Number(b.index);
      it.status = "queued"; it.updatedAt = new Date().toISOString();
      emit("intake.updated", b.by || "you", { case: caseId, intakeId: it.id, agent: it.agent,
        needId: it.needId, index: it.index, status: "queued" });
      spawnIntakeWorker(it);
      return json(res, 200, { intake: it });
    }
    if (p === "/api/intake/update" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const it = (intakes.get(caseId) || []).find(x => x.id === b.id);
      if (!it) return json(res, 404, { error: "no such intake" });
      if (b.status) it.status = String(b.status).slice(0, 30);
      if (b.file) it.file = String(b.file).slice(0, 500);
      if (b.needId !== undefined) it.needId = String(b.needId || "");
      if (b.index !== undefined) it.index = b.index === null ? null : Number(b.index);
      if (b.found || b.coverage !== undefined || b.missing || b.requirement) {
        const at = { at: new Date().toISOString(), by: b.by || "you", url: it.url,
          found: String(b.found || "").slice(0, 2000), coverage: Number(b.coverage || 0),
          requirement: String(b.requirement || "").slice(0, 2000), missing: String(b.missing || "").slice(0, 2000),
          note: String(b.note || "").slice(0, 500), file: String(b.file || "").slice(0, 500) };
        it.attempts.push(at); if (it.attempts.length > 20) it.attempts = it.attempts.slice(-20);
        it.lastAttempt = at;
        if (it.needId && it.index !== null && it.index !== undefined) {
          const n = (needs.get(caseId) || []).find(x => x.id === it.needId);
          const item = n && n.spec && n.spec.items ? n.spec.items[it.index] : null;
          if (item && item.status !== "provided") {
            item.lastIntake = { intakeId: it.id, at: at.at, url: it.url,
              status: it.status, found: at.found, coverage: at.coverage, missing: at.missing };
            emit("need.item.attempt", b.by || "you", { case: caseId, needId: it.needId,
              index: it.index, indicator: item.indicator, attempt: at });
          }
        }
      }
      it.updatedAt = new Date().toISOString();
      emit("intake.updated", b.by || "you", { case: caseId, intakeId: it.id, agent: it.agent,
        needId: it.needId, index: it.index, status: it.status, found: it.lastAttempt && it.lastAttempt.found,
        coverage: it.lastAttempt && it.lastAttempt.coverage, missing: it.lastAttempt && it.lastAttempt.missing });
      return json(res, 200, { intake: it });
    }
    async function scopeStepsFor(caseId, agent, text) {
      try {
        const planArgs = [path.join(ROOT, "scripts/planner.js"), "--case", caseId, "--agent", agent,
          "--intent", String(text || ""), "--emit-plan"];
        if (((CONFIG.planning || {}).modelPlan) !== false) planArgs.push("--model-plan", "--use-model");
        const r = await runNode(planArgs, process.env, 240000);
        let j = null; try { j = JSON.parse(String(r.out || "").trim()); } catch (e) {}
        return (j && Array.isArray(j.steps)) ? { steps: j.steps, by: j.by || "scope" } : { steps: [], by: "scope" };
      } catch (e) { return { steps: [], by: "scope" }; }
    }
    if (p === "/api/need/match" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const text = String(u.searchParams.get("text") || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const norm = x => String(x || "").toLowerCase().replace(/[\s，。；、：:,.()（）【】\[\]]/g, "");
      const bigrams = s => { const t = norm(s), set = new Set(); for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2)); return set; };
      const sim = (a, b) => {
        const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0;
        let n = 0; A.forEach(x => { if (B.has(x)) n += 1; }); return n / (A.size + B.size - n);
      };
      const candidates = [];
      (needs.get(caseId) || []).filter(n => n.status === "pending" || n.status === "partial").forEach(n => {
        const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
        items.forEach((it, index) => {
          if (!it || it.status === "provided") return;
          const hay = [it.indicator, n.title, n.detail, it.note].join(" ");
          const score = sim(text, hay);
          candidates.push({ needId: n.id, index, indicator: it.indicator || "", title: n.title || "",
            score: Math.round(score * 100) / 100, confidence: score >= 0.55 ? "high" : (score >= 0.3 ? "medium" : "low") });
        });
      });
      candidates.sort((a, b) => b.score - a.score);
      return json(res, 200, { case: caseId, text, candidates: candidates.slice(0, 8),
        best: candidates[0] || null });
    }
    function writeUpstreamBrief(caseId, plan) {
      if (!plan) return null;
      const ws = (works.get(caseId) || []).filter(w => w.planId === plan.id && w.kind !== "child");
      if (!ws.length || !ws.every(w => w.state === "done")) return null;
      const base = vaultPath(caseId, "research");
      fs.mkdirSync(base, { recursive: true });
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(base, plan.agent + ".json"), "utf8")); } catch (e) {}
      const lines = ["# 上游已完成结论 · " + plan.agent, "",
        "- 计划：" + plan.id + " · 版本：" + (plan.version || 1), ""];
      if (j) {
        if (j.stance) lines.push("- 判断：" + String(j.stance).slice(0, 500), "");
        if (j.summary) lines.push("- 摘要：" + String(j.summary).slice(0, 800), "");
        const claims = Array.isArray(j.claims) ? j.claims.slice(0, 12) : [];
        if (claims.length) { lines.push("## 关键结论"); claims.forEach(c => lines.push("- " + String(c.text || "").slice(0, 300) + (c.source ? " [" + c.source + "]" : ""))); }
        if (j.target_range) lines.push("", "- 目标区间：" + JSON.stringify(j.target_range));
        if (j.rating) lines.push("- 评级：" + j.rating);
      }
      lines.push("", "> 上游结论用于下游对齐；不得直接复制其引用，需自行核验。", "");
      fs.writeFileSync(path.join(base, "upstream-" + plan.agent + ".md"), lines.join(String.fromCharCode(10)));
      emit("case.upstream", "system", { case: caseId, agent: plan.agent, planId: plan.id });
      return path.relative(ROOT, path.join(base, "upstream-" + plan.agent + ".md"));
    }
    async function writeCaseBrief(caseId, goal, out) {
      const base = vaultPath(caseId, "research");
      fs.mkdirSync(base, { recursive: true });
      const brief = {
        version: 1, case: caseId, goal: String(goal || "").slice(0, 300),
        question: String(goal || "").slice(0, 300),
        createdAt: new Date().toISOString(),
        roles: out.map(x => ({ agent: x.agent, planId: x.planId,
          modules: (x.modules || []).slice(0, 12), task: x.task || "" })),
        rules: {
          evidence: "正文数字必须带 [S#]，且 S# 必须存在于 evidence/sources.jsonl",
          consistency: "同一指标跨角色必须同口径、同时间窗；不一致必须写冲突而不是各写一套",
          scope: "只写本角色边界；个股目标价/评级归 stock，宏观不给个股估值",
          output: "结论必须给出假设、证据、反证条件；缺数据用 need，不编造"
        }
      };
      fs.writeFileSync(path.join(base, "case-brief.json"), JSON.stringify(brief, null, 2));
      const nl = String.fromCharCode(10);
      fs.writeFileSync(path.join(base, "case-brief.md"),
        ["# Case Brief", "", "- 研究问题：" + brief.question, "- 角色："]
          .concat(brief.roles.map(r => "- " + r.agent + "：" + r.task)).join(nl) + nl);
      emit("case.brief", "system", { case: caseId, roles: brief.roles.map(r => r.agent), goal: brief.goal });
      return brief;
    }
    // 新 case / 并行派活时，如果 mission 仍是“待定/待补充”，用自然语言目标回写，避免员工反复报 mission 缺口。
    function applyMissionIntent(caseId, goal, force) {
      const rel = "mission.md";
      const abs = vaultPath(caseId, rel);
      let txt = "";
      try { txt = fs.readFileSync(abs, "utf8"); } catch (e) { return null; }
      const targetPending = !!force || /^- 标的:\s*(待定|$)/m.test(txt) || /待定（创建后/.test(txt);
      const taskPending = !!force || /^- 任务:\s*(待补充|$)/m.test(txt) || /待补充（创建后/.test(txt);
      if (!targetPending && !taskPending) return null;
      const intent = caseIntent.parse(goal);
      let next = txt;
      if (targetPending && intent.ticker) next = next.replace(/^- 标的:.*$/m, "- 标的: " + intent.ticker);
      if (targetPending && intent.kind) next = next.replace(/^- 标的类型:.*$/m, "- 标的类型: " + intent.kind);
      if (taskPending) next = next.replace(/^- 任务:.*$/m, "- 任务: " + String(goal || "").slice(0, 500));
      if (next === txt) return null;
      const f = fileOf(caseId, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, next, "utf8");
      f.version += 1; f.sha = sha256(next); f.writes += 1;
      try {
        const hpath = path.join(HISTORY, caseId, rel.replace(/\//g, "__") + ".v" + f.version + "." + f.sha.slice(0, 8));
        fs.mkdirSync(path.dirname(hpath), { recursive: true });
        fs.writeFileSync(hpath, next, "utf8");
      } catch (e) {}
      emit("case.mission.updated", "system", { case: caseId, ticker: intent.ticker || "",
        kind: intent.kind || "", version: f.version, goal: String(goal || "").slice(0, 300) });
      // mission 已补齐后，旧的“mission 待定”need 自动作废，避免员工反复上报。
      const missionFilled = (!targetPending || !!intent.ticker) && (!taskPending || !!String(goal || "").trim());
      if (missionFilled) (needs.get(caseId) || []).forEach(n => {
        if (n.status !== "pending") return;
        const hay = String(n.title || "") + " " + String(n.detail || "");
        if (/mission/i.test(hay) && /待定|待补充/.test(hay)) {
          n.status = "superseded"; n.supersededBy = "mission.updated";
          n.answer = "mission.md 已由并行目标回写，缺口自动作废";
          emit("need.superseded", "system", { case: caseId, needId: n.id, canonicalId: "mission.updated",
            agent: n.agent, reason: "mission updated" });
        }
      });
      return { ticker: intent.ticker || "", kind: intent.kind || "", version: f.version };
    }
    if (p === "/api/fanout" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const rawTasks = Array.isArray(b.tasks) ? b.tasks : [];
      // 任务计划只给主研究员工；服务角色（audit/legal/trader）不生成并行任务计划。
      const allowedAgents = ["macro", "industry", "stock"];
      const seenAgents = new Set();
      const tasks = rawTasks.filter(t => t && t.agent && String(t.task || "").trim())
        .filter(t => {
          const a = String(t.agent).slice(0, 20);
          if (allowedAgents.indexOf(a) < 0 || seenAgents.has(a)) return false;
          seenAgents.add(a); return true;
        }).slice(0, 3);
      if (!tasks.length) return json(res, 400, { error: "tasks required（仅支持 macro / industry / stock）" });
      if (!plans.has(caseId)) plans.set(caseId, []);
      const goalText = String(b.goal || tasks[0].task || "").trim().replace(/\s+/g, " ").slice(0, 300);
      // mission 仍是待定/待补充时，用本次并行目标回写，避免 macro/industry 反复报 mission 缺口。
      try { applyMissionIntent(caseId, goalText); } catch (e) {}
      const lockKey = caseId + "|" + goalText;
      if (fanoutInFlight.has(lockKey) && !b.forceNew) return json(res, 200, { ok: true, pending: true, reused: true,
        goal: goalText, hint: "同一目标的并行派活正在生成，请稍候" });
      fanoutInFlight.set(lockKey, Date.now());
      const fanoutLockTimer = setTimeout(() => fanoutInFlight.delete(lockKey), 180000);
      if (fanoutLockTimer.unref) fanoutLockTimer.unref();
      // 同 case、同目标、仍有未完成计划的并行组直接复用，避免重复派活/重复消耗。
      const prior = Array.from(fanoutGroups.values()).find(g => {
        const gg = String(g.goal || "").trim().replace(/\s+/g, " ");
        if (g.case !== caseId || gg !== goalText) return false;
        return (g.tasks || []).some(t => {
          const p0 = (plans.get(caseId) || []).find(x => x.id === t.planId);
          return p0 && (p0.status === "planning" || p0.status === "pending" || p0.status === "approved" || p0.status === "running");
        });
      });
      if (prior && !b.forceNew) { fanoutInFlight.delete(lockKey); return json(res, 200, { ok: true, groupId: prior.id, tasks: prior.tasks, reused: true }); }
      const groupId = "FAN" + Date.now().toString(36);
      const out = [];
      for (let idx = 0; idx < tasks.length; idx++) {
        const t = tasks[idx];
        const agent = String(t.agent).slice(0, 20);
        const plan = { id: nextPlanId(), case: caseId, agent,
          goal: String(b.goal || t.task || "并行派活").slice(0, 300), steps: [], planner: null,
          version: 1, history: [], status: "planning", planning: true, blockedOnNeed: [],
          createdAt: new Date().toISOString(), approvedAt: null, approvedBy: "", note: "" };
        plans.get(caseId).push(plan);
        // 先落 plan.created 再异步生成步骤：保证“创建”事件永远早于“审批”事件，重启回放不会丢审批。
        emit("plan.created", agent, { case: caseId, planId: plan.id, agent, goal: plan.goal,
          steps: [], stepCount: 0, status: "planning", planning: true,
          planner: { by: "scope", fanout: groupId }, version: plan.version, fanout: groupId });
        const generated = await scopeStepsFor(caseId, agent, t.task);
        const rawSteps = (generated && generated.steps && generated.steps.length ? generated.steps :
          [{ id: "S0", name: "并行研究", task: t.task, outputs: [] }]).slice(0, 7);
        const idMap = {};
        rawSteps.forEach((st, i) => {
          const oldId = String(st.id || ("S" + i));
          idMap[oldId] = "F" + (idx + 1) + "_" + (i + 1);
        });
        plan.steps = rawSteps.map((st, i) => ({
          id: idMap[String(st.id || ("S" + i))],
          name: String(st.name || ("任务" + (i + 1))).slice(0, 40),
          tier: ["fast", "strong", "verify"].indexOf(st.tier) >= 0 ? st.tier : "strong",
          task: String(st.task || t.task || "").slice(0, 500),
          outputs: Array.isArray(st.outputs) ? st.outputs.slice(0, 5) : [],
          depends: (Array.isArray(st.depends) ? st.depends : []).map(d => idMap[String(d)]).filter(Boolean),
          dependsExplicit: true, agent, failurePolicy: "degradable", parentId: "", branchId: "",
          merge_from: [], modelChain: [], fanoutId: groupId
        }));
        if (plan.steps[0]) plan.steps[0].depends = [];
        plan.planning = false;
        // 用户点击“开始并行”本身就是批准动作；默认直接 approved 并启动，不再二次审批。
        const autoApprove = b.requireApproval !== true;
        if (autoApprove) {
          plan.status = "approved"; plan.approvedAt = new Date().toISOString(); plan.approvedBy = b.by || "you";
        } else if (plan.status === "planning") plan.status = "pending";
        plan.planner = { by: (generated && generated.by) || "scope", fanout: groupId };
        emit("plan.ready", agent, { case: caseId, planId: plan.id, agent, steps: plan.steps,
          stepCount: plan.steps.length, status: plan.status, planner: plan.planner, version: plan.version, fanout: groupId });
        if (autoApprove) emit("plan.approved", b.by || "you", { case: caseId, planId: plan.id, agent,
          note: "fanout auto-approve" });
        emit("plan.revised", agent, { case: caseId, planId: plan.id, agent, version: plan.version,
          added: plan.steps.map(x => ({ id: x.id, name: x.name, branchId: "", parentId: "", fanoutId: groupId })),
          removed: [], updated: [], steps: plan.steps.length, stepsData: plan.steps, skipped: 0, branch: null, fanout: groupId });
        out.push({ agent, planId: plan.id, task: String(t.task || "").slice(0, 300),
          modules: plan.steps.map(x => x.name).slice(0, 12),
          stepId: plan.steps[0] && plan.steps[0].id,
          stepIds: plan.steps.map(x => x.id), run: null });
      }
      // 三个主研究员工并行启动；个股的估值/结论类节点等 macro/industry 完成后再收口。
      const byAgent = {};
      out.forEach(x => { byAgent[x.agent] = x.planId; });
      const depPlans = [byAgent.macro, byAgent.industry].filter(Boolean);
      const stockTask = out.filter(x => x.agent === "stock")[0];
      if (stockTask && depPlans.length) {
        const sp = (plans.get(caseId) || []).find(x => x.id === stockTask.planId);
        if (sp) {
          let marked = 0;
          (sp.steps || []).forEach(st => {
            // 只按节点名判断收口节点，避免任务描述里提到“风险/估值”导致预研节点也被卡住。
            const name = String(st.name || "");
            if (/(估值|评级|目标价|投资建议|结论|定稿|交付|交叉校验|交叉核验|合规审计|盈利预测|估值模型|投资逻辑|可视化|催化剂|反向论证|风险)/.test(name)) {
              st.waitForPlans = depPlans.slice(); marked += 1;
            }
          });
          // 最后一个节点一定是收口节点：即使名字没命中关键词，也要等上游。
          if (sp.steps && sp.steps.length) {
            const last = sp.steps[sp.steps.length - 1];
            if (!(last.waitForPlans || []).length) { last.waitForPlans = depPlans.slice(); marked += 1; }
          }
          if (!marked && sp.steps && sp.steps.length) sp.steps[sp.steps.length - 1].waitForPlans = depPlans.slice();
          emit("plan.dependencies", "system", { case: caseId, planId: sp.id, agent: "stock",
            waitForPlans: depPlans, note: "stock 预研并行，估值/结论等上游完成" });
        }
      }
      await writeCaseBrief(caseId, b.goal || tasks[0].task, out);
      try { enqueueAsyncJob(caseId, "case_brief_model", {}, "system"); } catch (e) {}
      if (!b.dryRun) out.forEach(x => { x.run = autoRunPlan(caseId, x.planId, "fanout"); });
      fanoutGroups.set(caseId + "|" + groupId, { id: groupId, case: caseId,
        goal: String(b.goal || "").slice(0, 300), tasks: out, createdAt: new Date().toISOString() });
      fanoutInFlight.set(lockKey, groupId);
      emit("fanout.started", b.by || "you", { case: caseId, groupId, goal: String(b.goal || "").slice(0, 300), tasks: out });
      return json(res, 200, { ok: true, groupId, tasks: out });
    }
    if (p === "/api/fanout/approve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const g = Array.from(fanoutGroups.values()).find(x => x.case === caseId && x.id === b.groupId);
      if (!g) return json(res, 404, { error: "no such group" });
      const ids = (g.tasks || []).map(t => t.planId).filter(Boolean);
      const list = plans.get(caseId) || [];
      const stillPlanning = ids.filter(id => { const pl = list.find(x => x.id === id); return pl && (pl.planning || pl.status === "planning"); });
      if (stillPlanning.length) return json(res, 409, { error: "组内计划还在生成，请稍后再批", planning: stillPlanning });
      let approved = 0;
      const newly = [];
      ids.forEach(id => { const pl = list.find(x => x.id === id); if (pl && pl.status === "pending") {
        pl.status = "approved"; pl.approvedAt = new Date().toISOString(); pl.approvedBy = b.by || "you";
        approved += 1; newly.push(id);
        emit("plan.approved", b.by || "you", { case: caseId, planId: pl.id, agent: pl.agent, note: "fanout approve" });
      } });
      const runs = [];
      newly.forEach(id => { const r = autoRunPlan(caseId, id, "fanout-approve"); if (r) runs.push({ planId: id, run: r }); });
      return json(res, 200, { ok: true, groupId: g.id, approved, runs });
    }
    if (p === "/api/plan/rollback" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.planId) ||
        (plans.get(caseId) || []).filter(x => x.agent === b.agent).pop();
      if (!plan) return json(res, 404, { error: "no such plan" });
      const list = works.get(caseId) || [];
      const running = list.filter(w => w.planId === plan.id && (w.state === "running" || w.state === "cancelling"));
      if (running.length) return json(res, 409, { error: "还有运行中的任务，先取消或等待结束", running: running.map(x => x.nodeId) });
      const history = plan.history || [];
      const target = b.toVersion != null ? history.find(h => h.version === Number(b.toVersion)) : history[history.length - 1];
      if (!target) return json(res, 409, { error: "没有可回滚的版本" });
      const current = JSON.parse(JSON.stringify(plan.steps || []));
      const beforeVersion = plan.version || 1;
      plan.version = beforeVersion + 1;
      plan.history = history.slice(-12).concat([{ version: beforeVersion, at: new Date().toISOString(),
        by: b.by || "you", reason: "before rollback", steps: current }]);
      plan.steps = JSON.parse(JSON.stringify(target.steps || []));
      // 清掉未完成 WorkItem；done 保留，runner 会补建新节点
      const keep = []; const dropped = [];
      list.forEach(w => {
        if (w.planId === plan.id && w.state !== "done") { dropped.push(w.nodeId); return; }
        keep.push(w);
      });
      works.set(caseId, keep);
      dropped.forEach(nodeId => emit("work.cancelled", b.by || "you", { case: caseId, workId: "", planId: plan.id,
        agent: plan.agent, nodeId, cancelled: true, reason: "plan rollback" }));
      emit("plan.rolledback", plan.agent || b.by || "you", { case: caseId, planId: plan.id, agent: plan.agent,
        version: plan.version, toVersion: target.version, steps: plan.steps.length, stepsData: plan.steps, cancelled: dropped });
      const auto = autoRunPlan(caseId, plan.id, "rollback");
      return json(res, 200, { plan, rolledBackTo: target.version, cancelled: dropped, auto });
    }
    if (p === "/api/plans" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { plans: plans.get(caseId) || [] });
    }

    if (p === "/api/work/stats" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const list = works.get(caseId) || [];
      const byState = {};
      list.forEach(x => { byState[x.state] = (byState[x.state] || 0) + 1; });
      const done = list.filter(x => x.state === "done" && x.startedAt && x.finishedAt);
      const dur = done.map(x => Date.parse(x.finishedAt) - Date.parse(x.startedAt)).filter(n => n > 0);
      const byAgent = {};
      list.forEach(x => {
        const a = byAgent[x.agent] = byAgent[x.agent] || { total: 0, done: 0, failed: 0, retries: 0, ms: 0 };
        a.total += 1;
        if (x.state === "done") a.done += 1;
        if (x.state === "failed") a.failed += 1;
        if (x.attempt > 1) a.retries += 1;
        if (x.startedAt && x.finishedAt) a.ms += Math.max(0, Date.parse(x.finishedAt) - Date.parse(x.startedAt));
      });
      return json(res, 200, { case: caseId, total: list.length, byState, byAgent,
        avgMs: dur.length ? Math.round(dur.reduce((s, n) => s + n, 0) / dur.length) : 0,
        retries: list.filter(x => x.attempt > 1).length,
        paused: pausedCases.has(caseId),
        tokens: caseTokens.get(caseId) || 0, budgets: BUDGETS });
    }
    if (p === "/api/work/pause" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const paused = b.paused !== false;
      if (paused) {
        pausedCases.add(caseId);
        const list = works.get(caseId) || [];
        let marked = 0;
        list.forEach(w => {
          if (w.state === "running" || w.state === "cancelling") {
            w.cancelRequested = true;
            w.pauseRequested = true;
            marked += 1;
            emit("work.pause.requested", b.by || "you", { case: caseId, workId: w.id,
              planId: w.planId, agent: w.agent, nodeId: w.nodeId });
          }
        });
        // 暂停不仅停止派发，也终止当前 run-dag，避免离线期间模型调用继续失败/烧 token。
        Array.from(autoRuns.entries()).forEach(([key, pid]) => {
          if (key.indexOf(caseId + "|") !== 0) return;
          try { process.kill(-pid, "SIGTERM"); } catch (e) { try { process.kill(pid, "SIGTERM"); } catch (x) {} }
          autoRuns.delete(key);
        });
        emit("work.paused", b.by || "you", { case: caseId, paused: true, running: marked });
        return json(res, 200, { case: caseId, paused: true, running: marked });
      }
      pausedCases.delete(caseId);
      const list = works.get(caseId) || [];
      let resumed = 0;
      list.forEach(w => {
        if (!w.pauseRequested) return;
        w.pauseRequested = false;
        w.cancelRequested = false;
        releaseWorkBudget(w, "work.resume");
        w.state = "queued";
        w.owner = ""; w.leaseId = ""; w.leaseUntil = 0; w.retryAfter = 0;
        w.heartbeatAt = null; w.error = ""; w.finishedAt = null; w.attempt = 0;
        resumed += 1;
        emit("work.resumed", b.by || "you", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId });
      });
      const plans2 = (plans.get(caseId) || []).filter(p => p.status === "approved");
      plans2.forEach(p => { try { spawnRecoveryRunner(caseId, p.id, "resume"); } catch (e) {} });
      emit("work.resumed", b.by || "you", { case: caseId, paused: false, requeued: resumed });
      return json(res, 200, { case: caseId, paused: false, requeued: resumed });
    }
    if (p === "/api/work/contract" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state === "running" || w.state === "cancelling") return json(res, 409, { error: "still running" });
      if (Array.isArray(b.outputs)) {
        const outs = b.outputs.map(String).slice(0, 10);
        const bad = outs.filter(o => !validOutputSpec(o));
        if (bad.length) return json(res, 400, { error: "invalid_outputs", invalid: bad });
        w.outputs = outs;
      }
      if (b.task !== undefined) w.task = String(b.task || "").slice(0, 4000);
      if (b.maxWallMs) w.maxWallMs = Math.max(60000, Math.round(Number(b.maxWallMs) || 0));
      if (b.maxTokens) w.maxTokens = Math.max(0, Math.round(Number(b.maxTokens) || 0));
      emit("work.contract.updated", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
        agent: w.agent, nodeId: w.nodeId, outputs: w.outputs, maxWallMs: w.maxWallMs, maxTokens: w.maxTokens });
      return json(res, 200, { item: w });
    }
    if (p === "/api/work/split" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = works.get(caseId) || [];
      const parent = list.find(x => x.id === b.id);
      if (!parent) return json(res, 404, { error: "work not found" });
      if (parent.state === "running" || parent.state === "cancelling") return json(res, 409, { error: "still running" });
      const plan = (plans.get(caseId) || []).find(x => x.id === parent.planId);
      if (!plan) return json(res, 404, { error: "plan not found" });
      const step = (plan.steps || []).find(x => x.id === parent.nodeId);
      if (!step) return json(res, 404, { error: "plan step not found" });
      const kids = Array.isArray(b.children) && b.children.length ? b.children : splitSuggestion(parent);
      if (kids.length < 2 || kids.length > 5) return json(res, 400, { error: "拆分需要 2-5 个子节点" });
      const ids = [];
      const childSteps = kids.map((k, i) => {
        const id = String(parent.nodeId + "_" + (i + 1)).slice(0, 30);
        ids.push(id);
        return { id, name: String(k.name || (step.name + " · 子任务" + (i + 1))).slice(0, 80),
          task: String(k.task || step.task || "").slice(0, 4000),
          outputs: Array.isArray(k.outputs) ? k.outputs.slice(0, 8) : [], depends: (step.depends || []).slice(),
          agent: step.agent || parent.agent, tier: step.tier || parent.tier || "strong",
          failurePolicy: step.failurePolicy || "required", parentId: parent.nodeId, branchId: id,
          merge_from: [], modelChain: [] };
      });
      plan.steps = (plan.steps || []).filter(x => x.id !== parent.nodeId);
      plan.steps.push(...childSteps);
      plan.steps.forEach(s => { if (Array.isArray(s.depends) && s.depends.indexOf(parent.nodeId) >= 0) {
        s.depends = s.depends.filter(d => d !== parent.nodeId).concat(ids);
      } });
      const oldVer = plan.version || 1;
      plan.version = oldVer + 1;
      plan.history = (plan.history || []).slice(-12).concat([{ version: oldVer, at: new Date().toISOString(),
        by: b.by || "you", reason: "split " + parent.nodeId, steps: JSON.parse(JSON.stringify(plan.steps || [])) }]);
      plan.status = "pending"; plan.approvedAt = null; plan.approvedBy = "";
      parent.state = "cancelled"; parent.finishedAt = new Date().toISOString();
      parent.error = "split into " + ids.join(", "); parent.cancelRequested = true;
      emit("work.split", b.by || "you", { case: caseId, workId: parent.id, planId: plan.id,
        parentNodeId: parent.nodeId, children: ids, planVersion: plan.version });
      emit("plan.approval_revoked", b.by || "you", { case: caseId, planId: plan.id, agent: plan.agent,
        reason: "节点拆分需重新审批", version: plan.version, steps: plan.steps.length });
      return json(res, 200, { ok: true, planId: plan.id, children: ids, needsApproval: true,
        planVersion: plan.version, steps: plan.steps.length });
    }
    if (p === "/api/work/recover" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state === "running" || w.state === "cancelling") return json(res, 409, { error: "still running" });
      const rec = w.recovery || recoveryForWork(w);
      const action = String(b.action || rec.action || "");
      if (action === "retry") {
        w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0; w.retryAfter = 0;
        w.heartbeatAt = null; w.error = ""; w.finishedAt = null; w.cancelRequested = false;
        w.partial = false; w.failureKind = ""; w.recovery = null; w.needsReview = false;
        w.attempt = 0; w.retryCount = (w.retryCount || 0) + 1;
        emit("work.recovered", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
          action: "retry", attempt: w.attempt });
        try { autoRunPlan(w.case, w.planId, "recover"); } catch (e) {}
        return json(res, 200, { ok: true, action: "retry", item: w });
      }
      if (action === "split") {
        return json(res, 200, { ok: true, action: "split", hint: rec.hint,
          suggestion: splitSuggestion(w), outputs: w.outputs || [] });
      }
      if (action === "contract_fix") {
        return json(res, 200, { ok: true, action: "contract_fix", hint: rec.hint,
          outputs: w.outputs || [], error: w.error || "" });
      }
      return json(res, 200, { ok: true, action: action || "escalate", hint: rec.hint,
        outputs: w.outputs || [], error: w.error || "" });
    }
    if (p === "/api/work/retry" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state === "running" || w.state === "cancelling") return json(res, 409, { error: "still running" });
      if (w.state === "queued") return json(res, 200, { item: w, already: true });
      if (b.expectedState && w.state !== b.expectedState)
        return json(res, 409, { error: "state mismatch", state: w.state, expected: b.expectedState });
      if (w.state === "done" && b.allowDone !== true)
        return json(res, 409, { error: "done work requires allowDone" });
      releaseWorkBudget(w, "work.retry");
      w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0; w.retryAfter = 0;
      w.heartbeatAt = null; w.error = ""; w.finishedAt = null;
      w.cancelRequested = false; w.progressStalled = false; w.progressAlertedAt = 0;
      w.partial = false; w.failureKind = "";
      w.loopId = ""; w.gate = null; w.needsReview = false; w.reviewReason = "";
      w.attempt = 0; // 人工重试视为新一轮，避免历史 attempt 直接压到 maxAttempts
      w.retryCount = (w.retryCount || 0) + 1;
      emit("work.retried", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
        agent: w.agent, nodeId: w.nodeId, traceId: w.traceId, retryCount: w.retryCount,
        requestId: b.requestId || "" });
      return json(res, 200, { item: w, already: false, retryCount: w.retryCount });
    }
    if (p === "/api/work/cancel" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state === "done" || w.state === "failed" || w.state === "cancelled")
        return json(res, 200, { item: w, already: true });
      releaseWorkBudget(w, "work.cancel");
      w.cancelRequested = true;
      if (w.state === "queued") {
        w.state = "cancelled"; w.finishedAt = new Date().toISOString(); w.error = String(b.reason || "cancelled");
        (works.get(w.case) || []).filter(x => x.kind === "child" && x.parentWorkId === w.id &&
          x.state !== "done" && x.state !== "failed" && x.state !== "cancelled").forEach(x => {
          x.state = "cancelled"; x.finishedAt = new Date().toISOString(); x.error = "parent cancelled";
        });
        emit("work.cancelled", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, ok: false, cancelled: true, reason: w.error, traceId: w.traceId });
      } else {
        w.state = "cancelling";
        emit("work.cancel.requested", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, reason: String(b.reason || ""), traceId: w.traceId });
      }
      return json(res, 200, { item: w });
    }
    if (p === "/api/work/accept" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (!w.needsReview) return json(res, 409, { error: "not needs review", state: w.state });
      w.state = "done"; w.partial = false; w.needsReview = false; w.error = "";
      w.finishedAt = new Date().toISOString(); w.outputs = w.outputs || [];
      emit("work.accepted", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
        agent: w.agent, nodeId: w.nodeId, outputs: w.outputs });
      try { spawnRecoveryRunner(w.case, w.planId, "accepted"); } catch (e) {}
      return json(res, 200, { item: w });
    }
    if (p === "/api/workers" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      let reg = { router: { mode: "deterministic" }, workers: [] };
      try { reg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/workers.json"), "utf8")); } catch (e) {}
      const list = works.get(caseId) || [];
      const runningBy = {};
      list.filter(x => x.state === "running" || x.state === "cancelling")
        .forEach(x => { runningBy[x.agent] = (runningBy[x.agent] || 0) + 1; });
      return json(res, 200, { router: reg.router || {}, workers: (reg.workers || []).map(w => Object.assign({}, w, {
        running: runningBy[w.agent] || 0,
        free: Math.max(0, (w.maxSlots || 1) - (runningBy[w.agent] || 0))
      })) });
    }
    if (p === "/api/work/reassign" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state === "running" || w.state === "cancelling") return json(res, 409, { error: "still running" });
      w.agent = String(b.agent || w.agent);
      emit("work.reassigned", b.by || "you", { case: w.case, workId: w.id, planId: w.planId,
        agent: w.agent, nodeId: w.nodeId, traceId: w.traceId });
      return json(res, 200, { item: w });
    }
    /* --- WorkItem：调度器/Worker 协议（DAG 节点） --- */
    if (p === "/api/work" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { items: works.get(caseId) || [], config: SCHED,
        paused: pausedCases.has(caseId), watchdog: { maxAttempts: WATCHDOG.maxAttempts,
          workHeartbeatMs: WATCHDOG.workHeartbeatMs, requeueOnLease: WATCHDOG.requeueOnLease } });
    }
    if (p === "/api/work/item" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const id = u.searchParams.get("id") || "";
      const item = (works.get(caseId) || []).find(x => x.id === id);
      if (!item) return json(res, 404, { error: "work not found" });
      return json(res, 200, { item });
    }
    if (p === "/api/work/create" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      if (!works.has(caseId)) works.set(caseId, []);
      const list = works.get(caseId);
      const nodeId = String(b.nodeId || "").slice(0, 40);
      if (!nodeId) return json(res, 400, { error: "nodeId required" });
      let item = list.find(x => x.planId === b.planId && x.nodeId === nodeId);
      if (item) {
        if (Array.isArray(b.waitForPlans)) item.waitForPlans = b.waitForPlans.map(String).slice(0, 5);
        if (b.maxTokens) item.maxTokens = Math.max(0, Math.round(Number(b.maxTokens) || 0));
        if (b.maxWallMs) item.maxWallMs = Math.max(60000, Math.round(Number(b.maxWallMs) || 0));
        return json(res, 200, { item, existing: true });
      }
      const outSpecs = Array.isArray(b.outputs) ? b.outputs.map(String).slice(0, 10) : [];
      const badOuts = outSpecs.filter(o => !validOutputSpec(o));
      if (badOuts.length) return json(res, 400, { error: "invalid_outputs: 输出必须是文件路径（含扩展名），不能只是说明文字",
        invalid: badOuts, hint: "例如 research/stock.md §核验记录 或 research/validation.json" });
      const itemId = (b.id || ("W" + (++workSeq)));
      const envMax = (b.envelope && b.envelope.budget && Number(b.envelope.budget.maxTokens)) || 0;
      const maxTokens = Math.max(0, Math.round(Number(b.maxTokens) || envMax || 0));
      const tier = b.tier || "strong";
      const estimate = taskEstimator.estimate({ name: b.name, task: b.task, outputs: b.outputs,
        depends: b.depends, tier, acceptance: b.envelope && b.envelope.acceptance });
      const envWall = (b.envelope && b.envelope.budget && Number(b.envelope.budget.maxWallMs)) || 0;
      const wallDefault = (SCHED.wallMsByTier || {})[tier] || 2700000;
      const maxWallMs = Math.max(60000, Math.round(Number(b.maxWallMs) || envWall || Math.max(wallDefault, estimate.wallMs)));
      item = { id: itemId, case: caseId, planId: b.planId || "", agent: b.agent || "",
        nodeId, name: b.name || nodeId, task: b.task || "", depends: Array.isArray(b.depends) ? b.depends : [],
        tier, failurePolicy: b.failurePolicy || "required", maxWallMs, estimate,
        state: "queued", owner: "", attempt: 0,
        outputs: Array.isArray(b.outputs) ? b.outputs : [], mergeFrom: Array.isArray(b.mergeFrom) ? b.mergeFrom : [],
        modelChain: Array.isArray(b.modelChain) ? b.modelChain : [],
        waitForPlans: Array.isArray(b.waitForPlans) ? b.waitForPlans.map(String).slice(0, 5) : [],
        envelope: (b.envelope && typeof b.envelope === "object") ? b.envelope : null,
        loopId: String(b.loopId || "").slice(0, 40),
        leaseId: "", leaseUntil: 0, retryAfter: 0, cancelRequested: false,
        traceId: b.traceId || (b.planId ? String(b.planId) : ("trace-" + Date.now().toString(36))),
        maxTokens, budgetReservation: "", budgetReserved: 0,
        tokens: 0, inputTokens: 0, outputTokens: 0,
        createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        heartbeatAt: null, error: "" };
      list.push(item);
      emit("work.created", b.by || "scheduler", { case: caseId, workId: itemId, planId: item.planId,
        agent: item.agent, nodeId, name: item.name, tier: item.tier, depends: item.depends,
        outputs: item.outputs, mergeFrom: item.mergeFrom, traceId: item.traceId,
        loopId: item.loopId, envelope: item.envelope, maxTokens: item.maxTokens, maxWallMs: item.maxWallMs,
        estimate: item.estimate, waitForPlans: item.waitForPlans || [] });
      return json(res, 200, { item });
    }
    if (p === "/api/work/branch" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = works.get(caseId) || [];
      const parent = list.find(x => x.id === b.parentWorkId);
      if (!parent) return json(res, 404, { error: "parent work not found" });
      const depth = (parent.depth || 0) + 1;
      if (depth > 2) return json(res, 409, { error: "子任务最多 2 层" });
      const children = list.filter(x => x.parentWorkId === parent.id);
      if (children.length >= 5) return json(res, 409, { error: "单个父任务最多 5 个子任务" });
      const usedTokens = children.reduce((n, x) => n + (x.tokens || 0), 0);
      if (BUDGETS.maxChildTokensPerParent > 0 && usedTokens >= BUDGETS.maxChildTokensPerParent) {
        return json(res, 409, { error: "子任务 token 预算已用尽", usedTokens,
          limit: BUDGETS.maxChildTokensPerParent });
      }
      const id = "C" + (++childSeq);
      const prompt = String(b.prompt || b.task || "").trim().slice(0, 8000);
      if (!prompt) return json(res, 400, { error: "prompt required" });
      const child = { id, case: caseId, planId: parent.planId, parentWorkId: parent.id,
        agent: b.agent || parent.agent, nodeId: String(b.branchId || ("CHILD-" + id)).slice(0, 40),
        name: String(b.name || "子任务 " + id).slice(0, 40), task: prompt, depends: [],
        tier: "strong", failurePolicy: b.failurePolicy || "degradable", state: "queued",
        kind: "child", depth, owner: "", attempt: 0, outputs: [], mergeFrom: [], modelChain: [],
        leaseId: "", leaseUntil: 0, retryAfter: 0, cancelRequested: false,
        traceId: parent.traceId || parent.planId, createdAt: new Date().toISOString(),
        startedAt: null, finishedAt: null, heartbeatAt: null, error: "" };
      list.push(child);
      emit("work.child.created", b.by || "worker", { case: caseId, workId: id, parentWorkId: parent.id,
        planId: child.planId, agent: child.agent, lane: child.agent, nodeId: child.nodeId, name: child.name, depth });
      const dir = path.join(ROOT, "runtime/child-runs"); fs.mkdirSync(dir, { recursive: true });
      const logPath = path.join(dir, id + "-" + Date.now() + ".log");
      const fd = fs.openSync(logPath, "a");
      const cp = spawn(process.execPath, [path.join(ROOT, "scripts/run-child.js"),
        "--case", caseId, "--id", id], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
        env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
      cp.unref(); try { fs.closeSync(fd); } catch (e) {}
      return json(res, 200, { child, log: path.relative(ROOT, logPath) });
    }
    if (p === "/api/work/children" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const pid = u.searchParams.get("parentWorkId") || "";
      return json(res, 200, { items: (works.get(caseId) || []).filter(x => x.kind === "child" && (!pid || x.parentWorkId === pid)) });
    }
    if (p === "/api/work/children/cancel" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = works.get(caseId) || [];
      const kids = list.filter(x => x.kind === "child" && x.parentWorkId === b.parentWorkId &&
        x.state !== "done" && x.state !== "failed" && x.state !== "cancelled");
      kids.forEach(w => { w.state = "cancelled"; w.error = b.reason || "parent cancelled";
        w.finishedAt = new Date().toISOString();
        emit("work.child.finished", b.by || "system", { case: caseId, workId: w.id, parentWorkId: w.parentWorkId,
          agent: w.agent, lane: w.agent, nodeId: w.nodeId, ok: false, cancelled: true, error: w.error }); });
      return json(res, 200, { cancelled: kids.map(x => x.id) });
    }
    if (p === "/api/work/child/start" && req.method === "POST") {
      const b = await readBody(req);
      const w = (works.get(b.case || "default") || []).find(x => x.id === b.id && x.kind === "child");
      if (!w) return json(res, 404, { error: "child not found" });
      w.state = "running"; w.startedAt = new Date().toISOString(); w.heartbeatAt = w.startedAt;
      emit("work.child.started", "child-runner", { case: w.case, workId: w.id, parentWorkId: w.parentWorkId,
        agent: w.agent, lane: w.agent, nodeId: w.nodeId });
      return json(res, 200, { item: w });
    }
    if (p === "/api/work/child/retry" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const w = (works.get(caseId) || []).find(x => x.id === b.id && x.kind === "child");
      if (!w) return json(res, 404, { error: "child not found" });
      if (w.state === "running" || w.state === "queued") return json(res, 200, { item: w, already: true });
      w.state = "queued"; w.error = ""; w.finishedAt = null; w.retryCount = (w.retryCount || 0) + 1;
      emit("work.child.retried", b.by || "you", { case: caseId, workId: w.id,
        parentWorkId: w.parentWorkId, nodeId: w.nodeId, retryCount: w.retryCount });
      const dir = path.join(ROOT, "runtime/child-runs"); fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(dir, w.id + "-" + Date.now() + ".log"), "a");
      const cp = spawn(process.execPath, [path.join(ROOT, "scripts/run-child.js"), "--case", caseId, "--id", w.id],
        { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
          env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
      cp.unref(); try { fs.closeSync(fd); } catch (e) {}
      return json(res, 200, { item: w, already: false });
    }
    if (p === "/api/work/child/finish" && req.method === "POST") {
      const b = await readBody(req);
      const w = (works.get(b.case || "default") || []).find(x => x.id === b.id && x.kind === "child");
      if (!w) return json(res, 404, { error: "child not found" });
      const ok = b.ok !== false;
      w.state = ok ? "done" : "failed"; w.partial = !!b.partial; w.error = String(b.error || "").slice(0, 800);
      w.finishedAt = new Date().toISOString();
      emit("work.child.finished", "child-runner", { case: w.case, workId: w.id, parentWorkId: w.parentWorkId,
        agent: w.agent, lane: w.agent, nodeId: w.nodeId, ok, partial: w.partial, error: w.error });
      return json(res, 200, { item: w });
    }
    if (p === "/api/work/claim" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = works.get(caseId) || [];
      // 恢复：同一个 loop 在 lease 过期后接管自己的 WorkItem；lease 仍有效时拒绝，避免双跑。
      if (b.id && b.resume) {
        const w = list.find(x => x.id === String(b.id));
        if (!w) return json(res, 404, { error: "work not found" });
        if (w.state === "queued") { /* 走正常 claim */ }
        else if (w.state === "running" && b.attach === true && b.owner && w.owner === b.owner &&
          b.leaseId && w.leaseId === b.leaseId) {
          // 调度器已 claim，Employee Loop 以同一 owner/lease 接管执行，不重复计 attempt。
          w.leaseUntil = Date.now() + (b.leaseMs || SCHED.leaseMs);
          w.heartbeatAt = new Date().toISOString();
          if (b.loopId) w.loopId = String(b.loopId).slice(0, 40);
          emit("work.attached", w.owner, { case: caseId, workId: w.id, planId: w.planId,
            agent: w.agent, nodeId: w.nodeId, owner: w.owner, leaseId: w.leaseId,
            leaseUntil: w.leaseUntil, loopId: w.loopId, traceId: w.traceId });
          return json(res, 200, { item: w, attached: true });
        }
        else if (w.state === "running" && (!w.leaseUntil || Date.now() >= w.leaseUntil)) {
          w.owner = b.owner || w.owner || "worker";
          w.attempt += 1;
          w.leaseId = crypto.randomBytes(8).toString("hex");
          w.leaseUntil = Date.now() + (b.leaseMs || SCHED.leaseMs);
          w.heartbeatAt = new Date().toISOString();
          if (b.loopId) w.loopId = String(b.loopId).slice(0, 40);
          emit("work.resumed", w.owner, { case: caseId, workId: w.id, planId: w.planId,
            agent: w.agent, nodeId: w.nodeId, owner: w.owner, attempt: w.attempt,
            leaseId: w.leaseId, leaseUntil: w.leaseUntil, loopId: w.loopId, traceId: w.traceId });
          return json(res, 200, { item: w, resumed: true });
        } else if (w.state === "running") {
          return json(res, 409, { error: "lease active", state: w.state, owner: w.owner,
            leaseUntil: w.leaseUntil });
        } else {
          return json(res, 409, { error: "not claimable", state: w.state });
        }
      }
      const planFilter = b.planId ? String(b.planId) : "";
      let scoped = planFilter ? list.filter(x => x.planId === planFilter) : list;
      if (b.id) scoped = scoped.filter(x => x.id === String(b.id));
      const done = new Set(scoped.filter(x => x.state === "done").map(x => x.nodeId));
      const running = list.filter(x => x.state === "running" && x.kind !== "child").length;
      const max = Number(b.maxConcurrency || SCHED.maxConcurrency || 1);
      if (running >= max) return json(res, 200, { item: null, reason: "slots", running, max });
      if (pausedCases.has(caseId)) return json(res, 200, { item: null, reason: "paused" });
      const bsnap = budgetSnapshot(caseId);
      if (bsnap.limit > 0 && bsnap.tokens + bsnap.reserved >= bsnap.limit) {
        if (!budgetAlerted.has(caseId)) {
          budgetAlerted.add(caseId);
          emit("budget.exceeded", "system", { case: caseId, tokens: bsnap.tokens,
            reserved: bsnap.reserved, limit: bsnap.limit });
        }
        return json(res, 200, { item: null, reason: "budget", tokens: bsnap.tokens,
          reserved: bsnap.reserved, limit: bsnap.limit, available: bsnap.available });
      }
      const now = Date.now();
      const planDone = (pid) => {
        const ws = (works.get(caseId) || []).filter(x => x.planId === pid && x.kind !== "child");
        return ws.length > 0 && ws.every(x => x.state === "done");
      };
      const planFailed = (pid) => (works.get(caseId) || []).some(x => x.planId === pid && x.kind !== "child" &&
        (x.state === "failed" || x.state === "cancelled"));
      const candidates = scoped.filter(x => x.kind !== "child" && x.state === "queued" &&
        (!x.retryAfter || x.retryAfter <= now) && (x.depends || []).every(d => done.has(d)))
        .sort((a, b2) => a.createdAt.localeCompare(b2.createdAt));
      const ready = candidates.find(x => (x.waitForPlans || []).every(pid => planDone(pid)));
      if (!ready) {
        const waiting = candidates.filter(x => (x.waitForPlans || []).length);
        if (waiting.length) {
          const failed = waiting.find(x => (x.waitForPlans || []).some(pid => planFailed(pid)));
          if (failed) return json(res, 200, { item: null, reason: "upstream-failed",
            workId: failed.id, plans: failed.waitForPlans || [] });
          const plansWaiting = Array.from(new Set(waiting.reduce((a, x) => a.concat(x.waitForPlans || []), [])));
          return json(res, 200, { item: null, reason: "waiting-upstream", plans: plansWaiting });
        }
        return json(res, 200, { item: null, reason: "no-ready" });
      }
      const sameAgentRunning = scoped.filter(x => x.state === "running" && x.agent === ready.agent && x.kind !== "child").length;
      if (sameAgentRunning >= maxSlotsOf(ready.agent)) {
        return json(res, 200, { item: null, reason: "agent-slots", agent: ready.agent,
          running: sameAgentRunning, maxSlots: maxSlotsOf(ready.agent) });
      }
      // 并发输出冲突：两个同时运行的节点声明同一输出文件，且都不是 merge 节点
      if ((SCHED.conflictCheck !== false) && !(ready.mergeFrom || []).length) {
        const runningPlan = list.filter(x => x.state === "running" && x.id !== ready.id && !(x.mergeFrom || []).length);
        const clash = (ready.outputs || []).find(o => runningPlan.some(x => (x.outputs || []).indexOf(o) >= 0));
        if (clash) {
          ready.state = "failed"; ready.finishedAt = new Date().toISOString();
          ready.error = "output conflict: " + clash;
          emit("work.conflict", "system", { case: caseId, workId: ready.id, planId: ready.planId,
            agent: ready.agent, nodeId: ready.nodeId, conflict: clash, traceId: ready.traceId });
          return json(res, 200, { item: null, reason: "conflict", conflict: clash });
        }
      }
      // 启动前预留 case token 上限；finish/cancel 时释放，agent.usage 仍按实际值累计。
      let reserveAmount = Math.max(0, Number(ready.maxTokens) || Number(b.reserveTokens) || 0);
      if (!reserveAmount && bsnap.limit > 0) reserveAmount = Math.max(0, Number(BUDGETS.defaultWorkReserve) || 0);
      const br = reserveCaseBudget(caseId, reserveAmount, { workId: ready.id, owner: b.owner || "worker" });
      if (!br.ok) {
        return json(res, 200, { item: null, reason: "budget", requested: br.requested,
          available: br.available, tokens: br.budget.tokens, reserved: br.budget.reserved,
          limit: br.budget.limit });
      }
      ready.state = "running"; ready.owner = b.owner || "worker"; ready.attempt += 1;
      if (b.loopId) ready.loopId = String(b.loopId).slice(0, 40);
      ready.needsReview = false; ready.reviewReason = "";
      ready.retryAfter = 0;
      ready.budgetReservation = br.reservation ? br.reservation.id : "";
      ready.budgetReserved = br.reservation ? br.reservation.amount : 0;
      ready.leaseId = crypto.randomBytes(8).toString("hex");
      ready.cancelRequested = false;
      ready.startedAt = new Date().toISOString(); ready.heartbeatAt = new Date().toISOString();
      ready.leaseUntil = Date.now() + (b.leaseMs || SCHED.leaseMs);
      emit("work.started", ready.owner, { case: caseId, workId: ready.id, planId: ready.planId,
        agent: ready.agent, nodeId: ready.nodeId, name: ready.name, owner: ready.owner,
        attempt: ready.attempt, leaseId: ready.leaseId, leaseUntil: ready.leaseUntil,
        budgetReservation: ready.budgetReservation, budgetReserved: ready.budgetReserved,
        maxTokens: ready.maxTokens, traceId: ready.traceId });
      return json(res, 200, { item: ready });
    }
    if (p === "/api/work/worker" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const w = (works.get(caseId) || []).find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "no such work" });
      w.workerPid = Number(b.pid) || 0;
      emit("work.worker", "system", { case: caseId, workId: w.id, planId: w.planId,
        agent: w.agent, nodeId: w.nodeId, pid: w.workerPid });
      return json(res, 200, { ok: true });
    }
    if (p === "/api/work/heartbeat" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state !== "running" && w.state !== "cancelling") return json(res, 409, { error: "not running", state: w.state });
      if (b.owner && w.owner && b.owner !== w.owner) return json(res, 409, { error: "owner mismatch" });
      if (b.leaseId && w.leaseId && b.leaseId !== w.leaseId) return json(res, 409, { error: "stale lease" });
      if (Date.now() > w.leaseUntil) return json(res, 409, { error: "lease expired", state: w.state, cancelRequested: w.cancelRequested });
      w.leaseUntil = Date.now() + (b.leaseMs || SCHED.leaseMs); w.heartbeatAt = new Date().toISOString();
      emit("work.heartbeat", w.owner || "worker", { case: w.case, workId: w.id, nodeId: w.nodeId,
        agent: w.agent, leaseUntil: w.leaseUntil, leaseId: w.leaseId, traceId: w.traceId });
      return json(res, 200, { item: w, cancelRequested: !!w.cancelRequested });
    }
    function missingCitationsForOutputs(caseId, outputs) {
      const ids = new Set();
      try { for (const line of fs.readFileSync(vaultPath(caseId, "evidence/sources.jsonl"), "utf8").split(String.fromCharCode(10))) {
        if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.id) ids.add(String(e.id)); } catch (e) {}
      } } catch (e) { return []; }
      const missing = [];
      (outputs || []).forEach(o => {
        const rel = outputRel(caseId, o);
        if (!rel) return;
        try {
          const text = fs.readFileSync(vaultPath(caseId, rel), "utf8");
          (text.match(/\[S\d+\]/g) || []).forEach(x => { const id = x.replace(/[\[\]]/g, ""); if (!ids.has(id)) missing.push(id + "@" + rel); });
        } catch (e) {}
      });
      return [...new Set(missing)];
    }
    if (p === "/api/work/finish" && req.method === "POST") {
      const b = await readBody(req);
      const list = works.get(b.case || "default") || [];
      const w = list.find(x => x.id === b.id);
      if (!w) return json(res, 404, { error: "work not found" });
      if (w.state !== "running" && w.state !== "cancelling") return json(res, 409, { error: "not running", state: w.state });
      if (b.owner && w.owner && b.owner !== w.owner) return json(res, 409, { error: "owner mismatch" });
      if (b.leaseId && w.leaseId && b.leaseId !== w.leaseId) return json(res, 409, { error: "stale lease" });
      const cancelled = !!b.cancelled || w.state === "cancelling" || w.cancelRequested;
      const partial = !!b.partial && !cancelled;
      const ok = b.ok !== false && !cancelled;
      w.state = cancelled ? "cancelled" : ((ok || partial) ? "done" : "failed");
      w.partial = partial;
      w.finishedAt = new Date().toISOString();
      if (Array.isArray(b.outputs) && b.outputs.length && (!w.outputs || !w.outputs.length)) w.outputs = b.outputs;
      w.error = String(b.error || "").slice(0, 1000);
      w.needsReview = !!b.needsReview && !ok && !cancelled;
      w.gate = (b.gate && typeof b.gate === "object") ? b.gate : (w.gate || null);
      if (Array.isArray(b.usedKnowledge)) w.usedKnowledge = b.usedKnowledge.map(String).slice(0, 50);
      if (b.loopId) w.loopId = String(b.loopId).slice(0, 40);
      // WorkItem 级 token 预算：超限即失败，且不把结果传给下游。
      if (w.maxTokens > 0 && (w.tokens || 0) > w.maxTokens) {
        w.state = "failed"; w.partial = false; w.needsReview = true;
        w.error = "work token budget exceeded: " + (w.tokens || 0) + "/" + w.maxTokens;
        emit("budget.work_exceeded", "system", { case: w.case, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, tokens: w.tokens || 0, limit: w.maxTokens });
      }
      releaseWorkBudget(w, "work.finish");
      w.leaseUntil = 0; w.leaseId = ""; w.cancelRequested = false; w.workerPid = 0;
      const classifyWorkFailure = (err) => {
        const e = String(err || "").toLowerCase();
        if (/wall_time|wall time|超过 wall|timeout/.test(e)) return "wall_timeout";
        if (/heartbeat|lease/.test(e)) return "heartbeat_timeout";
        if (/outputs missing|artifact/.test(e)) return "artifact_missing";
        if (/citation/.test(e)) return "citation_missing";
        if (/token budget/.test(e)) return "budget_exceeded";
        return "employee_failed";
      };
      // 完成态必须真的产出声明的文件；避免“exit 0 但没写产物”进入下一步。
      if (w.state === "done" && w.outputs.length) {
        const missingOut = w.outputs.filter(o => {
          const rel = outputRel(w.case, o);
          return !rel || !fs.existsSync(vaultPath(w.case, rel));
        });
        if (missingOut.length) {
          w.state = "failed"; w.partial = false;
          w.error = "outputs missing: " + missingOut.join(", ");
          w.needsReview = true;
          emit("work.needs_review", "system", { case: w.case, workId: w.id, planId: w.planId,
            agent: w.agent, nodeId: w.nodeId, reason: w.error, outputs: w.outputs });
        }
      }
      // 每个 WorkItem 完成时校验引用可解析，避免错误传到 Lead。
      if (w.state === "done" && w.outputs.length) {
        const missCite = missingCitationsForOutputs(w.case, w.outputs);
        if (missCite.length) {
          w.state = "failed"; w.partial = false; w.needsReview = true;
          w.error = "citations missing: " + missCite.slice(0, 10).join(", ");
          emit("work.needs_review", "system", { case: w.case, workId: w.id, planId: w.planId,
            agent: w.agent, nodeId: w.nodeId, reason: w.error, outputs: w.outputs });
        }
      }
      // 退出码异常但产物/门禁齐全：不自动重跑，挂起等待人工确认。
      if (w.state === "failed" && /exit\s*5/i.test(String(b.error || w.error || ""))) {
        let gatePassed = false;
        try {
          const wdir = path.join(ROOT, "runtime/work", w.id);
          fs.readdirSync(wdir).filter(n => /\.gate\.json$/.test(n)).forEach(n => {
            try { const g = JSON.parse(fs.readFileSync(path.join(wdir, n), "utf8")); if (g.status === "passed") gatePassed = true; } catch (e) {}
          });
        } catch (e) {}
        const outs = Array.isArray(b.outputs) ? b.outputs : [];
        const outputsExist = outs.length > 0 && outs.every(o => {
          const rel = outputRel(w.case, o);
          return rel && fs.existsSync(vaultPath(w.case, rel));
        });
        if (gatePassed && outputsExist) {
          w.needsReview = true;
          w.reviewReason = "exit 5，但已有产物且 gate 通过";
          emit("work.needs_review", "system", { case: w.case, workId: w.id, planId: w.planId,
            agent: w.agent, nodeId: w.nodeId, reason: w.reviewReason, outputs: outs });
        }
      }
      w.failureKind = (w.state === "done" || cancelled) ? "" : classifyWorkFailure(w.error);
      w.recovery = w.failureKind ? recoveryForWork(w) : null;
      try { const p0 = (plans.get(w.case) || []).find(x => x.id === w.planId); if (w.state === "done" && p0) writeUpstreamBrief(w.case, p0); } catch (e) {}
      emit(cancelled ? "work.cancelled" : (w.state === "done" ? "work.finished" : "work.failed"), w.owner || "worker",
        { case: w.case, workId: w.id, planId: w.planId, agent: w.agent, nodeId: w.nodeId,
          ok: ok && !partial, partial, cancelled, error: w.error, failureKind: w.failureKind,
          recovery: w.recovery || null, outputs: w.outputs, traceId: w.traceId,
          needsReview: !!w.needsReview, loopId: w.loopId || "", gate: w.gate || null });
      Array.from(fanoutGroups.values()).filter(g => g.case === w.case).forEach(g => {
        if (fanoutGroupDone(w.case, g)) { buildFanoutRaw(w.case, g, "system"); spawnLeadSynthesis(w.case, g); }
      });
      return json(res, 200, { item: w });
    }
    if (p === "/api/plan/reorder" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.planId);
      if (!plan) return json(res, 404, { error: "no such plan" });
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const old = plan.steps.map(s => s.id);
      if (ids.length !== old.length || ids.slice().sort().join(",") !== old.slice().sort().join(","))
        return json(res, 400, { error: "ids 必须覆盖全部任务且不重复" });
      const byId = {};
      plan.steps.forEach(s => { byId[s.id] = s; });
      plan.steps = ids.map(id => byId[id]);
      emit("plan.reordered", b.by || "you", { case: caseId, planId: plan.id, agent: plan.agent,
        order: ids, steps: plan.steps.length });
      return json(res, 200, { plan });
    }
    if (p === "/api/plan/approve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.id);
      if (!plan) return json(res, 404, { error: "no such plan" });
      const decision = b.decision === "reject" ? "rejected" : "approved";
      if (plan.planning || plan.status === "planning" || !(plan.steps || []).length) {
        return json(res, 409, { error: "计划步骤尚未生成，暂不能审批", planning: true, plan });
      }
      if (decision === "approved" && plan.status === "approved") {
        return json(res, 200, { ok: true, already: true, plan });
      }
      plan.status = decision;
      plan.approvedAt = new Date().toISOString();
      plan.approvedBy = b.by || "you";
      plan.note = String(b.note || "").slice(0, 500);
      emit(decision === "approved" ? "plan.approved" : "plan.rejected", b.by || "you",
        { case: caseId, planId: plan.id, agent: plan.agent, note: plan.note });
      return json(res, 200, { plan });
    }
    /* 固定任务模板已废弃：新计划只由 scope resolver 产生 */
    if (p === "/api/plan/update" && req.method === "POST") {
      const body = await readBody(req);
      const caseId = body.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === body.id);
      if (!plan) return json(res, 404, { error: "no such plan" });
      if (body.step) {
        const st = plan.steps.find(x => x.id === body.step.id);
        if (st) {
          if (typeof body.step.name === "string" && body.step.name.trim()) st.name = body.step.name.trim().slice(0, 40);
          if (typeof body.step.model === "string" && body.step.model.trim()) st.model = body.step.model.trim().slice(0, 200);
          if (["required", "degradable", "optional"].indexOf(body.step.failurePolicy) >= 0) st.failurePolicy = body.step.failurePolicy;
          emit("plan.updated", "you", { case: caseId, planId: plan.id, stepId: st.id, name: st.name, model: st.model || "", failurePolicy: st.failurePolicy || "", stepsData: plan.steps });
        }
      }
      return json(res, 200, { plan });
    }
    if (p === "/api/plan/progress" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const plan = (plans.get(caseId) || []).find(x => x.id === b.id);
      if (!plan) return json(res, 404, { error: "no such plan" });
      emit("plan.progress", b.by || "employee", { case: caseId, planId: plan.id, agent: plan.agent,
        step: b.step || "", status: b.status || "running", sessionId: b.sessionId || "" });
      return json(res, 200, { ok: true });
    }
    /* --- 员工之间的协作请求（研究类请求需审批） --- */
    if (p === "/api/coordination" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const from = String(b.from || ""), to = String(b.to || "");
      if (!from || !to) return json(res, 400, { error: "from/to required" });
      const c = { id: "CO" + (++coordSeq), case: caseId, from, to,
        task: String(b.task || "").slice(0, 600), reason: String(b.reason || "").slice(0, 300),
        status: "pending", createdAt: new Date().toISOString(), decidedBy: null };
      if (!coords.has(caseId)) coords.set(caseId, []);
      coords.get(caseId).push(c);
      emit("coordination.requested", from, { case: caseId, coordId: c.id, from, to,
        task: c.task, reason: c.reason });
      return json(res, 200, { coordination: c });
    }
    if (p === "/api/coordination" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { items: coords.get(caseId) || [] });
    }
    if (p === "/api/coordination/decide" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const c = (coords.get(caseId) || []).find(x => x.id === b.id);
      if (!c) return json(res, 404, { error: "no such coordination" });
      const ok = b.decision !== "deny";
      c.status = ok ? "approved" : "denied";
      c.decidedBy = b.by || "you";
      c.decidedAt = new Date().toISOString();
      emit(ok ? "coordination.approved" : "coordination.denied", b.by || "you",
        { case: caseId, coordId: c.id, from: c.from, to: c.to });
      return json(res, 200, { coordination: c });
    }
    function needItemProgress(n) {
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const done = items.filter(i => i.status === "provided").length;
      n.providedCount = done; n.totalCount = items.length;
      return { done, total: items.length };
    }
    function markNeedProgress(caseId, n) {
      const p = needItemProgress(n);
      if (needHasOpenConflict(n)) return false;
      // 同一指标还有未决定的候选时先不关闭，避免“先接受一个就关缺口”，把后续来源冲突吞掉。
      const acceptedIdx = new Set((n.candidates || []).filter(c => c.status === "accepted").map(c => c.itemIndex));
      if ((n.candidates || []).some(c => c.status === "pending" && acceptedIdx.has(c.itemIndex))) return false;
      const items0 = (n.spec && n.spec.items) || [];
      const resolved = items0.filter((it, i) => it.status === "provided" || it.status === "waived" ||
        (n.waivedItems || []).some(w => w.index === i)).length;
      if (items0.length && resolved >= items0.length) {
        n.status = "answered";
        n.answeredAt = new Date().toISOString(); n.answeredBy = "you";
        const lines = items0.map((it, i) =>
          (i + 1) + ". " + (it.indicator || "") + "：" + (it.value || "") +
          (it.status === "waived" ? "（已豁免）" : "") +
          (it.file ? "（文件 " + it.file + "）" : "") + (it.source ? " 来源：" + it.source : "") +
          (it.dataAsOf ? " 数据截至：" + it.dataAsOf : "") +
          (it.evidenceId ? " 证据：[" + it.evidenceId + "]" : ""));
        n.answer = "已逐项处理 " + resolved + "/" + items0.length + " 个指标：\n" + lines.join("\n");
        if (n.planId) {
          const plan = (plans.get(caseId) || []).find(x => x.id === n.planId);
          if (plan && Array.isArray(plan.blockedOnNeed)) {
            plan.blockedOnNeed = plan.blockedOnNeed.filter(x => x !== n.id);
            if (!plan.blockedOnNeed.length) {
              emit("plan.unblocked", "you", { case: caseId, planId: plan.id, needId: n.id });
              try { resumeApprovedPlans(caseId, "need-unblocked"); } catch (e) {}
            }
          }
        }
        // 关闭前把逐项结果单独落账，重启后 item.status/value/source 不会丢。
        emit("need.items.provided", "you", { case: caseId, needId: n.id,
          items: ((n.spec && n.spec.items) || []).map((it, i) => ({ index: i, value: it.value || "",
            source: it.source || "", file: it.file || "", evidenceId: it.evidenceId || "",
            dataAsOf: it.dataAsOf || "", note: it.note || "" })) });
        emit("need.answered", "you", { case: caseId, agent: n.agent, needId: n.id, kind: n.kind,
          title: n.title, answer: n.answer, planId: n.planId, evidenceId: "" });
        markReportStale(caseId, "缺口关闭：" + n.id, n.id);
        return true;
      }
      return false;
    }
    function dataTaskPolicy(raw) {
      const p = raw && typeof raw === "object" ? raw : {};
      const num = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || d));
      return {
        maxAttempts: num(p.maxAttempts, 3, 1, 5),
        maxSteps: num(p.maxSteps, 10, 2, 15),
        maxPages: num(p.maxPages, 5, 1, 30),
        maxWallClockMs: num(p.maxWallClockMs, 600000, 30000, 900000),
        allowedDomains: Array.isArray(p.allowedDomains) ? p.allowedDomains.map(x => String(x || "").trim()).filter(Boolean).slice(0, 20) : [],
        deniedDomains: Array.isArray(p.deniedDomains) ? p.deniedDomains.map(x => String(x || "").trim()).filter(Boolean).slice(0, 20) : [],
        allowPrivate: p.allowPrivate === true,
        allowLogin: false,
        sourceTier: String(p.sourceTier || "free-first").slice(0, 40)
      };
    }
    function dataTaskSourceList(raw, policy) {
      const out = [], errors = [];
      (Array.isArray(raw) ? raw : []).slice(0, 10).forEach(s => {
        if (!s || !s.ref) return;
        const src = { kind: s.kind === "file" ? "file" : "url", ref: String(s.ref).trim().slice(0, 2000),
          label: String(s.label || "").slice(0, 200),
          role: ["primary", "crosscheck", "attachment"].indexOf(s.role) >= 0 ? s.role : "primary",
          expectedItems: Array.isArray(s.expectedItems) ? s.expectedItems.map(Number).filter(Number.isInteger).slice(0, 20) : [] };
        const chk = dataTask.checkSource(src, policy);
        if (!chk.ok) { errors.push(chk.reason); return; }
        if (chk.kind === "url" && chk.ref) src.ref = chk.ref;
        src.id = "DS" + (++dataTaskSourceSeq);
        src.status = "added"; src.addedAt = new Date().toISOString(); src.lastError = "";
        out.push(src);
      });
      return { sources: out, errors };
    }
    function createDataTaskForNeed(caseId, n, itemIndexes, rawSources, rawPolicy, by) {
      const ACTIVE = ["source_pending", "ready", "parsing", "needs_more", "ready_for_review", "needs_human"];
      const active = (dataTasks.get(caseId) || []).find(t => t.needId === n.id && ACTIVE.indexOf(t.status) >= 0);
      if (active) return { error: "该缺口已有活跃数据任务", taskId: active.id };
      const contract = dataTask.buildContract(n, Array.isArray(itemIndexes) ? itemIndexes.map(Number) : []);
      if (!contract.items.length) return { error: "没有可补齐的缺口项" };
      const policy = dataTaskPolicy(rawPolicy);
      const sr = dataTaskSourceList(rawSources, policy);
      if (sr.errors.length) return { error: "来源被策略拒绝：" + sr.errors.join("；") };
      const task = {
        id: "DT" + (++dataTaskSeq), case: caseId, needId: n.id, agent: n.agent,
        status: sr.sources.length ? "ready" : "source_pending",
        itemIndexes: contract.items.map(x => x.index), contract, contractHash: dataTask.contractHash(contract),
        policy, sources: sr.sources, attempts: [], candidateIds: [],
        coverage: null, gate: null, nextAction: sr.sources.length ? "start" : "add_source",
        createdBy: by || "you", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        error: "", confirmedAt: "", closedAt: "", writeBatchId: "", evidenceIds: []
      };
      if (!dataTasks.has(caseId)) dataTasks.set(caseId, []);
      dataTasks.get(caseId).push(task);
      emitDataTask(task, "datatask.created", { needId: n.id, itemIndexes: task.itemIndexes });
      return { task };
    }
    function dataTaskFind(caseId, id) {
      return (dataTasks.get(caseId) || []).find(t => t.id === id) || null;
    }
    function dataTaskResolvedIndexes(n) {
      const items = (n && n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      return items.map((it, i) => (it.status === "provided" || it.status === "waived") ? i : -1).filter(i => i >= 0);
    }
    function dataTaskQuality(item, cands) {
      if (!item || ["daily", "monthly", "quarterly"].indexOf(item.periodType) < 0) return null;
      const records = (cands || []).map(c => ({ period: c.period, value: c.value, unit: c.unit }));
      // DataTask 自己用 unitMatches 做单位别名校验；这里不重复做精确单位匹配，避免 "人民币/港元（CNY per HKD）" 被误判。
      try { return dataQuality.check({ frequency: item.periodType, unit: "" }, records, { now: Date.now() }); }
      catch (e) { return null; }
    }
    function dataTaskView(task) {
      const n = (needs.get(task.case) || []).find(x => x.id === task.needId) || null;
      const candidates = n ? (n.candidates || []).filter(c => c.taskId === task.id) : [];
      const resolved = dataTaskResolvedIndexes(n);
      const cov = dataTask.computeCoverage(task.contract, candidates, Date.now(), resolved, dataTaskQuality);
      const items = (task.contract.items || []).map(ci => {
        const it = (n && n.spec && n.spec.items && n.spec.items[ci.index]) || {};
        const cv = (cov.items || []).find(x => x.index === ci.index) || {};
        return Object.assign({}, ci, { status: it.status || "pending", value: it.value || "",
          evidenceId: it.evidenceId || "", dataAsOf: it.dataAsOf || "", note: it.note || "",
          gate: cv.gate || "fail", coverage: cv.coverage || 0, got: cv.got || 0,
          issues: cv.issues || [], waived: !!cv.waived });
      });
      return Object.assign({}, task, { needTitle: n ? n.title : "", needStatus: n ? n.status : "",
        candidates, coverage: cov, nextAction: dataTask.nextAction(task, cov), items });
    }
    function emitDataTask(task, type, extra) {
      task.updatedAt = new Date().toISOString();
      emit("datatask.updated", "system", { case: task.case, id: task.id, task });
      if (type) emit(type, "system", Object.assign({ case: task.case, id: task.id }, extra || {}));
    }
    function addNeedCandidate(caseId, n, data) {
      ensureNeedV2(n);
      const cand = Object.assign({}, data, { id: "C" + (++candidateSeq), needId: n.id, status: "pending" });
      n.candidates.push(cand);
      emit("need.candidate.created", "system", { case: caseId, needId: n.id, candidateId: cand.id,
        taskId: cand.taskId || "", attemptId: cand.attemptId || "", itemIndex: cand.itemIndex,
        indicator: cand.indicator || "", value: cand.value, unit: cand.unit, period: cand.period,
        locator: cand.locator || null, confidence: cand.confidence || 0, extractor: cand.extractor || "",
        sourceId: cand.sourceId || "", sourceUrl: cand.sourceUrl || "", dataAsOf: cand.dataAsOf || "" });
      return cand;
    }
    function acceptNeedCandidate(caseId, n, cand, patch, by, batchId) {
      if (!cand || cand.status !== "pending") return { error: "candidate already decided" };
      const p = patch && typeof patch === "object" ? patch : {};
      const value = String(p.value !== undefined ? p.value : cand.value || "").slice(0, 2000);
      const unit = String(p.unit !== undefined ? p.unit : cand.unit || "").slice(0, 40);
      const period = String(p.period !== undefined ? p.period : cand.period || "").slice(0, 80);
      const src = (n.sources || []).find(s => s.id === cand.sourceId) || null;
      const locator = p.locator || cand.locator || { url: cand.sourceUrl || (src ? src.ref : "") };
      if (!value || !unit || !period || !locator) return { error: "接受候选必须提供 value/unit/period/locator" };
      const ev = appendEvidence(caseId, { candidateId: cand.id, sourceId: cand.sourceId || "",
        taskId: cand.taskId || "", attemptId: cand.attemptId || "", writeBatchId: batchId || "",
        url: cand.sourceUrl || (src ? src.ref : ""), field: cand.indicator,
        value, unit, period, locator, confidence: cand.confidence || 0,
        extractor: cand.extractor || "", source_tier: cand.sourceTier || "",
        sha256: cand.sha256 || "", snapshotPath: cand.snapshotPath || "", dataAsOf: cand.dataAsOf || "" });
      cand.status = "accepted"; cand.value = value; cand.unit = unit; cand.period = period;
      cand.locator = locator; cand.evidenceId = ev.id; cand.decidedBy = by || "you";
      cand.decidedAt = new Date().toISOString();
      const it = (n.spec && n.spec.items || [])[cand.itemIndex];
      if (it) {
        it.status = "provided"; it.value = value; it.source = cand.sourceUrl || (src ? src.ref : "");
        it.evidenceId = ev.id; it.dataAsOf = cand.dataAsOf || period;
        it.note = "DataTask 候选 " + cand.id; it.providedAt = new Date().toISOString(); it.providedBy = by || "you";
        it.auto = Object.assign({}, it.auto || {}, { status: "done", evidenceId: ev.id,
          dataAsOf: it.dataAsOf, at: new Date().toISOString() });
      }
      emit("need.candidate.decided", by || "you", { case: caseId, needId: n.id, candidateId: cand.id,
        decision: "accepted", evidenceId: ev.id, taskId: cand.taskId || "" });
      emit("need.item.provided", by || "you", { case: caseId, needId: n.id, index: cand.itemIndex,
        indicator: cand.indicator, value, unit, source: it ? it.source : (cand.sourceUrl || ""),
        evidenceId: ev.id, dataAsOf: it ? it.dataAsOf : "", note: it ? it.note : "" });
      const cf = refreshNeedConflict(n, cand.itemIndex);
      const closed = markNeedProgress(caseId, n);
      return { ok: true, candidate: cand, evidence: ev, conflict: cf, closed };
    }
    function acceptNeedSeries(caseId, n, itemIndex, cands, by, batchId) {
      const item = (n.spec && n.spec.items || [])[itemIndex];
      if (!item || !cands || !cands.length) return { error: "no series candidates" };
      const sorted = cands.slice().sort((a, b) => String(a.period || "").localeCompare(String(b.period || "")));
      const first = sorted[0], last = sorted[sorted.length - 1];
      const records = sorted.map(c => ({ period: c.period, value: c.value, unit: c.unit }));
      const source = (n.sources || []).find(s => s.id === first.sourceId) || null;
      const summary = String(first.period || "") + ".." + String(last.period || "") + " (" + sorted.length + " records)";
      const avg = sorted.reduce((s, c) => s + (Number(c.confidence) || 0), 0) / sorted.length;
      const ev = appendEvidence(caseId, { candidateId: first.id, candidateIds: sorted.map(c => c.id),
        taskId: first.taskId || "", attemptId: first.attemptId || "", writeBatchId: batchId || "",
        url: first.sourceUrl || (source ? source.ref : ""), field: item.indicator,
        value: summary, unit: first.unit || item.unit, period: String(first.period || "") + ".." + String(last.period || ""),
        locator: first.locator || { url: first.sourceUrl || (source ? source.ref : "") },
        confidence: Math.round(avg * 1000) / 1000, extractor: first.extractor || "",
        source_tier: first.sourceTier || "", sha256: first.sha256 || "", snapshotPath: first.snapshotPath || "",
        dataAsOf: last.dataAsOf || last.period || "", records });
      item.status = "provided"; item.value = summary; item.unit = first.unit || item.unit;
      item.source = first.sourceUrl || (source ? source.ref : ""); item.evidenceId = ev.id;
      item.dataAsOf = last.dataAsOf || last.period || ""; item.note = "DataTask 序列 " + sorted.length + " 条";
      const fileRef = (first.locator && first.locator.file) || (source && source.kind === "file" ? source.ref : "");
      if (fileRef) item.file = fileRef;
      item.providedAt = new Date().toISOString(); item.providedBy = by || "you";
      item.auto = Object.assign({}, item.auto || {}, { status: "done", evidenceId: ev.id, dataAsOf: item.dataAsOf, at: new Date().toISOString() });
      sorted.forEach((c, i) => {
        c.status = i === 0 ? "accepted" : "superseded"; c.evidenceId = ev.id;
        c.decidedBy = by || "you"; c.decidedAt = new Date().toISOString();
      });
      emit("need.series.accepted", by || "you", { case: caseId, needId: n.id, index: itemIndex,
        evidenceId: ev.id, value: summary, unit: item.unit, period: ev.period, source: item.source,
        file: item.file || "", dataAsOf: item.dataAsOf, records: records.length, candidateIds: sorted.map(c => c.id) });
      const cf = refreshNeedConflict(n, itemIndex);
      const closed = markNeedProgress(caseId, n);
      return { ok: true, evidence: ev, conflict: cf, closed, series: true, count: sorted.length };
    }
    function finishDataTaskAttempt(caseId, taskId, attemptId, result) {
      const task = dataTaskFind(caseId, taskId);
      if (!task) return { error: "no such datatask" };
      const attempt = (task.attempts || []).find(a => a.id === attemptId);
      if (!attempt || attempt.status !== "running") return { error: "attempt not running" };
      const n = (needs.get(caseId) || []).find(x => x.id === task.needId);
      if (!n) return { error: "no such need" };
      ensureNeedV2(n);
      const r = result || {};
      const records = Array.isArray(r.records) ? r.records : ((r.result && Array.isArray(r.result.records)) ? r.result.records : []);
      const created = [], skipped = [];
      if (r.ok !== false) {
        records.slice(0, 5000).forEach(rec => {
          const idx = dataTask.matchRecordToItem(rec, task.contract);
          if (idx === null) { skipped.push({ name: rec && (rec.name || rec.indicator || ""), reason: "无法匹配缺口项" }); return; }
          const item = task.contract.items.find(x => x.index === idx);
          if (!item) { skipped.push({ name: rec && rec.name, reason: "缺口项不存在" }); return; }
          const source = (task.sources || []).find(s => s.id === rec.sourceId) ||
            (task.sources || []).find(s => s.ref === rec.sourceUrl) || (task.sources || [])[0] || null;
          const data = dataTask.candidateFromRecord(rec, item, source, task.id, attempt.id);
          const dupe = (n.candidates || []).find(c => c.taskId === task.id && c.itemIndex === data.itemIndex &&
            c.period === data.period && c.value === data.value && c.sourceUrl === data.sourceUrl && c.status !== "rejected");
          if (dupe) { skipped.push({ name: data.indicator, reason: "重复候选，已跳过" }); return; }
          const cand = addNeedCandidate(caseId, n, data);
          created.push(cand.id); task.candidateIds.push(cand.id);
        });
      }
      attempt.status = r.ok === false ? "failed" : "done";
      attempt.finishedAt = new Date().toISOString();
      attempt.error = String(r.error || "").slice(0, 800);
      attempt.notes = String(r.notes || "").slice(0, 2000);
      attempt.recordCount = created.length;
      attempt.skipped = skipped.slice(0, 20);
      attempt.stats = r.stats && typeof r.stats === "object" ? r.stats : {};
      const cov = dataTask.computeCoverage(task.contract, n.candidates.filter(c => c.taskId === task.id),
        Date.now(), dataTaskResolvedIndexes(n), dataTaskQuality);
      task.coverage = cov;
      task.gate = cov.gate;
      const used = (task.attempts || []).filter(a => a.status !== "cancelled").length;
      task.status = cov.ready ? "ready_for_review" : (used >= task.policy.maxAttempts ? "needs_human" : "needs_more");
      task.nextAction = dataTask.nextAction(task, cov);
      task.error = attempt.status === "failed" ? attempt.error : "";
      emitDataTask(task, "datatask.attempt.finished", { attemptId: attempt.id, ok: attempt.status === "done",
        status: task.status, recordCount: created.length, error: attempt.error,
        coverage: cov, nextAction: task.nextAction });
      return { ok: true, task: dataTaskView(task), created };
    }
    function spawnDataTaskWorker(task, attempt) {
      const dir = path.join(ROOT, "runtime/datatask");
      fs.mkdirSync(dir, { recursive: true });
      const snapshot = { root: ROOT, case: task.case, id: task.id, attemptId: attempt.id, needId: task.needId,
        feedback: attempt.feedback || "",
        need: { id: task.needId, title: task.contract.title, spec: { items: (task.contract.items || []).map(x => ({
          indicator: x.indicator, definition: x.definition, unit: x.unit, frequency: x.frequency,
          range: x.range, format: x.format })) } },
        contract: task.contract, sources: task.sources, policy: task.policy,
        broker: "http://127.0.0.1:" + PORT };
      const file = path.join(dir, task.id + "-" + attempt.id + ".json");
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
      const log = path.join(dir, task.id + "-" + attempt.id + ".log");
      const fd = fs.openSync(log, "a");
      const child = spawn(process.execPath, [path.join(CODE_ROOT, "scripts/datatask-worker.js"),
        "--file", file, "--broker", "http://127.0.0.1:" + PORT],
        { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd] });
      attempt.pid = child.pid; attempt.snapshot = path.relative(ROOT, file); attempt.log = path.relative(ROOT, log);
      child.on("close", code => {
        try { fs.closeSync(fd); } catch (e) {}
        const cur = dataTaskFind(task.case, task.id);
        const a = cur && (cur.attempts || []).find(x => x.id === attempt.id);
        if (a && a.status === "running") {
          finishDataTaskAttempt(task.case, task.id, attempt.id, { ok: false, error: "worker exited " + code });
        }
      });
      child.unref();
      return child;
    }

    if (p === "/api/need/extract-file" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const rel = safeRel(b.path);
      if (!rel) return json(res, 400, { error: "bad path" });
      const abs = vaultPath(caseId, rel);
      if (!fs.existsSync(abs)) return json(res, 404, { error: "file not found" });
      const r = spawnSync("python3", [path.join(ROOT, "scripts/extract-table.py"), "--file", abs, "--field", String(b.field || "")], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
      let out = null; try { out = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, out && out.ok ? 200 : 400, out || { error: String(r.stderr || "").slice(0, 300) });
    }
    if (p === "/api/need/auto-collect" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const targets = b.id ? list.filter(n => n.id === b.id) : list.filter(n => n.status === "pending" || n.status === "partial");
      let jobs = [];
      targets.forEach(n => { if (n.kind === "data") jobs = jobs.concat(autoEnqueueNeed(caseId, n)); });
      return json(res, 200, { ok: true, jobs, needs: targets });
    }
    if (p === "/api/need/source/add" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const list = Array.isArray(b.sources) ? b.sources : (b.kind && b.ref ? [b] : []);
      const added = [];
      list.forEach(s => {
        const kind = s.kind === "file" ? "file" : "url";
        const ref = String(s.ref || "").trim().slice(0, 1000);
        if (!ref) return;
        if (kind === "url" && !/^https?:\/\//i.test(ref)) return;
        if (kind === "file" && !safeRel(ref)) return;
        const exists = n.sources.find(x => x.kind === kind && x.ref === ref);
        if (exists) return;
        const src = { id: "SRC" + (++sourceSeq), needId: n.id, kind, ref,
          label: String(s.label || "").slice(0, 120), status: "added", lastError: "", parseJobId: "",
          addedAt: new Date().toISOString(), addedBy: b.by || "you" };
        n.sources.push(src); added.push(src);
        emit("need.source.added", b.by || "you", { case: caseId, needId: n.id, sourceId: src.id, kind, ref });
      });
      return json(res, 200, { ok: true, added, sources: n.sources });
    }
    if (p === "/api/need/source/parse" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const ids = Array.isArray(b.sourceIds) ? b.sourceIds : [];
      const targets = n.sources.filter(s => (!ids.length || ids.indexOf(s.id) >= 0) && s.status !== "parsing");
      const jobs = [];
      for (const src of targets) {
        const job = { id: "PJ" + (++parseJobSeq), needId: n.id, sourceId: src.id,
          status: "running", extractor: src.kind === "url" ? "url_preview" : "extract_table",
          startedAt: new Date().toISOString(), finishedAt: "", error: "", candidateCount: 0 };
        n.parseJobs.push(job); src.status = "parsing"; src.parseJobId = job.id; src.lastError = "";
        emit("need.parse.started", "system", { case: caseId, needId: n.id, sourceId: src.id, parseJobId: job.id });
        try {
          const items = (n.spec && n.spec.items || []).map((it, i) => ({ it, i }))
            .filter(x => x.it.status !== "provided" && x.it.status !== "waived");
          const fields = items.map(x => x.it.indicator || "").filter(Boolean).join(",");
          let parsed = null;
          if (src.kind === "url") {
            const rr = spawnSync(process.execPath, [path.join(ROOT, "scripts/url_preview.js"),
              "--url", src.ref, "--field", fields], { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
            try { parsed = JSON.parse(String(rr.stdout || "").trim()); } catch (e) {}
            if (!parsed || !parsed.ok) throw new Error((parsed && parsed.error) || String(rr.stderr || "url preview failed").slice(0, 300));
            const cands = Array.isArray(parsed.candidates) ? parsed.candidates : [];
            for (const c of cands.slice(0, 40)) {
              const f = String(c.field || "").toLowerCase();
              let hit = items.find(x => (x.it.indicator || "").toLowerCase().indexOf(f) >= 0 || f.indexOf((x.it.indicator || "").toLowerCase()) >= 0);
              if (!hit && items.length === 1) hit = items[0];
              if (!hit) continue;
              const it = hit.it;
              const cand = { id: "C" + (++candidateSeq), needId: n.id, itemIndex: hit.i, sourceId: src.id,
                parseJobId: job.id, indicator: it.indicator || "", value: String(c.value || "").slice(0, 2000),
                unit: String(it.unit || ""), period: String(it.range || ""), locator: { url: src.ref, tableRow: c.tableRow, cells: c.cells || [] },
                confidence: 0.6, extractor: "url_preview", status: "pending", decidedBy: "", decidedAt: "", rejectReason: "", conflictGroup: "" };
              n.candidates.push(cand); job.candidateCount += 1;
              emit("need.candidate.created", "system", { case: caseId, needId: n.id, candidateId: cand.id,
                itemIndex: cand.itemIndex, sourceId: src.id, value: cand.value, unit: cand.unit, period: cand.period, locator: cand.locator });
            }
          } else {
            const rel = safeRel(src.ref);
            const abs = vaultPath(caseId, rel);
            if (!fs.existsSync(abs)) throw new Error("file not found: " + rel);
            const rr = spawnSync("python3", [path.join(ROOT, "scripts/extract-table.py"),
              "--file", abs, "--field", fields], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
            try { parsed = JSON.parse(String(rr.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
            if (!parsed || !parsed.ok) throw new Error((parsed && parsed.error) || String(rr.stderr || "file parse failed").slice(0, 300));
            const details = Array.isArray(parsed.candidateDetails) && parsed.candidateDetails.length ? parsed.candidateDetails
              : (parsed.candidates || []).map((v, i) => ({ value: v, row: i + 2, column: "" }));
            for (const d of details.slice(0, 40)) {
              let hit = items.find(x => d.column && String(d.column).toLowerCase().indexOf((x.it.indicator || "").toLowerCase()) >= 0);
              if (!hit && items.length === 1) hit = items[0];
              if (!hit) continue;
              const it = hit.it;
              const cand = { id: "C" + (++candidateSeq), needId: n.id, itemIndex: hit.i, sourceId: src.id,
                parseJobId: job.id, indicator: it.indicator || "", value: String(d.value || "").slice(0, 2000),
                unit: String(it.unit || ""), period: String(it.range || ""), locator: { file: rel, row: d.row, column: d.column || "" },
                confidence: 0.7, extractor: "extract_table", status: "pending", decidedBy: "", decidedAt: "", rejectReason: "", conflictGroup: "" };
              n.candidates.push(cand); job.candidateCount += 1;
              emit("need.candidate.created", "system", { case: caseId, needId: n.id, candidateId: cand.id,
                itemIndex: cand.itemIndex, sourceId: src.id, value: cand.value, unit: cand.unit, period: cand.period, locator: cand.locator });
            }
          }
          job.status = "done"; job.finishedAt = new Date().toISOString(); src.status = "parsed";
          emit("need.parse.finished", "system", { case: caseId, needId: n.id, sourceId: src.id,
            parseJobId: job.id, ok: true, candidateCount: job.candidateCount, error: "" });
        } catch (e) {
          job.status = "failed"; job.finishedAt = new Date().toISOString(); job.error = String(e && e.message || e).slice(0, 500);
          src.status = "failed"; src.lastError = job.error;
          emit("need.parse.finished", "system", { case: caseId, needId: n.id, sourceId: src.id,
            parseJobId: job.id, ok: false, candidateCount: 0, error: job.error });
        }
        jobs.push(job);
      }
      return json(res, 200, { ok: true, jobs, candidates: n.candidates, sources: n.sources });
    }
    if (p === "/api/datatask" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const caseId = String(u.searchParams.get("case") || "default");
      const tasks = (dataTasks.get(caseId) || []).slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(res, 200, { tasks: tasks.map(dataTaskView) });
    }
    if (p === "/api/datatask/get" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const caseId = String(u.searchParams.get("case") || "default");
      const task = dataTaskFind(caseId, String(u.searchParams.get("id") || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      return json(res, 200, { task: dataTaskView(task) });
    }
    if (p === "/api/datatask" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.needId);
      if (!n) return json(res, 404, { error: "no such need" });
      const r = createDataTaskForNeed(caseId, n, b.itemIndexes, b.sources, b.policy, b.by);
      if (r.error) return json(res, r.taskId ? 409 : 400, { error: r.error, taskId: r.taskId || "" });
      return json(res, 200, { ok: true, task: dataTaskView(r.task) });
    }
    if (p === "/api/datatask/source/add" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const task = dataTaskFind(caseId, String(b.id || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      if (["parsing", "closed", "cancelled"].indexOf(task.status) >= 0) return json(res, 409, { error: "当前状态不能加来源：" + task.status });
      const sr = dataTaskSourceList(b.sources, task.policy);
      if (sr.errors.length) return json(res, 400, { error: "来源被策略拒绝：" + sr.errors.join("；") });
      if (!sr.sources.length) return json(res, 400, { error: "没有有效来源" });
      task.sources.push(...sr.sources);
      if (task.status === "source_pending") task.status = "ready";
      task.nextAction = "start";
      emitDataTask(task, "datatask.source.added", { sourceIds: sr.sources.map(s => s.id) });
      return json(res, 200, { ok: true, task: dataTaskView(task) });
    }
    if (p === "/api/datatask/start" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const task = dataTaskFind(caseId, String(b.id || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      if (["parsing", "closed", "cancelled"].indexOf(task.status) >= 0) return json(res, 409, { error: "当前状态不能启动：" + task.status });
      if (!task.sources.length) return json(res, 409, { error: "请先添加来源" });
      const used = (task.attempts || []).filter(a => a.status !== "cancelled").length;
      const hardCap = task.policy.maxAttempts + 3;
      if (used >= hardCap) return json(res, 409, { error: "尝试次数已到硬上限，请人工处理", attempts: used, hardCap });
      if (used >= task.policy.maxAttempts && b.force !== true) {
        return json(res, 409, { error: "尝试次数已耗尽；请新增来源，或显式强制重试（最多额外 3 次）", attempts: used });
      }
      for (const s of task.sources) {
        const chk = dataTask.checkSource(s, task.policy);
        if (!chk.ok) return json(res, 409, { error: "来源被策略拒绝：" + chk.reason });
      }
      const key = dataTask.attemptKey(task.sources, "web.agent", b.feedback || "", task.contractHash);
      const same = (task.attempts || []).find(a => a.key === key && a.status !== "cancelled");
      if (same && b.force !== true) return json(res, 409, { error: "同一来源/策略已尝试过；请新增来源或给出反馈后重试", attemptId: same.id });
      const attempt = { id: "DA" + (++dataTaskAttemptSeq), key, strategy: "web.agent", forced: used >= task.policy.maxAttempts,
        feedback: String(b.feedback || "").slice(0, 1000), status: "running",
        startedAt: new Date().toISOString(), finishedAt: "", error: "", notes: "",
        recordCount: 0, skipped: [], stats: {}, pid: null, log: "", snapshot: "" };
      task.attempts.push(attempt);
      task.status = "parsing"; task.error = ""; task.nextAction = "wait";
      emitDataTask(task, "datatask.started", { attemptId: attempt.id, attemptKey: key });
      if (b.dryRun !== true) {
        spawnDataTaskWorker(task, attempt);
        emitDataTask(task, "datatask.worker.started", { attemptId: attempt.id, pid: attempt.pid, log: attempt.log });
      }
      return json(res, 200, { ok: true, task: dataTaskView(task) });
    }
    if (p === "/api/datatask/attempt/finish" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const out = finishDataTaskAttempt(caseId, String(b.id || ""), String(b.attemptId || ""), {
        ok: b.ok !== false, records: b.records, result: b.result, error: b.error, notes: b.notes, stats: b.stats });
      if (out.error) return json(res, 409, { error: out.error });
      return json(res, 200, { ok: true, task: out.task, created: out.created });
    }
    if (p === "/api/datatask/confirm" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const task = dataTaskFind(caseId, String(b.id || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      const n = (needs.get(caseId) || []).find(x => x.id === task.needId);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const view0 = dataTaskView(task);
      if ((task.status !== "ready_for_review" && task.status !== "write_failed") || !view0.coverage.ready) {
        return json(res, 409, { error: "数据任务尚未通过门禁", coverage: view0.coverage, nextAction: view0.nextAction });
      }
      const selections = b.selections && typeof b.selections === "object" ? b.selections : {};
      const plan = [], missing = [];
      for (const ci of task.contract.items) {
        const it = (n.spec && n.spec.items || [])[ci.index];
        if (!it || it.status === "provided" || it.status === "waived") continue;
        const cands = (n.candidates || []).filter(c => c.taskId === task.id && c.itemIndex === ci.index && c.status === "pending");
        const pick = selections[String(ci.index)] ? cands.find(c => c.id === selections[String(ci.index)]) : null;
        if (!cands.length) { missing.push(ci.indicator); continue; }
        const prev = (n.candidates || []).find(c => c.itemIndex === ci.index && c.status === "accepted");
        if (prev) {
          const cand0 = pick || cands[0];
          if (String(prev.value) !== String(cand0.value) || String(prev.unit) !== String(cand0.unit) || String(prev.period) !== String(cand0.period)) {
            return json(res, 409, { error: "同一指标已有不同的已接受证据，请先裁决冲突", itemIndex: ci.index });
          }
        }
        if (cands.length > 1) plan.push({ ci, series: cands });
        else plan.push({ ci, cand: cands[0], others: [] });
      }
      if (missing.length) return json(res, 409, { error: "仍有缺口项没有候选", missing });
      const batchId = task.writeBatchId || ("WB" + Date.now().toString(36) + "-" + task.id);
      const evidenceIds = [];
      let closed = false;
      try {
        for (const p2 of plan) {
          (p2.others || []).forEach(c => {
            if (c.status !== "pending") return;
            c.status = "rejected"; c.decidedBy = b.by || "you"; c.decidedAt = new Date().toISOString();
            c.rejectReason = "DataTask 选择主候选 " + p2.cand.id;
            emit("need.candidate.decided", b.by || "you", { case: caseId, needId: n.id,
              candidateId: c.id, decision: "rejected", reason: c.rejectReason, taskId: task.id });
          });
          const r = p2.series
            ? acceptNeedSeries(caseId, n, p2.ci.index, p2.series, b.by || "you", batchId)
            : acceptNeedCandidate(caseId, n, p2.cand, null, b.by || "you", batchId);
          if (r.error) {
            task.status = "write_failed"; task.error = "写入中断：" + r.error;
            emitDataTask(task, "datatask.write_failed", { error: task.error });
            return json(res, 409, { error: task.error, task: dataTaskView(task), recoverable: true });
          }
          if (r.conflict) {
            task.status = "write_failed"; task.error = "写入时出现多来源冲突";
            emitDataTask(task, "datatask.write_failed", { error: task.error, conflict: r.conflict });
            return json(res, 409, { error: task.error, conflict: r.conflict, task: dataTaskView(task), recoverable: true });
          }
          evidenceIds.push(r.evidence.id);
          closed = !!r.closed;
        }
      } catch (e) {
        task.status = "write_failed"; task.error = "写入异常：" + String(e && e.message || e).slice(0, 500);
        emitDataTask(task, "datatask.write_failed", { error: task.error });
        return json(res, 500, { error: task.error, task: dataTaskView(task), recoverable: true });
      }
      if (!closed) closed = markNeedProgress(caseId, n);
      const taskDone = (task.contract.items || []).every(ci => {
        const it = (n.spec && n.spec.items || [])[ci.index];
        return it && (it.status === "provided" || it.status === "waived");
      });
      if (!taskDone) {
        task.status = "write_failed"; task.error = "本任务负责的缺口项未全部完成";
        emitDataTask(task, "datatask.write_failed", { error: task.error });
        return json(res, 409, { error: task.error, missing: (task.contract.items || []).filter(ci => {
          const it = (n.spec && n.spec.items || [])[ci.index];
          return !it || (it.status !== "provided" && it.status !== "waived");
        }).map(ci => ci.indicator), task: dataTaskView(task), recoverable: true });
      }
      task.status = "closed"; task.confirmedAt = new Date().toISOString(); task.closedAt = task.confirmedAt;
      task.writeBatchId = batchId; task.evidenceIds = evidenceIds; task.nextAction = "done";
      emitDataTask(task, "datatask.confirmed", { writeBatchId: batchId, evidenceIds });
      emitDataTask(task, "datatask.closed", { writeBatchId: batchId, evidenceIds });
      return json(res, 200, { ok: true, task: dataTaskView(task), closed: !!closed, taskClosed: true, evidenceIds });
    }
    if (p === "/api/datatask/waive" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const task = dataTaskFind(caseId, String(b.id || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      if (["parsing", "closed", "cancelled"].indexOf(task.status) >= 0) return json(res, 409, { error: "当前状态不能豁免：" + task.status });
      const n = (needs.get(caseId) || []).find(x => x.id === task.needId);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const idx = Number(b.itemIndex);
      const it = (n.spec && n.spec.items || [])[idx];
      if (!it) return json(res, 400, { error: "bad itemIndex" });
      if (it.status === "provided") return json(res, 409, { error: "该项已提供，不能豁免" });
      const reason = String(b.reason || "").trim().slice(0, 500);
      if (!reason) return json(res, 400, { error: "豁免必须写理由" });
      it.status = "waived"; it.note = reason;
      if (!(n.waivedItems || []).some(w => w.index === idx)) n.waivedItems.push({ index: idx, reason, by: b.by || "you", at: new Date().toISOString() });
      emit("need.item.waived", b.by || "you", { case: caseId, needId: n.id, index: idx, indicator: it.indicator, reason });
      const closed = markNeedProgress(caseId, n);
      const cov = dataTask.computeCoverage(task.contract, (n.candidates || []).filter(c => c.taskId === task.id),
        Date.now(), dataTaskResolvedIndexes(n), dataTaskQuality);
      task.coverage = cov; task.gate = cov.gate;
      const taskDone = (task.contract.items || []).every(ci => {
        const x = (n.spec && n.spec.items || [])[ci.index];
        return x && (x.status === "provided" || x.status === "waived");
      });
      task.status = (closed || taskDone) ? "closed" : (cov.ready ? "ready_for_review" : ((task.attempts || []).filter(a => a.status !== "cancelled").length >= task.policy.maxAttempts ? "needs_human" : "needs_more"));
      task.nextAction = (closed || taskDone) ? "done" : dataTask.nextAction(task, cov);
      if (closed || taskDone) { task.closedAt = new Date().toISOString(); task.confirmedAt = task.closedAt; }
      emitDataTask(task, "datatask.waived", { itemIndex: idx, reason, closed, taskDone });
      return json(res, 200, { ok: true, task: dataTaskView(task), closed });
    }
    if (p === "/api/datatask/cancel" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const task = dataTaskFind(caseId, String(b.id || ""));
      if (!task) return json(res, 404, { error: "no such datatask" });
      if (task.status === "closed" || task.status === "cancelled") return json(res, 409, { error: "任务已结束" });
      task.status = "cancelled"; task.cancelledAt = new Date().toISOString();
      task.cancelReason = String(b.reason || "").slice(0, 500); task.nextAction = "cancelled";
      (task.attempts || []).forEach(a => {
        if (a.status === "running") {
          a.status = "cancelled"; a.finishedAt = new Date().toISOString();
          if (a.pid) { try { process.kill(a.pid, "SIGTERM"); } catch (e) {} }
        }
      });
      emitDataTask(task, "datatask.cancelled", { reason: task.cancelReason });
      return json(res, 200, { ok: true, task: dataTaskView(task) });
    }

    if (p === "/api/need/candidate/decide" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const cand = n.candidates.find(c => c.id === b.candidateId);
      if (!cand) return json(res, 404, { error: "no such candidate" });
      if (cand.status !== "pending") return json(res, 409, { error: "candidate already decided", status: cand.status });
      if (b.decision === "reject") {
        cand.status = "rejected"; cand.decidedBy = b.by || "you"; cand.decidedAt = new Date().toISOString();
        cand.rejectReason = String(b.reason || "").slice(0, 500);
        emit("need.candidate.decided", b.by || "you", { case: caseId, needId: n.id, candidateId: cand.id, decision: "rejected", reason: cand.rejectReason });
        return json(res, 200, { ok: true, candidate: cand, need: n });
      }
      const patch = b.patch && typeof b.patch === "object" ? b.patch : {};
      const r = acceptNeedCandidate(caseId, n, cand, patch, b.by || "you", b.batchId || "");
      if (r.error) return json(res, r.error === "candidate already decided" ? 409 : 400, { error: r.error });
      return json(res, 200, { ok: true, candidate: r.candidate, evidence: r.evidence,
        conflict: r.conflict, closed: r.closed, need: n });
    }
    if (p === "/api/need/conflict/resolve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const cf = n.conflicts.find(c => c.id === b.conflictId);
      if (!cf || cf.state !== "open") return json(res, 404, { error: "open conflict not found" });
      if (b.waive === true) {
        cf.state = "waived"; cf.resolution = { waived: true, reason: String(b.reason || "显式豁免").slice(0, 500), by: b.by || "you", at: new Date().toISOString() };
        emit("need.conflict.resolved", b.by || "you", { case: caseId, needId: n.id, conflictId: cf.id, waived: true, reason: cf.resolution.reason });
        const closed = markNeedProgress(caseId, n);
        return json(res, 200, { ok: true, conflict: cf, closed, need: n });
      }
      const chosen = n.candidates.find(c => c.id === b.chosenCandidateId);
      if (!chosen || chosen.status !== "accepted" || cf.candidateIds.indexOf(chosen.id) < 0)
        return json(res, 400, { error: "chosen candidate must be accepted and in conflict" });
      cf.state = "resolved"; cf.resolution = { chosenCandidateId: chosen.id, reason: String(b.reason || "").slice(0, 500), by: b.by || "you", at: new Date().toISOString() };
      n.candidates.filter(c => c.itemIndex === cf.itemIndex && c.status === "accepted" && c.id !== chosen.id)
        .forEach(c => { c.status = "superseded"; });
      const it = (n.spec && n.spec.items || [])[cf.itemIndex];
      if (it) { it.value = chosen.value; it.unit = chosen.unit; it.period = chosen.period; it.evidenceId = chosen.evidenceId || ""; }
      emit("need.conflict.resolved", b.by || "you", { case: caseId, needId: n.id, conflictId: cf.id, chosenCandidateId: chosen.id, reason: cf.resolution.reason });
      const closed = markNeedProgress(caseId, n);
      return json(res, 200, { ok: true, conflict: cf, closed, need: n });
    }
    if (p === "/api/need/item/waive" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const idx = Number(b.index);
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      items[idx].status = "waived"; items[idx].note = String(b.reason || "显式豁免").slice(0, 500);
      n.waivedItems.push({ index: idx, reason: items[idx].note, by: b.by || "you", at: new Date().toISOString() });
      emit("need.item.waived", b.by || "you", { case: caseId, needId: n.id, index: idx, indicator: items[idx].indicator, reason: items[idx].note });
      const closed = markNeedProgress(caseId, n);
      return json(res, 200, { ok: true, closed, need: n });
    }
    if (p === "/api/need/close" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      ensureNeedV2(n);
      const items = (n.spec && n.spec.items) || [];
      const missing = items.map((it, i) => ({ it, i })).filter(x => x.it.status !== "provided" && x.it.status !== "waived").map(x => x.it.indicator || String(x.i));
      const conflicts = n.conflicts.filter(c => c.state === "open").map(c => c.id);
      if (missing.length || conflicts.length) return json(res, 409, { error: "缺口未闭环", missing, conflicts });
      const closed = markNeedProgress(caseId, n);
      return json(res, closed ? 200 : 409, { ok: closed, need: n });
    }
    if (p === "/api/metric/drafts" && req.method === "GET") {
      const cfg = loadMetricConfig();
      return json(res, 200, { drafts: (cfg.metrics || []).filter(m => m.status === "draft") });
    }
    if (p === "/api/metric/draft/create" && req.method === "POST") {
      const b = await readBody(req);
      const cfg = loadMetricConfig();
      const name = String(b.name || "").trim().slice(0, 120);
      if (!name) return json(res, 400, { error: "name required" });
      const metrics = cfg.metrics || [];
      if (metrics.some(m => metricResolver.norm(m.name) === metricResolver.norm(name)))
        return json(res, 409, { error: "同名 metric 已存在" });
      const id = draftMetricId(name);
      const m = { id, name, definition: String(b.definition || "").slice(0, 600),
        unit: String(b.unit || "").slice(0, 40), frequency: String(b.frequency || "").slice(0, 30),
        stockFlow: String(b.stockFlow || "").slice(0, 10), region: String(b.region || "CN").slice(0, 10),
        aliases: Array.isArray(b.aliases) ? b.aliases.slice(0, 10) : [],
        sources: Array.isArray(b.sources) ? b.sources.slice(0, 10) : [],
        status: "draft", createdAt: new Date().toISOString(), createdBy: b.by || "you" };
      metrics.push(m); cfg.metrics = metrics; saveMetricConfig(cfg);
      emit("metric.draft.created", b.by || "you", { metricId: id, name, definition: m.definition });
      if (b.needId) {
        const n = (needs.get(b.case || "default") || []).find(x => x.id === b.needId);
        const idx = Number(b.index);
        const it = n && n.spec && n.spec.items ? n.spec.items[idx] : null;
        if (it) {
          it.metricId = id;
          it.match = { state: "draft", metricId: id, method: "human", confidence: 1, reasons: ["draft metric 待补来源/审核"], at: new Date().toISOString() };
          it.auto = { status: "no_source", metric: id, reason: "draft metric 待补来源/审核", matchState: "draft", at: new Date().toISOString() };
          emit("need.auto", "system", { case: b.case || "default", needId: n.id, index: idx, indicator: it.indicator, auto: it.auto, match: it.match });
        }
      }
      return json(res, 200, { metric: m, missing: validateDraftMetric(m) });
    }
    if (p === "/api/metric/draft/update" && req.method === "POST") {
      const b = await readBody(req);
      const cfg = loadMetricConfig();
      const m = (cfg.metrics || []).find(x => x.id === b.id);
      if (!m) return json(res, 404, { error: "metric not found" });
      if (m.status !== "draft") return json(res, 409, { error: "only draft can be updated", status: m.status });
      ["name", "definition", "unit", "frequency", "stockFlow", "region"].forEach(k => {
        if (b[k] !== undefined) m[k] = String(b[k]).slice(0, k === "definition" ? 600 : 120);
      });
      if (Array.isArray(b.aliases)) m.aliases = b.aliases.slice(0, 10);
      if (Array.isArray(b.sources)) m.sources = b.sources.slice(0, 10);
      saveMetricConfig(cfg);
      emit("metric.draft.updated", b.by || "you", { metricId: m.id, missing: validateDraftMetric(m) });
      return json(res, 200, { metric: m, missing: validateDraftMetric(m) });
    }
    if (p === "/api/metric/draft/review" && req.method === "POST") {
      const b = await readBody(req);
      const cfg = loadMetricConfig();
      const m = (cfg.metrics || []).find(x => x.id === b.id);
      if (!m) return json(res, 404, { error: "metric not found" });
      if (m.status !== "draft") return json(res, 409, { error: "not draft", status: m.status });
      if (b.decision !== "activate") {
        m.status = "rejected"; m.reviewedBy = b.by || "you"; m.reviewedAt = new Date().toISOString();
        saveMetricConfig(cfg);
        emit("metric.draft.rejected", b.by || "you", { metricId: m.id, reason: String(b.reason || "").slice(0, 500) });
        return json(res, 200, { metric: m });
      }
      const missing = validateDraftMetric(m);
      const badSources = (m.sources || []).filter(sid => {
        const reg = loadDataRegistry();
        const s = reg.sources.find(x => x.id === sid);
        return !s || s.structured === false;
      });
      if (missing.length || badSources.length) return json(res, 409, { error: "draft 未补全", missing, badSources });
      m.status = "active"; m.reviewedBy = b.by || "you"; m.reviewedAt = new Date().toISOString();
      saveMetricConfig(cfg);
      emit("metric.draft.activated", b.by || "you", { metricId: m.id, name: m.name });
      let jobs = [];
      needs.forEach((list, caseId) => list.forEach(n => {
        (n.spec && n.spec.items || []).forEach(it => {
          if (it.match && it.match.metricId === m.id && it.match.state === "draft") {
            it.match.state = "confirmed"; it.match.method = "human"; it.match.reasons = [];
            it.auto = null;
            jobs = jobs.concat(autoEnqueueNeed(caseId, n));
          }
        });
      }));
      return json(res, 200, { metric: m, jobs });
    }
    if (p === "/api/metric/alias/list" && req.method === "GET") {
      return json(res, 200, { proposals: loadAliasProposals() });
    }
    if (p === "/api/metric/alias/propose" && req.method === "POST") {
      const b = await readBody(req);
      const metricId = String(b.metricId || "").slice(0, 80);
      const text = String(b.text || "").trim().slice(0, 80);
      if (!metricId || !text) return json(res, 400, { error: "metricId/text required" });
      const list = loadAliasProposals();
      const pc = precheckAlias(metricId, text);
      const item = { id: "AL" + Date.now().toString(36), metricId, text, status: pc.status,
        reasons: pc.reasons || [], conflictMetricId: pc.conflictMetricId || "",
        by: b.by || "you", at: new Date().toISOString(), reviewedBy: "", reviewedAt: "", reviewReason: "" };
      list.push(item); saveAliasProposals(list);
      emit("metric.alias.proposed", b.by || "you", { metricId, text });
      emit("metric.alias.prechecked", "system", { metricId, text, pass: pc.pass, checks: pc.reasons || [] });
      return json(res, 200, { proposal: item });
    }
    if (p === "/api/metric/alias/review" && req.method === "POST") {
      const b = await readBody(req);
      const list = loadAliasProposals();
      const item = list.find(x => x.id === b.id);
      if (!item) return json(res, 404, { error: "no such proposal" });
      if (item.status !== "pre_reviewed") return json(res, 409, { error: "proposal not pre_reviewed", status: item.status });
      if (b.decision !== "approve") {
        item.status = "rejected"; item.reviewedBy = b.by || "you"; item.reviewedAt = new Date().toISOString();
        item.reviewReason = String(b.reason || "").slice(0, 500);
        saveAliasProposals(list);
        emit("metric.alias.reviewed", b.by || "you", { metricId: item.metricId, text: item.text, decision: "rejected", reason: item.reviewReason });
        return json(res, 200, { proposal: item });
      }
      const cfg = loadMetricConfig();
      const metric = (cfg.metrics || []).find(m => m.id === item.metricId);
      if (!metric) return json(res, 404, { error: "metric not found" });
      metric.aliases = Array.isArray(metric.aliases) ? metric.aliases : [];
      if (!metric.aliases.some(x => metricResolver.norm(x) === metricResolver.norm(item.text))) metric.aliases.push(item.text);
      fs.writeFileSync(path.join(ROOT, "config/data/metrics.json"), JSON.stringify(cfg, null, 2));
      item.status = "active"; item.reviewedBy = b.by || "you"; item.reviewedAt = new Date().toISOString();
      item.reviewReason = String(b.reason || "").slice(0, 500);
      saveAliasProposals(list);
      emit("metric.alias.reviewed", b.by || "you", { metricId: item.metricId, text: item.text, decision: "approved", reason: item.reviewReason });
      emit("metric.alias.approved", b.by || "you", { metricId: item.metricId, text: item.text });
      return json(res, 200, { proposal: item });
    }
    if (p === "/api/metric/semantic-resolve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const idx = Number(b.index);
      const items = (n.spec && n.spec.items) || [];
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      items[idx].match = Object.assign({}, items[idx].match || {}, { state: "resolving", method: "semantic", at: new Date().toISOString() });
      emit("metric.resolve.started", "system", { case: caseId, needId: n.id, index: idx, indicator: items[idx].indicator });
      try {
        const logDir = path.join(ROOT, "runtime/metric-resolve");
        fs.mkdirSync(logDir, { recursive: true });
        const fd = fs.openSync(path.join(logDir, n.id + "-" + idx + "-" + Date.now() + ".log"), "a");
        const cp = spawn(process.execPath, [path.join(ROOT, "scripts/metric-semantic.js"),
          "--case", caseId, "--need", n.id, "--index", String(idx)],
          { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
            env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
        cp.unref(); try { fs.closeSync(fd); } catch (e) {}
      } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
      return json(res, 200, { ok: true, queued: true, state: "resolving" });
    }
    if (p === "/api/metric/apply" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id || x.id === b.needId);
      if (!n) return json(res, 404, { error: "no such need" });
      const idx = Number(b.index);
      const items = (n.spec && n.spec.items) || [];
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      const r0 = b.result || {};
      const it = items[idx];
      it.match = { state: r0.state || "draft", metricId: r0.metricId || "", method: "semantic",
        confidence: Number(r0.confidence) || 0, reasons: r0.reasons || [], alternatives: r0.alternatives || [],
        reason: r0.reason || "", at: new Date().toISOString() };
      if (it.match.state === "confirmed" && it.match.metricId) {
        it.metricId = it.match.metricId;
        it.auto = null;
        emit("metric.confirmed", "system", { case: caseId, needId: n.id, index: idx, metricId: it.metricId, method: "semantic", confidence: it.match.confidence });
        const jobs = autoEnqueueNeed(caseId, n);
        return json(res, 200, { ok: true, match: it.match, jobs });
      }
      it.auto = { status: it.match.state === "draft" ? "no_source" : "needs_review", metric: it.match.metricId || "",
        reason: (it.match.reasons || []).join("；") || it.match.reason || "指标匹配待确认", matchState: it.match.state, at: new Date().toISOString() };
      emit("metric.resolved", "system", { case: caseId, needId: n.id, index: idx, state: it.match.state,
        metricId: it.match.metricId || "", method: "semantic", confidence: it.match.confidence, reasons: it.match.reasons || [] });
      emit("need.auto", "system", { case: caseId, needId: n.id, index: idx, indicator: it.indicator, auto: it.auto, match: it.match });
      return json(res, 200, { ok: true, match: it.match });
    }
    if (p === "/api/metric/confirm" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const idx = Number(b.index);
      const items = (n.spec && n.spec.items) || [];
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      const reg = loadDataRegistry();
      const metric = reg.metrics.find(m => m.id === b.metricId);
      if (!metric) return json(res, 404, { error: "no such metric" });
      const reasons = metricResolver.compatibility(metric, items[idx]);
      if (reasons.length && b.force !== true) return json(res, 409, { error: "定义/单位/频率不兼容，需显式强制", reasons });
      const it = items[idx];
      it.metricId = metric.id;
      it.match = { state: "confirmed", metricId: metric.id, method: "human", confidence: 1,
        reasons, forced: reasons.length > 0, reason: String(b.reason || "").slice(0, 500), at: new Date().toISOString() };
      it.auto = null;
      emit("metric.confirmed", b.by || "you", { case: caseId, needId: n.id, index: idx, metricId: metric.id,
        method: "human", forced: reasons.length > 0, reason: it.match.reason });
      const jobs = autoEnqueueNeed(caseId, n);
      return json(res, 200, { ok: true, match: it.match, jobs });
    }
    if (p === "/api/need/item/attempt" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const idx = Number(b.index);
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      const it = items[idx];
      it.attempts = Array.isArray(it.attempts) ? it.attempts : [];
      const attempt = { at: new Date().toISOString(), by: b.by || "you", url: String(b.url || "").slice(0, 500),
        found: String(b.found || "").slice(0, 1000), coverage: Number(b.coverage || 0),
        requirement: String(b.requirement || "").slice(0, 1000),
        missing: String(b.missing || "").slice(0, 1000), note: String(b.note || "").slice(0, 500) };
      it.attempts.push(attempt);
      if (it.attempts.length > 10) it.attempts = it.attempts.slice(-10);
      it.lastAttempt = attempt;
      emit("need.item.attempt", b.by || "you", { case: caseId, needId: n.id, index: idx,
        indicator: it.indicator, attempt });
      return json(res, 200, { need: n, item: it, attempt });
    }
    if (p === "/api/need/item/reset" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const idx = Number(b.index);
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      const it = items[idx];
      it.status = "pending"; delete it.value; delete it.source; delete it.file; delete it.files;
      delete it.note; delete it.evidenceId; delete it.providedAt; delete it.providedBy;
      n.status = "pending"; delete n.answeredAt; delete n.answeredBy;
      if (n.planId) {
        const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
        if (p) { p.blockedOnNeed = p.blockedOnNeed || []; if (p.blockedOnNeed.indexOf(n.id) < 0) p.blockedOnNeed.push(n.id); }
      }
      needItemProgress(n);
      emit("need.item.reset", b.by || "you", { case: caseId, needId: n.id, index: idx,
        indicator: it.indicator, done: n.providedCount, total: n.totalCount });
      markReportStale(caseId, "缺口数据撤销：" + n.id, n.id);
      return json(res, 200, { need: n, item: it });
    }
    if (p === "/api/need/item/provide" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const idx = Number(b.index);
      if (!(idx >= 0 && idx < items.length)) return json(res, 400, { error: "bad index" });
      const it = items[idx];
      it.status = "provided";
      it.value = String(b.value || "").slice(0, 2000);
      it.source = String(b.source || "").slice(0, 500);
      const files = Array.isArray(b.files) ? b.files.map(x => String(x || "")).filter(Boolean).slice(0, 20) : [];
      it.files = files;
      it.file = files.length ? files[0] : String(b.file || "").slice(0, 500);
      if (it.file && !it.files.length) it.files = [it.file];
      it.note = String(b.note || "").slice(0, 500);
      it.providedAt = new Date().toISOString(); it.providedBy = b.by || "you";
      try {
        const sid = (it.auto && it.auto.sourceId) || "";
        if (sid) { const prefs = readSourcePrefs(); const cid = caseId; prefs[cid] = prefs[cid] || {};
          prefs[cid][sid] = prefs[cid][sid] || { uses: 0, activatedAt: new Date().toISOString() };
          prefs[cid][sid].uses = (prefs[cid][sid].uses || 0) + 1; prefs[cid][sid].lastUsed = new Date().toISOString();
          fs.mkdirSync(path.dirname(sourcePrefPath()), { recursive: true }); fs.writeFileSync(sourcePrefPath(), JSON.stringify(prefs, null, 2)); }
      } catch (e) {}
      if (n.source === "valuation" && it.key) {
        try {
          const vf = vaultPath(caseId, "research/valuation.json");
          let vv = JSON.parse(fs.readFileSync(vf, "utf8"));
          let val = it.value;
          try { if (/^[\[{]/.test(String(val).trim())) val = JSON.parse(val); else if (val !== "" && !isNaN(Number(val))) val = Number(val); } catch (e) {}
          vv.inputs = vv.inputs || {}; vv.inputs[it.key] = val;
          vv.inputMeta = vv.inputMeta || {}; vv.inputMeta[it.key] = { source: it.source || it.file || "user", quality: "observed", asOf: new Date().toISOString().slice(0, 10) };
          fs.writeFileSync(vf, JSON.stringify(vv, null, 2));
          await runNode([path.join(ROOT, "scripts/valuation.js"), "--case", caseId], process.env, 30000);
        } catch (e) {}
      }
      const all = markNeedProgress(caseId, n);
      if (!all) emit("need.item.provided", b.by || "you", { case: caseId, needId: n.id,
        agent: n.agent, index: idx, indicator: it.indicator, value: it.value, source: it.source,
        file: it.file, files: it.files, done: n.providedCount, total: n.totalCount });
      if (!all) markReportStale(caseId, "缺口补数：" + n.id, n.id);
      return json(res, 200, { need: n, item: it, complete: all });
    }
    if (p === "/api/need/preview-url" && req.method === "POST") {
      const b = await readBody(req);
      const list = needs.get(b.case || "default") || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const items = (n.spec && n.spec.items) || [];
      const idx = Number(b.index);
      const fields = (idx >= 0 && items[idx]) ? [items[idx].indicator]
        : items.map(i => i.indicator).filter(Boolean);
      const script = path.join(ROOT, "scripts/url_preview.js");
      const child = spawnSync(process.execPath, [script, "--url", String(b.url || ""),
        "--field", (fields.length ? fields : [n.title]).join(",")],
        { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      let parsed = null; try { parsed = JSON.parse(String(child.stdout || "").trim()); } catch (e) {}
      if (!parsed || !parsed.ok) return json(res, 400, { error: (parsed && parsed.error) || String(child.stderr || "").slice(0, 300) });
      return json(res, 200, { preview: parsed, need: n });
    }
    if (p === "/api/need/commit-url" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const url = String(b.url || ""); const field = String(b.field || n.title).slice(0, 300);
      const value = String(b.value || "").slice(0, 2000);
      if (!url || !field || !value) return json(res, 400, { error: "url/field/value required" });
      const preview = spawnSync(process.execPath, [path.join(ROOT, "scripts/url_preview.js"),
        "--url", url, "--field", field], { cwd: ROOT, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      let pj = null; try { pj = JSON.parse(String(preview.stdout || "").trim()); } catch (e) {}
      const kind = pj && pj.kind;
      const cmd = kind === "pdf" ? "pdf" : (kind === "csv" ? "table" : "get");
      const args = [path.join(ROOT, "scripts/collect.js"), cmd, url, "--case", caseId, "--force", "--evidence",
        "--field", field, "--value", value, "--note", "need " + n.id + " 从 URL 采集"];
      if (kind === "pdf") args.push("--tables");
      const ex = await runProcess(args, Object.assign({}, process.env, { DESK_CASE: caseId, DESK_ACTOR: "you",
        DESK_BROKER: "http://127.0.0.1:" + PORT }), 120000);
      let col = null; try { col = JSON.parse(String(ex.stdout || "").trim()); } catch (e) {}
      if (!col || !col.ok) {
        console.error("[need.commit-url] status=" + ex.status + " outLen=" + String(ex.stdout || "").length +
          " stderr=" + String(ex.stderr || "").slice(0, 200));
        return json(res, 400, { error: (col && col.error) || String(ex.stderr || "").slice(0, 300) });
      }
      const evId = col.evidence && col.evidence.id;
      const idx = Number(b.index);
      const items = (n.spec && n.spec.items) || [];
      if (idx >= 0 && items[idx]) {
        const it = items[idx];
        it.status = "provided"; it.value = value; it.source = url; it.file = col.out || "";
        it.note = "从 URL 采集"; it.providedAt = new Date().toISOString(); it.providedBy = b.by || "you";
        it.evidenceId = evId || "";
        const complete = markNeedProgress(caseId, n);
        if (!complete) emit("need.item.provided", b.by || "you", { case: caseId, needId: n.id,
          agent: n.agent, index: idx, indicator: it.indicator, value: it.value, source: it.source,
          done: n.providedCount, total: n.totalCount });
        if (!complete) markReportStale(caseId, "缺口 URL 补数：" + n.id, n.id);
        return json(res, 200, { need: n, item: it, evidence: col.evidence || null,
          collected: col.out || null, complete });
      }
      n.status = "answered";
      n.answer = ["从 URL 采集：", "来源：" + url, "字段：" + field, "值：" + value,
        "证据：" + (evId || ""), "采集文件：" + (col.out || "")].join("\n");
      n.answeredAt = new Date().toISOString(); n.answeredBy = b.by || "you";
      markReportStale(caseId, "缺口 URL 答复：" + n.id, n.id);
      if (n.planId) {
        const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
        if (p && Array.isArray(p.blockedOnNeed)) {
          p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
          if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
        }
      }
      emit("need.answered", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
        kind: n.kind, title: n.title, answer: n.answer.slice(0, 500), planId: n.planId, evidenceId: evId });
      return json(res, 200, { need: n, evidence: col.evidence || null, collected: col.out || null });
    }
    if (p === "/api/need/merge-suggest" && req.method === "POST") {
      const b = await readBody(req);
      const list = needs.get(b.case || "default") || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      n.mergeSuggestion = { targetId: b.targetId, relation: b.relation || "related",
        confidence: b.confidence || 0, reason: String(b.reason || "").slice(0, 500) };
      n.pendingDedupe = { candidateIds: [b.targetId], status: "suggested" };
      emit("need.merge_suggested", "system", { case: b.case || "default", needId: n.id,
        targetId: b.targetId, relation: n.mergeSuggestion.relation,
        confidence: n.mergeSuggestion.confidence, reason: n.mergeSuggestion.reason });
      return json(res, 200, { need: n });
    }
    if (p === "/api/need/ignore" && req.method === "POST") {
      const b = await readBody(req);
      const list = needs.get(b.case || "default") || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      n.mergeSuggestion = null; n.dedupeIgnored = true;
      emit("need.merge_ignored", b.by || "you", { case: b.case || "default", needId: n.id });
      return json(res, 200, { need: n });
    }
    if (p === "/api/need/merge" && req.method === "POST") {
      const b = await readBody(req);
      const list = needs.get(b.case || "default") || [];
      const src = list.find(x => x.id === b.id);
      const target = list.find(x => x.id === b.targetId);
      if (!src || !target) return json(res, 404, { error: "need not found" });
      if (src.id === target.id) return json(res, 400, { error: "cannot merge into itself" });
      target.spec = needSpecUnion(target, src);
      target.indicatorIds = canonicalNeedIds(target);
      target.detail = (target.detail || "") + (target.detail ? "\n" : "") +
        "已合并 " + src.id + "：" + (src.title || "");
      target.blocking = target.blocking || src.blocking;
      src.status = "superseded"; src.supersededBy = target.id; src.mergeSuggestion = null;
      target.mergeSuggestion = null; target.pendingDedupe = null;
      emit("need.merged", b.by || "you", { case: b.case || "default", needId: target.id,
        canonicalId: target.id, mergedFrom: [src.id], spec: target.spec,
        indicatorIds: target.indicatorIds, title: target.title });
      emit("need.superseded", b.by || "you", { case: b.case || "default", needId: src.id,
        canonicalId: target.id, agent: src.agent });
      return json(res, 200, { need: target, mergedId: src.id });
    }
    if (p === "/api/need/supersede" && req.method === "POST") {
      const b = await readBody(req);
      const list = needs.get(b.case || "default") || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      n.status = "superseded";
      n.supersededBy = b.canonicalId || "";
      emit("need.superseded", b.by || "you", { case: b.case || "default", needId: n.id,
        canonicalId: n.supersededBy, agent: n.agent });
      return json(res, 200, { need: n });
    }
    async function toneCheck(mdPath) {
      const script = path.join(ROOT, "skills/lieflat-less-ai-tone/scripts/detect.py");
      if (!fs.existsSync(script)) return null;
      const ex = await runPython([script, mdPath, "--json"], Object.assign({}, process.env,
        { PYTHONPATH: path.join(ROOT, "runtime/py") }), 60000);
      try { return JSON.parse(String(ex.stdout || "").trim()); } catch (e) { return null; }
    }
    async function toneClean(mdPath, outPath) {
      const c = await runNode([path.join(ROOT, "scripts/tone-clean.js"), "--md", mdPath, "--out", outPath]);
      let cj = null; try { cj = JSON.parse(String(cons.out || "").trim().split("\n").pop()); } catch (e) {}
      if (!cj || !cj.ok) return null;
      const before = await toneCheck(mdPath), after = await toneCheck(outPath);
      return { path: outPath, clean: cj, before, after };
    }
    async function buildBriefs(caseId) {
      const out = [];
      for (const a of ["macro", "industry", "stock"]) {
        if (!fs.existsSync(vaultPath(caseId, "research/" + a + ".json")) && !fs.existsSync(vaultPath(caseId, "research/" + a + ".md"))) continue;
        const r = await runNode([path.join(ROOT, "scripts/brief.js"), "--case", caseId, "--agent", a]);
        let j = null; try { j = JSON.parse(String(r.out || "").trim()); } catch (e) {}
        out.push({ agent: a, ok: !!(j && j.ok) });
      }
      const cr = await runNode([path.join(ROOT, "scripts/cross-review.js"), "--case", caseId]);
      let cj = null; try { cj = JSON.parse(String(cr.out || "").trim()); } catch (e) {}
      return { briefs: out, crossReview: cj };
    }
    if (p === "/api/brief/build" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const r = await runNode([path.join(ROOT, "scripts/brief.js"), "--case", caseId, "--agent", String(b.agent || "")]);
      let j = null; try { j = JSON.parse(String(r.out || "").trim()); } catch (e) {}
      return json(res, j && j.ok ? 200 : 500, j || { ok: false, error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/cross-review" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/cross-review.js"), "--case", caseId]);
      let j = null; try { j = JSON.parse(String(r.out || "").trim()); } catch (e) {}
      return json(res, j && j.ok ? 200 : 500, j || { ok: false, error: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/report/readiness" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const agent = u.searchParams.get("agent") || "";
      const cov = await runNode([path.join(ROOT, "scripts/check-coverage.js"), "--case", caseId, "--agent", agent]);
      let cj = null; try { cj = JSON.parse(String(cov.out || "").trim()); } catch (e) {}
      const wantSemantic = u.searchParams.get("semantic") === "1";
      const br = await buildBriefs(caseId);
      const semanticJob = wantSemantic ? enqueueAsyncJob(caseId, "semantic_review", {}, "you") : null;
      const formal = !!(cj && cj.formal === true);
      return json(res, 200, { case: caseId, agent, formal, internal: !formal, briefs: br.briefs,
        crossReview: br.crossReview, semanticJob,
        reason: formal ? "coverage complete" : "coverage incomplete", coverage: cj });
    }
    if (p === "/api/ai-tone" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = String(b.agent || "");
      if (!/^(macro|industry|stock)$/.test(agent)) return json(res, 400, { error: "bad agent" });
      const reportMd = vaultPath(caseId, "reports/" + agent + "-report.md");
      const researchMd = vaultPath(caseId, "research/" + agent + ".md");
      const md = fs.existsSync(reportMd) ? reportMd : researchMd;
      const mdRel = fs.existsSync(reportMd) ? "reports/" + agent + "-report.md" : "research/" + agent + ".md";
      if (!fs.existsSync(md)) return json(res, 404, { error: "底稿不存在：research/" + agent + ".md" });
      const script = path.join(ROOT, "skills/lieflat-less-ai-tone/scripts/detect.py");
      if (!fs.existsSync(script)) return json(res, 503, { error: "skill not installed in panel catalog" });
      const ex = await runPython([script, md, "--json"], Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }), 60000);
      let j = null; try { j = JSON.parse(String(ex.stdout || "").trim()); } catch (e) {}
      if (!j) return json(res, 500, { error: "detect failed", detail: String(ex.stderr || "").slice(0, 300) });
      emit("ai_tone.checked", "you", { case: caseId, agent, hits: Object.values(j.hits || {}).reduce((a, x) => a + (x || []).length, 0) });
      return json(res, 200, { ok: true, agent, file: mdRel, report: j });
    }
function reviewFindings(caseId, service) {
  const rj = (f) => { try { return JSON.parse(fs.readFileSync(vaultPath(caseId, f), "utf8")); } catch (e) { return null; } };
  const out = [];
  if (service === "audit") {
    const v = rj("research/validation.json"), c = rj("research/claims-validation.json"), rd = rj("research/readability.json"), fg = rj("research/figures.json");
    out.push({ level: v && v.high === 0 ? "pass" : "fail", text: v ? ("证据引用 high " + (v.high || 0)) : "证据校验未运行" });
    out.push({ level: c && c.ok ? "pass" : "fail", text: c ? ("投资论点 " + (c.claims || 0) + " 条 · high " + (c.high || 0)) : "论点校验未运行" });
    out.push({ level: rd && rd.ok ? "pass" : "fail", text: rd ? ("可读性 " + (rd.chars || 0) + " 字 · 图 " + (rd.figures || 0)) : "可读性未运行" });
    out.push({ level: fg && (!fg.missing || !fg.missing.length) ? "warn" : "fail", text: fg ? ("图表 " + (fg.count || 0) + " 张 · 缺失 " + ((fg.missing || []).length) + " · 陈旧 " + ((fg.stale || []).length)) : "图表未运行" });
  } else {
    let md = ""; try { md = fs.readFileSync(vaultPath(caseId, "reports/investor-final.md"), "utf8"); } catch (e) {}
    out.push({ level: md && /免责声明|不构成投资建议/.test(md) ? "pass" : "fail", text: "免责声明与不构成投资建议" });
    out.push({ level: md && !/保证收益|承诺收益|稳赚|必涨/.test(md) ? "pass" : "warn", text: "未发现承诺性/保证性表述" });
    out.push({ level: md ? "warn" : "fail", text: "引用授权与版权需人工核对原始来源" });
  }
  try { const sp = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/sector-pack.json"), "utf8")); (sp.reviewChecks || []).slice(0, 5).forEach(x => out.push({ level: "warn", text: "行业复核：" + x })); } catch (e) {}
  out.push({ level: "warn", text: "以上为系统预检，不等于人工复核结论；请人工核对后签字" });
  return out;
}
function ensureFinalReview(caseId, service, rel, version, requester) {
  if (!reviews.has(caseId)) reviews.set(caseId, []);
  const list = reviews.get(caseId);
  const hit = list.filter(r => r.service === service && r.path === rel && r.version === version).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (hit) return hit;
  reviewSeq += 1;
  const rv = { id: "R" + reviewSeq, case: caseId, service, path: rel, version, round: list.filter(r=>r.service===service&&r.path===rel).length + 1,
    status: "requested", requester: requester || "system",
    criteria: service === "legal" ? "法务检查：引用授权、免责声明、版权/监管风险、对外表述" : "审计检查：数字与[S#]一致、预测已标识、图表来源完整、无内部流程词",
    checks: service === "legal"
      ? ["引用与授权：无未授权外部内容", "免责声明完整", "版权/监管风险已披露", "对外表述不含承诺性语言"]
      : ["数字与 [S#] 一致", "预测已标【机构预测】/【模型假设】", "图表均有来源", "无内部流程/版本文字"],
    findings: reviewFindings(caseId, service),
    createdAt: new Date().toISOString(), finishedAt: null, note: "", waivedBy: null };
  list.push(rv);
  emit("review.requested", rv.requester, { case: caseId, reviewId: rv.id, service, path: rel, version, round: rv.round });
  return rv;
}
    if (p === "/api/report/final" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const mains = ["macro", "industry", "stock"];
      const casePlans = plans.get(caseId) || [];
      const caseWorks = works.get(caseId) || [];
      for (const ag of mains) {
        // 取该员工最新计划；若最新计划还没批准/没完成，不能拿旧 approved 计划冒充最终稿。
        const p0 = casePlans.filter(x => x.agent === ag && x.status !== "rejected").pop();
        if (!p0) return json(res, 409, { error: ag + " 还没有计划" });
        if (p0.status !== "approved" && p0.status !== "done") return json(res, 409, { error: ag + " 最新计划尚未批准", planId: p0.id, status: p0.status });
        const ws = caseWorks.filter(w => w.planId === p0.id && w.kind !== "child");
        if (!ws.length || !ws.every(w => w.state === "done")) {
          return json(res, 409, { error: ag + " 尚未完成", planId: p0.id,
            work: ws.map(w => ({ nodeId: w.nodeId, state: w.state })) });
        }
      }
      const env = Object.assign({}, process.env, { DESK_CASE: caseId,
        DESK_BROKER: "http://127.0.0.1:" + PORT, PYTHONPATH: path.join(ROOT, "runtime/py") });
      // 0) 独立证据校验：引用必须能解析到 evidence
      const vr = await runNode([path.join(ROOT, "scripts/validate-research.js"), "--case", caseId], env, 60000);
      let vj = null; try { vj = JSON.parse(String(vr.out || "").trim().split("\n").pop()); } catch (e) {}
      if (!vj || vj.high > 0) return json(res, 409, { error: "证据校验未通过",
        validation: vj ? { high: vj.high, issues: (vj.issues || []).slice(0, 8) } : null });
      // 0.5) 数字/证据一致性检查（不阻断，记录冲突）
      const cons = await runNode([path.join(ROOT, "scripts/check-consistency.js"), "--case", caseId], env, 30000);
      const dupRun = await runNode([path.join(ROOT, "scripts/dedupe-evidence.js"), "--case", caseId], env, 30000);
      let dj0 = null; try { dj0 = JSON.parse(String(dupRun.out || "").trim().split("\n").pop()); } catch (e) {}
      let cj = null; try { cj = JSON.parse(String(cons.out || "").trim().split("\n").pop()); } catch (e) {}
      // 1) 以三份底稿装配共享主报告
      const mr = await runNode([path.join(ROOT, "scripts/master_report.js"), "--init", "--refresh"], env, 60000);
      let mj = null; try { mj = JSON.parse(String(mr.out || "").trim().split("\n").pop()); } catch (e) {}
      if (!mj || !mj.ok) {
        const existingMaster = vaultPath(caseId, "reports/master.md");
        if (!fs.existsSync(existingMaster)) return json(res, 500, { error: "主报告装配失败：" + String((mj && mj.error) || mr.err || "").slice(0, 300) });
      }
      // 1.4) 从结构化研究 JSON 生成数字图与催化剂日历，不依赖模型。
      // 通用图表目录会补齐本 case 已有图；若一张都没有，显式失败，不伪造图表。
      const exRun = await runNode([path.join(ROOT, "scripts/build-exhibits.js"), "--case", caseId], env, 60000);
      let exj = null;
      try { exj = JSON.parse(String(exRun.out || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop()); } catch (e) {}
      if (!exj || exj.ok === false) {
        return json(res, 409, { error: "图表缺失，无法生成最终报告", code: "figures_missing",
          hint: "请先让员工生成 figures/*.svg/png，或在报告流水线中确认图表后再试",
          detail: String((exj && (exj.hint || exj.error)) || exRun.err || "").slice(0, 300) });
      }
      try { await runNode([path.join(ROOT, "scripts/build-catalysts.js"), "--case", caseId], env, 30000); } catch (e) {}
      // 1.5) 为跨角色复核生成 brief（否则 cross-review 会报 missing_brief）
      for (const ag of mains) {
        try { await runNode([path.join(ROOT, "scripts/brief.js"), "--case", caseId, "--agent", ag], env, 60000); } catch (e) {}
      }
      // 2) 交叉复核（high 阻断）
      const cr = await runNode([path.join(ROOT, "scripts/cross-review.js"), "--case", caseId], env, 120000);
      let review = null;
      try { review = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review.json"), "utf8")); } catch (e) {}
      if (!review) { try { review = JSON.parse(String(cr.out || "").trim()); } catch (e) {} }
      if (review && !Array.isArray(review.issues)) review.issues = [];
      let sem0 = null; try { sem0 = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review-semantic.json"), "utf8")); } catch (e) {}
      if (sem0 && sem0.ok === false) {
        let waiver = null; try { waiver = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/semantic-waiver.json"), "utf8")); } catch (e) {}
        if (!waiver || waiver.ok !== true) return json(res, 409, { error: "语义复核未完成：" + (sem0.error || "model empty"),
          semantic: { ok: false }, hint: "如需接受确定性 cross-review，请显式 waiver" });
      }
      let crossWaiverUsed = null;
      if (review && review.high > 0) {
        const highIssues = (review.issues || []).filter(x => x.severity === "high");
        const highHash = sha256(JSON.stringify(highIssues.map(x => ({ type: x.type, from: x.from, to: x.to, message: x.message }))));
        let waiver = null;
        try { waiver = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review-waiver.json"), "utf8")); } catch (e) {}
        if (!waiver || waiver.ok !== true || waiver.hash !== highHash) {
          return json(res, 409, { error: "交叉复核存在 high 问题，禁止生成最终报告",
            crossReview: { high: review.high, issues: highIssues.slice(0, 8) },
            waiverRequired: true, hint: "如需测试输出，可显式豁免交叉复核并填写理由" });
        }
        env.CROSS_REVIEW_WAIVED = "1";
        crossWaiverUsed = waiver;
      }
      // 3) 投资者版编译：先抽 claims，再生成面向投资者的结构，不直接使用内部 master。
      const bc = await runNode([path.join(ROOT, "scripts/build-claims.js"), "--case", caseId], env, 60000);
      let bcj = null; try { bcj = JSON.parse(String(bc.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (!bcj || !bcj.ok) return json(res, 500, { error: "投资论点生成失败：" + String((bcj && bcj.error) || bc.err || "").slice(0, 300) });
      const mer = await runNode([path.join(ROOT, "scripts/map-claims-evidence.js"), "--case", caseId], env, 30000);
      let mej = null; try { mej = JSON.parse(String(mer.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      const cvr = await runNode([path.join(ROOT, "scripts/validate-claims.js"), "--case", caseId], env, 30000);
      let cvj = null; try { cvj = JSON.parse(String(cvr.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (!cvj || cvj.high > 0) return json(res, 409, { error: "投资论点校验未通过", claimsValidation: cvj || null });
      try { await runNode([path.join(ROOT, "scripts/report-structure.js"), "--case", caseId], env, 30000); } catch (e) {}
      const inv = await runNode([path.join(ROOT, "scripts/investor-report.js"), "--case", caseId], env, 60000);
      let invj = null; try { invj = JSON.parse(String(inv.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (!invj || !invj.ok) return json(res, 500, { error: "投资者版编译失败：" + String((invj && invj.error) || inv.err || "").slice(0, 300) });
      const rdg = await runNode([path.join(ROOT, "scripts/readability-gate.js"), "--case", caseId], env, 30000);
      let rdj = null; try { rdj = JSON.parse(String(rdg.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (!rdj || !rdj.ok) return json(res, 409, { error: "可读性闸门未通过", readability: rdj || null });
      const synthesized = false;
      let fj = null;
      const draftRel = "reports/investor-final.md";
      // 3.5) 投资者版清理：移除修订记录/内部受众等开发说明，保留正文与 [S#]。
      let srcMd = vaultPath(caseId, draftRel);
      try {
        const raw = fs.readFileSync(srcMd, "utf8");
        const investor = raw.split(String.fromCharCode(10))
          .filter(l => !/^\s*-\s*本轮修订/.test(l))
          .join(String.fromCharCode(10))
          .replace(/受众：内部投研/g, "受众：投资者");
        if (investor !== raw) {
          const cleanRel = path.join(ROOT, "runtime/cache", "investor-" + Date.now() + ".md");
          fs.writeFileSync(cleanRel, investor);
          srcMd = cleanRel;
        }
      } catch (e) {}
      // 4) 去 AI 味
      const cleanMd = path.join(ROOT, "runtime/cache", "final-" + Date.now() + ".md");
      const tc = await runNode([path.join(ROOT, "scripts/tone-clean.js"), "--md", srcMd, "--out", cleanMd], env, 60000);
      let tone = null; try { tone = JSON.parse(String(tc.out || "").trim()); } catch (e) {}
      // 4.5) 数据说明脚注：把自动采集的 dataAsOf/证据写进报告，过期项明确提示
      const fresh = reportFreshness(caseId);
      if (fresh.items.length) {
        try {
          const lines = fresh.items.map(x => "- " + (x.indicator || x.metricId || "") + "：数据截至 " + x.dataAsOf +
            (x.stale ? "（已过期，签发需人工确认）" : "") +
            (x.evidenceId ? "，证据 [" + x.evidenceId + "]" : ""));
          fs.appendFileSync(cleanMd, String.fromCharCode(10, 10) + "## 数据说明" + String.fromCharCode(10, 10) +
            lines.join(String.fromCharCode(10)) + String.fromCharCode(10, 10) +
            "> 数据截至日期为各来源最新可用期；过期项在签发时会被拦截，需人工确认。" + String.fromCharCode(10));
        } catch (e) {}
      }
      // 5) Word
      let docTitle = caseId + " 研究报告";
      try {
        const sp = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/sector-pack.json"), "utf8"));
        if (sp && sp.label) docTitle = sp.label + "行业研究报告";
      } catch (e) {}
      const dx = await runPython([path.join(ROOT, "scripts/md_to_docx.py"), "--md", cleanMd,
        "--out", FINAL_REPORT, "--case", caseId, "--title", docTitle, "--investor", "--no-disclaimer", "--evidence-appendix"], env, 120000);
      let dj = null; try { dj = JSON.parse(String(dx.stdout || "").trim().split("\n").pop()); } catch (e) {}
      if (!dj || !dj.ok) return json(res, 500, { error: "Word 生成失败：" + String((dj && dj.error) || dx.stderr || "").slice(0, 300) });
      // 报告版本以 manifest 为唯一来源；重启/重生成不回退。
      let prevVersion = 0;
      try { prevVersion = Number(JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 0); } catch (e) {}
      const reportVersion = prevVersion + 1;
      // 最终报告签发前自动创建审计/法务复核请求。
      try { ensureFinalReview(caseId, "audit", FINAL_REPORT, reportVersion, "system"); } catch (e) {}
      try { ensureFinalReview(caseId, "legal", FINAL_REPORT, reportVersion, "system"); } catch (e) {}
      const sourceVersions = {};
      ["research/macro.md", "research/industry.md", "research/stock.md", "evidence/sources.jsonl"].forEach(rel => {
        const f = S.files.get(caseId + "::" + rel);
        if (f) sourceVersions[rel] = { version: f.version, sha: f.sha };
      });
      const figRun = await runNode([path.join(ROOT, "scripts/figure-audit.js"), "--case", caseId], env, 30000);
      let figj = null; try { figj = JSON.parse(String(figRun.out || "").trim().split("\n").pop()); } catch (e) {}
      const inputFiles = ["research/claims.json", "research/investment-model.json", "research/valuation.json", "research/report-structure.json", "research/catalysts.json", "research/figures.json", "reports/investor-final.md", FINAL_REPORT];
      const inputs = {};
      inputFiles.forEach(rel => {
        try { const abs = vaultPath(caseId, rel); if (fs.existsSync(abs)) inputs[rel] = { sha: sha256(fs.readFileSync(abs)), bytes: fs.statSync(abs).size }; } catch (e) {}
      });
      const manifest = { case: caseId, generatedAt: new Date().toISOString(),
        sources: sourceVersions,
        final: dj.out, version: reportVersion, draft: draftRel,
        inputs,
        citations: synthesized ? fj.citations : null,
        synthesis: synthesized ? { ok: true, model: fj.model } : { ok: false, fallback: true, error: String((fj && fj.error) || "") },
        validation: vj ? { evidence: vj.evidence, high: vj.high, issues: (vj.issues || []).length } : null,
        consistency: cj ? { issues: (cj.issues || []).length, high: cj.high || 0 } : null,
        evidenceDuplicates: dj0 ? { groups: dj0.duplicateGroups || 0 } : null,
        figures: figj ? { count: figj.count || 0, usable: figj.usable || 0, missing: figj.missing || [], stale: figj.stale || [] } : null,
        claims: bcj ? { total: bcj.claims || 0 } : null,
        claimsValidation: cvj ? { ok: cvj.ok, high: cvj.high, claims: cvj.claims, issues: (cvj.issues || []).length } : null,
        claimEvidence: mej ? { claims: mej.claims, mapped: mej.mapped } : null,
        readability: rdj ? { ok: rdj.ok, chars: rdj.chars, figures: rdj.figures, bad: rdj.bad } : null,
        crossReview: review ? { high: review.high || 0, issues: (review.issues || []).length } : null,
        crossReviewWaiver: crossWaiverUsed ? { by: crossWaiverUsed.by || "", at: crossWaiverUsed.at || "",
          reason: crossWaiverUsed.reason || "", high: crossWaiverUsed.high || 0 } : null,
        reviews: (() => { const list = (reviews.get(caseId) || []).filter(r => r.path === FINAL_REPORT && (r.service === "audit" || r.service === "legal")); return list.map(r => ({ id: r.id, service: r.service, version: r.version, status: r.status })); })(),
        tone: tone ? { removedLabels: tone.removedLabels, semicolons: tone.semicolons } : null,
        dataFreshness: fresh, dataAsOf: fresh.items.length ? fresh.items.map(x => x.dataAsOf).sort().pop() : null };
      try { fs.writeFileSync(vaultPath(caseId, "reports/final-manifest.json"), JSON.stringify(manifest, null, 2)); } catch (e) {}
      clearReportStale(caseId);
      // 语义一致性复核放到异步任务，不阻塞最终 Word；面板可见进度。
      try {
        if (!fs.existsSync(vaultPath(caseId, "research/cross-review-semantic.json"))) {
          enqueueAsyncJob(caseId, "semantic_review", {}, "system");
        }
      } catch (e) {}
      let synthQueued = false;
      try {
        const statusFile = path.join(ROOT, "runtime/final-synthesis", caseId + ".json");
        let running = false;
        try { const st = JSON.parse(fs.readFileSync(statusFile, "utf8")); running = st.status === "running"; } catch (e) {}
        if (!running) {
          fs.mkdirSync(path.dirname(statusFile), { recursive: true });
          const logDir = path.join(ROOT, "runtime/final-synthesis");
          const logPath = path.join(logDir, caseId + "-" + Date.now() + ".log");
          const fd = fs.openSync(logPath, "a");
          const child = spawn(process.execPath, [path.join(ROOT, "scripts/final-synthesis.js"), "--case", caseId],
            { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
              env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
          child.unref(); synthQueued = true;
          emit("final.synthesis.queued", "system", { case: caseId, log: path.relative(ROOT, logPath) });
        }
      } catch (e) {}
      emit("report.final", "you", { case: caseId, out: dj.out, version: dj.version,
        crossReview: review ? { high: review.high || 0, issues: (review.issues || []).length } : null,
        tone: tone ? { removedLabels: tone.removedLabels, semicolons: tone.semicolons } : null, synthesisQueued: synthQueued });
      return json(res, 200, { ok: true, out: dj.out, version: reportVersion, manifest: "reports/final-manifest.json",
        draft: draftRel, synthesis: synthesized ? "model" : "fallback", synthesisQueued: synthQueued, citations: synthesized ? fj.citations : null,
        crossReview: review ? { high: review.high || 0, issues: (review.issues || []).length } : null,
        tone });
    }
    if (p === "/api/report/role" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = String(b.agent || "");
      if (!/^(macro|industry|stock)$/.test(agent)) return json(res, 400, { error: "bad agent" });
      const formal = b.formal === true || b.mode === "formal";
      const internal = b.mode === "internal";
      if (formal) {
        const cov = await runNode([path.join(ROOT, "scripts/check-coverage.js"), "--case", caseId, "--agent", agent]);
        let cj = null; try { cj = JSON.parse(String(cov.out || "").trim()); } catch (e) {}
        if (!cj || cj.formal !== true) return json(res, 409, { error: "critical coverage incomplete; use internal draft",
          formal: false, internal: true, coverage: cj });
        const br = await buildBriefs(caseId);
        if (br.crossReview && br.crossReview.high > 0)
          return json(res, 409, { error: "cross-review has high issues; resolve before formal report",
            formal: false, internal: true, crossReview: br.crossReview });
      }
      const rel = "research/" + agent + ".md";
      let abs = vaultPath(caseId, rel);
      if (!fs.existsSync(abs)) return json(res, 404, { error: "底稿不存在：" + rel });
      if (formal) {
        const sanitized = path.join(VAULT, caseId, "research", ".formal-" + agent + ".md");
        const f = await runNode([path.join(ROOT, "scripts/formalize-report.js"), "--md", abs, "--out", sanitized]);
        if (f.code !== 0 || !fs.existsSync(sanitized)) return json(res, 500, { error: "formalize failed", detail: String(f.err || "").slice(0, 300) });
        abs = sanitized;
      }
      let tone = null;
      if (formal && b.tone !== false) {
        try {
          const tonePath = path.join(VAULT, caseId, "research", ".tone-" + agent + ".md");
          tone = await toneClean(abs, tonePath);
          if (tone && tone.path) abs = tone.path;
          if (tone) {
            const toneFile = path.join(VAULT, caseId, "reports", agent + "-tone.json");
            fs.mkdirSync(path.dirname(toneFile), { recursive: true });
            fs.writeFileSync(toneFile, JSON.stringify(tone, null, 2));
          }
        } catch (e) { tone = { error: String(e && e.message || e) }; }
      }
      const out = "reports/" + agent + (internal ? "-internal" : "-report") + ".docx";
      const py = process.env.PYTHON || "python3";
      const roleName = (agent === "macro" ? "宏观研究分析报告" : agent === "industry" ? "行业研究分析报告" : "个股研究分析报告") + (internal ? "（内部稿）" : "");
      const ex = await runPython([path.join(ROOT, "scripts/md_to_docx.py"), "--md", abs, "--out", out,
        "--title", roleName, "--subtitle", caseId, "--role", agent, "--toc", "--evidence-appendix"],
        Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py"),
          DESK_CASE: caseId, DESK_BROKER: "http://127.0.0.1:" + PORT }), 60000);
      let j = null; try { j = JSON.parse(String(ex.stdout || "").trim()); } catch (e) {}
      if (!j || !j.ok) return json(res, 400, { error: (j && j.error) || String(ex.stderr || "").slice(0, 300) });
      emit("report.assembled", "you", { case: caseId, path: out, type: agent, formal: formal, internal: internal });
      return json(res, 200, Object.assign({ formal, internal, tone: tone ? {
        before: tone.before && { semicolon: tone.before.char_density && tone.before.char_density["分号"],
          headings: tone.before.structure && tone.before.structure["小标题/千字"] },
        after: tone.after && { semicolon: tone.after.char_density && tone.after.char_density["分号"],
          headings: tone.after.structure && tone.after.structure["小标题/千字"] },
        clean: tone.clean || null
      } : null }, j));
    }
    if (p === "/api/completion/options" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const item = { case: caseId, planId: b.planId || "", agent: b.agent || "",
        title: String(b.title || "任务已完成").slice(0, 100),
        message: String(b.message || "").slice(0, 500),
        options: Array.isArray(b.options) ? b.options.slice(0, 6).map(o => ({
          id: String(o.id || "").slice(0, 40), label: String(o.label || "").slice(0, 60),
          description: String(o.description || "").slice(0, 160), action: String(o.action || "").slice(0, 40),
          payload: (o.payload && typeof o.payload === "object") ? o.payload : {}
        })) : [], createdAt: new Date().toISOString(), chosen: null };
      completions.set(caseId, item);
      if (item.planId) completionsByPlan.set(caseId + "|" + item.planId, item);
      emit("completion.options", "system", { case: caseId, planId: item.planId,
        agent: item.agent, title: item.title, message: item.message,
        options: item.options, createdAt: item.createdAt });
      return json(res, 200, { completion: item });
    }
    if (p === "/api/completions" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      if (fs.existsSync(vaultPath(caseId, FINAL_REPORT))) {
        return json(res, 200, { completion: null, completions: [] });
      }
      const prune = c => {
        if (!c) return null;
        const opts = (c.options || []).filter(o => {
          const nid = o && o.payload && o.payload.needId;
          if (!nid) return true;
          const n = (needs.get(caseId) || []).find(x => x.id === nid);
          return !(n && (n.status === "answered" || n.status === "waived" || n.status === "superseded"));
        });
        return opts.length ? Object.assign({}, c, { options: opts }) : null;
      };
      const pending = Array.from(completionsByPlan.values())
        .filter(c => c.case === caseId && !c.chosen)
        .map(prune).filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return json(res, 200, { completion: prune(completions.get(caseId)) || pending[0] || null,
        completions: pending });
    }
    if (p === "/api/completion/choose" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const key = b.planId ? (caseId + "|" + b.planId) : "";
      const c = (key && completionsByPlan.get(key)) || completions.get(caseId);
      if (!c) return json(res, 404, { error: "no completion" });
      c.chosen = String(b.optionId || "");
      const keep = completionsByPlan.get(caseId + "|" + c.planId);
      if (keep) keep.chosen = c.chosen;
      emit("completion.chosen", b.by || "you", { case: caseId, planId: c.planId,
        agent: c.agent, optionId: c.chosen });
      return json(res, 200, { completion: c });
    }
    if (p === "/api/figure/plan" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      try { return json(res, 200, { plan: JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/figure-plans", caseId + ".json"), "utf8")) }); }
      catch (e) { return json(res, 200, { plan: null }); }
    }
    if (p === "/api/figure/plan" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const job = enqueueAsyncJob(caseId, "figure_plan", {}, b.by || "you");
      return json(res, 200, { ok: true, job });
    }
    if (p === "/api/figure/attach" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const items = (b.items || []).filter(x => x && x.rel && fs.existsSync(vaultPath(caseId, x.rel)));
      if (!items.length) return json(res, 400, { error: "no generated figures to attach" });
      let plan = null; try { plan = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/figure-plans", caseId + ".json"), "utf8")); } catch (e) {}
      const byId = {}; ((plan && plan.items) || []).forEach(x => { byId[x.id] = x; });
      const file = vaultPath(caseId, "research/ai-figures.json");
      let data = { case: caseId, items: [] }; try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
      const existing = {}; (data.items || []).forEach(x => { existing[x.rel] = 1; });
      items.forEach(x => {
        if (existing[x.rel]) return;
        const p0 = byId[x.id] || {};
        data.items.push({ id: x.id, title: x.title || p0.title || "", rel: x.rel,
          placement: ["summary","industry","company","macro","risks","metrics","figures","appendix"].indexOf(x.placement) >= 0 ? x.placement : (p0.placement || "figures") });
        existing[x.rel] = 1;
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      emit("figure.attached", b.by || "you", { case: caseId, items: data.items.map(x => ({ rel: x.rel, placement: x.placement })) });
      return json(res, 200, { ok: true, attached: items.length, placements: data.items.map(x => ({ rel: x.rel, placement: x.placement })) });
    }
    if (p === "/api/figure/generate" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const items = (b.items || []).slice(0, 3);
      if (!items.length) return json(res, 400, { error: "no items selected" });
      if (b.confirm !== true) return json(res, 400, { error: "explicit confirm required" });
      const job = enqueueAsyncJob(caseId, "figure_generate", { items }, b.by || "you");
      return json(res, 200, { ok: true, job });
    }
    if (p === "/api/conflicts" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      try { return json(res, 200, { conflicts: JSON.parse(fs.readFileSync(vaultPath(caseId, "research/conflicts.json"), "utf8")) }); }
      catch (e) { return json(res, 200, { conflicts: null }); }
    }
    if (p === "/api/conflict/resolve" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const job = enqueueAsyncJob(caseId, "conflict_resolve", { force: !!b.force }, b.by || "you");
      return json(res, 200, { ok: true, job });
    }
    if (p === "/api/conflict/apply" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      let data = null; try { data = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/conflicts.json"), "utf8")); } catch (e) {}
      const issue = data && (data.issues || []).find(x => x.id === b.issueId);
      const opt = issue && (issue.options || []).find(x => x.id === b.optionId);
      if (!issue || !opt) return json(res, 404, { error: "conflict option not found" });
      if (issue.applied) return json(res, 409, { error: "this conflict already has a revision plan", applied: issue.applied });
      if (opt.dataPolicy === "need") {
        needSeq += 1;
        const need = { id: "N" + needSeq, case: caseId, agent: opt.agent || issue.from || "macro", kind: "data",
          title: ("冲突修订需补数据：" + (opt.label || issue.id)).slice(0, 300),
          detail: ("冲突 " + issue.id + " 需要先补数据：" + (opt.task || opt.description || "")).slice(0, 2000),
          blocking: true, planId: "", stepId: "", spec: null, status: "pending",
          createdAt: new Date().toISOString(), answer: null, answeredAt: null, answeredBy: null,
          conflictId: issue.id, optionId: opt.id, dataPolicy: "need" };
        if (!needs.has(caseId)) needs.set(caseId, []);
        needs.get(caseId).push(need);
        issue.applied = { optionId: opt.id, needId: need.id, at: new Date().toISOString(), type: "need",
          label: opt.label || "", resolves: opt.resolves || issue.type, acceptanceRule: opt.acceptanceRule || "", dataPolicy: opt.dataPolicy || "need" };
        try { fs.writeFileSync(vaultPath(caseId, "research/conflicts.json"), JSON.stringify(data, null, 2)); } catch (e) {}
        emit("need.created", "system", { case: caseId, needId: need.id, agent: need.agent, kind: "data",
          title: need.title, detail: need.detail, blocking: true, conflictId: issue.id, optionId: opt.id });
        return json(res, 200, { need, applied: true });
      }
      const agent = opt.agent || issue.from || "industry";
      if (!plans.has(caseId)) plans.set(caseId, []);
      const plan = { id: nextPlanId(), case: caseId, agent,
        goal: ("冲突修订：" + (opt.label || issue.id)).slice(0, 300), steps: [{
          id: "R1", name: ("修订：" + (opt.label || issue.id)).slice(0, 40),
          tier: "strong", task: (opt.task || "") + String.fromCharCode(10) +
            "验收：" + (opt.acceptance || ""),
          outputs: ["research/" + agent + ".md", "research/" + agent + ".json"], depends: [],
          failurePolicy: "required", agent, conflictId: issue.id, optionId: opt.id
        }], planner: { by: "ConflictResolver", conflictId: issue.id, optionId: opt.id },
        version: 1, history: [], status: "pending", blockedOnNeed: [],
        createdAt: new Date().toISOString(), approvedAt: null, approvedBy: "", note: "" };
      plans.get(caseId).push(plan);
      issue.applied = { optionId: opt.id, planId: plan.id, at: new Date().toISOString(),
        label: opt.label || "", resolves: opt.resolves || issue.type, acceptanceRule: opt.acceptanceRule || "", dataPolicy: opt.dataPolicy || "existing" };
      try { fs.writeFileSync(vaultPath(caseId, "research/conflicts.json"), JSON.stringify(data, null, 2)); } catch (e) {}
      emit("plan.created", "system", { case: caseId, planId: plan.id, agent,
        goal: plan.goal, steps: plan.steps, stepCount: 1, status: "pending",
        planner: plan.planner, version: 1, conflictId: issue.id, optionId: opt.id });
      return json(res, 200, { plan });
    }
    if (p === "/api/final/waive-semantic" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const reason = String(b.reason || "").trim().slice(0, 500);
      if (!reason) return json(res, 400, { error: "reason required" });
      const p0 = vaultPath(caseId, "research/semantic-waiver.json");
      fs.mkdirSync(path.dirname(p0), { recursive: true });
      fs.writeFileSync(p0, JSON.stringify({ case: caseId, ok: true, by: b.by || "you",
        reason, at: new Date().toISOString() }, null, 2));
      emit("semantic.waived", b.by || "you", { case: caseId, reason });
      return json(res, 200, { ok: true, waiver: reason });
    }
    if (p === "/api/final/waive-cross-review" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const reason = String(b.reason || "").trim().slice(0, 500);
      if (!reason) return json(res, 400, { error: "reason required" });
      let review = null;
      try { review = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review.json"), "utf8")); } catch (e) {}
      const highIssues = ((review && review.issues) || []).filter(x => x.severity === "high");
      if (!highIssues.length) return json(res, 409, { error: "当前没有 high 交叉复核问题，无需豁免" });
      const hash = sha256(JSON.stringify(highIssues.map(x => ({ type: x.type, from: x.from, to: x.to, message: x.message }))));
      const p0 = vaultPath(caseId, "research/cross-review-waiver.json");
      fs.mkdirSync(path.dirname(p0), { recursive: true });
      fs.writeFileSync(p0, JSON.stringify({ case: caseId, ok: true, by: b.by || "you",
        reason, high: highIssues.length, hash, at: new Date().toISOString() }, null, 2));
      emit("cross_review.waived", b.by || "you", { case: caseId, reason, high: highIssues.length });
      return json(res, 200, { ok: true, waiver: reason, high: highIssues.length });
    }
    if (p === "/api/final/synthesis/retry" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const statusFile = path.join(ROOT, "runtime/final-synthesis", caseId + ".json");
      try { const st = JSON.parse(fs.readFileSync(statusFile, "utf8")); if (st.status === "running") return json(res, 409, { error: "already running" }); } catch (e) {}
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      const fd = fs.openSync(path.join(path.dirname(statusFile), caseId + "-retry-" + Date.now() + ".log"), "a");
      const child = spawn(process.execPath, [path.join(ROOT, "scripts/final-synthesis.js"), "--case", caseId],
        { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
      child.unref(); try { fs.closeSync(fd); } catch (e) {}
      emit("final.synthesis.queued", "you", { case: caseId, retry: true });
      return json(res, 200, { ok: true, queued: true });
    }
    if (p === "/api/case/view" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const finalExists = fs.existsSync(vaultPath(caseId, FINAL_REPORT));
      let consistency = null;
      try { consistency = reportConsistency(caseId); } catch (e) {}
      let crossReview = null;
      try { crossReview = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review.json"), "utf8")); } catch (e) {}
      const crossHighIssues = ((crossReview && crossReview.issues) || []).filter(x => x.severity === "high");
      let crossWaiver = null;
      try { crossWaiver = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/cross-review-waiver.json"), "utf8")); } catch (e) {}
      const crossHash = sha256(JSON.stringify(crossHighIssues.map(x => ({ type: x.type, from: x.from, to: x.to, message: x.message }))));
      const crossWaived = !!(crossWaiver && crossWaiver.ok === true && crossWaiver.hash === crossHash);
      const view = caseView.buildCaseView({
        caseId,
        plans: plans.get(caseId) || [],
        works: works.get(caseId) || [],
        needs: needs.get(caseId) || [],
        reviews: reviews.get(caseId) || [],
        signatures: reportSignatures.get(caseId) || {},
        finalExists,
        reportStale: !!(consistency && consistency.stale),
        staleReasons: (consistency && consistency.mismatches || []).map(x => x.path || x.field || String(x)).slice(0, 6),
        crossReviewHigh: crossHighIssues.length,
        crossReviewWaived: crossWaived,
        crossReviewIssues: crossHighIssues.slice(0, 8).map(x => ({ type: x.type || "", from: x.from || "", to: x.to || "", message: x.message || "" })),
        revision: S.seq
      });
      return json(res, 200, view);
    }
    if (p === "/api/case/objects" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const type = String(u.searchParams.get("type") || "evidence");
      const caseDir = path.join(ROOT, "vault", caseId);
      if (type === "claim") {
        const d = caseView.claimSummary(caseDir);
        return json(res, 200, { ok: true, type, counts: { total: d.total, mapped: d.mapped, unmapped: d.unmapped }, items: d.items.slice(0, 100) });
      }
      if (type === "brief") {
        const d = caseView.briefSummary(caseDir);
        return json(res, 200, { ok: true, type, counts: { total: d.total, complete: d.complete }, items: d.items });
      }
      const d = caseView.evidenceSummary(caseDir);
      return json(res, 200, { ok: true, type: "evidence",
        counts: { total: d.total, verified: d.verified, unverified: d.unverified, conflict: d.conflict, stale: d.stale, superseded: d.superseded },
        items: d.items.slice(-200) });
    }
    if (p === "/api/knowledge/search" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const q = String(u.searchParams.get("q") || "").toLowerCase().trim();
      const type = String(u.searchParams.get("type") || "").trim();
      const status = String(u.searchParams.get("status") || "").trim();
      const limit = Math.max(1, Math.min(20, parseInt(u.searchParams.get("limit") || "8", 10) || 8));
      const all = caseView.knowledgeView(caseId, ROOT).entries || [];
      const items = all.filter(x => {
        if (type && x.type !== type) return false;
        if (status && x.status !== status) return false;
        if (!q) return true;
        return String(x.id + " " + x.title + " " + x.value + " " + x.source).toLowerCase().includes(q);
      }).slice(0, limit);
      return json(res, 200, { ok: true, case: caseId, total: all.length, count: items.length, items });
    }
    if (p === "/api/knowledge/view" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, caseView.knowledgeView(caseId, ROOT));
    }
    if (p === "/api/final/status" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const baseR = vaultPath(caseId, "research");
      const baseP = vaultPath(caseId, "reports");
      let synth = null;
      try { synth = JSON.parse(fs.readFileSync(path.join(ROOT, "runtime/final-synthesis", caseId + ".json"), "utf8")); } catch (e) {}
      const readJson = (p0) => { try { return JSON.parse(fs.readFileSync(p0, "utf8")); } catch (e) { return null; } };
      const exists = (p0) => { try { return fs.existsSync(p0); } catch (e) { return false; } };
      const validation = readJson(path.join(baseR, "validation.json"));
      const briefCount = ["macro", "industry", "stock"].filter(a => exists(path.join(baseR, "brief-" + a + ".json"))).length;
      const review = readJson(path.join(baseR, "cross-review.json"));
      const crossWaiver = readJson(path.join(baseR, "cross-review-waiver.json"));
      const crossHighHash = review ? sha256(JSON.stringify((review.issues || []).filter(x => x.severity === "high")
        .map(x => ({ type: x.type, from: x.from, to: x.to, message: x.message })))) : "";
      const crossWaived = !!(crossWaiver && crossWaiver.ok === true && crossWaiver.hash === crossHighHash);
      const manifest = readJson(path.join(baseP, "final-manifest.json"));
      const stages = [
        { id: "evidence", label: "证据校验", status: validation ? (validation.high > 0 ? "failed" : "done") : "pending",
          detail: validation ? ("high " + (validation.high || 0) + " · evidence " + (validation.evidence || 0)) : "未运行" },
        { id: "brief", label: "共享 Brief", status: briefCount === 3 ? "done" : "pending",
          detail: briefCount + "/3" },
        { id: "consistency", label: "数字一致性", status: (() => { const c = readJson(path.join(baseR, "consistency.json")); return c ? (c.high > 0 ? "failed" : "done") : "pending"; })(),
          detail: (() => { const c = readJson(path.join(baseR, "consistency.json")); return c ? ("冲突 " + ((c.issues || []).length)) : "未运行"; })() },
        { id: "evidence-dedup", label: "证据去重", status: (() => { const d = readJson(path.join(baseR, "evidence-duplicates.json")); return d ? "done" : "pending"; })(),
          detail: (() => { const d = readJson(path.join(baseR, "evidence-duplicates.json")); return d ? ("重复组 " + (d.duplicateGroups || 0)) : "未运行"; })() },
        { id: "cross-review", label: "交叉复核", status: review ? (review.high > 0 && !crossWaived ? "failed" : "done") : "pending",
          detail: review ? ((crossWaived ? "已豁免 high " + (review.high || 0) + " · " : "") +
            ("high " + (review.high || 0) + " · issues " + ((review.issues || []).length))) : "未运行" },
        { id: "semantic", label: "语义一致性", status: (() => { const s0 = readJson(path.join(baseR, "cross-review-semantic.json")); const w = readJson(path.join(baseR, "semantic-waiver.json")); return w ? "done" : (s0 ? (s0.ok === false ? "failed" : (s0.high > 0 ? "failed" : "done")) : "pending"); })(),
          detail: (() => { const s0 = readJson(path.join(baseR, "cross-review-semantic.json")); const w = readJson(path.join(baseR, "semantic-waiver.json")); return w ? ("已豁免：" + String(w.reason || "").slice(0, 60)) : (s0 ? (s0.ok === false ? String(s0.error || "模型未返回") : ("high " + (s0.high || 0) + " · issues " + ((s0.issues || []).length))) : "异步复核未完成"); })() },
        { id: "master", label: "主报告装配", status: exists(path.join(baseP, "master.md")) ? "done" : "pending", detail: "reports/master.md" },
        { id: "figures", label: "图表", status: (() => { const f = readJson(path.join(baseR, "figures.json")); return f ? (f.ok ? "done" : "failed") : "pending"; })(),
          detail: (() => { const f = readJson(path.join(baseR, "figures.json")); return f ? (f.count + " 图 · 可用 " + f.usable + (f.available !== undefined ? " · 可用库 " + f.available : "") + (f.unused && f.unused.length ? " · 未用 " + f.unused.length : "") + (f.stale && f.stale.length ? " · 陈旧 " + f.stale.length : "")) : "未运行"; })() },
        { id: "investor", label: "投资者编译", status: exists(path.join(baseP, "investor-final.md")) ? "done" : "pending", detail: "investor-final.md" },
        { id: "claim-evidence", label: "论点映射", status: (() => { const m = readJson(path.join(baseR, "claim-evidence.json")); return m ? (m.mapped === m.claims ? "done" : "failed") : "pending"; })(),
          detail: (() => { const m = readJson(path.join(baseR, "claim-evidence.json")); return m ? (m.mapped + "/" + m.claims + " 有证据") : "未运行"; })() },
        { id: "claims", label: "论点校验", status: (() => { const c = readJson(path.join(baseR, "claims-validation.json")); return c ? (c.ok ? "done" : "failed") : "pending"; })(),
          detail: (() => { const c = readJson(path.join(baseR, "claims-validation.json")); return c ? (c.ok ? (c.claims + " 条 · high 0") : ("high " + c.high)) : "未运行"; })() },
        { id: "readability", label: "可读性", status: (() => { const r = readJson(path.join(baseR, "readability.json")); return r ? (r.ok ? "done" : "failed") : "pending"; })(),
          detail: (() => { const r = readJson(path.join(baseR, "readability.json")); return r ? (r.ok ? (r.chars + " 字 · 图 " + r.figures) : ("问题 " + (r.bad || []).length)) : "未运行"; })() },
        { id: "tone", label: "去 AI 味", status: manifest && manifest.tone ? "done" : "pending",
          detail: manifest && manifest.tone ? ("标签 " + (manifest.tone.removedLabels || 0) + " · 分号 " + (manifest.tone.semicolons || 0)) : "未运行" },
        { id: "docx", label: "Word 生成", status: exists(path.join(baseP, "final-report.docx")) ? "done" : "pending", detail: FINAL_REPORT },
        { id: "audit", label: "审计复核", status: (() => { const list = (reviews.get(caseId) || []).filter(r => r.service === "audit" && r.path === FINAL_REPORT); const r = list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]; return r ? (r.status === "clean" || r.status === "waived" ? "done" : (r.status === "returned" || r.status === "conditional" ? "failed" : "running")) : "pending"; })(),
          detail: (() => { const list = (reviews.get(caseId) || []).filter(r => r.service === "audit" && r.path === FINAL_REPORT); const r = list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]; return r ? r.status : "未请求"; })() },
        { id: "legal", label: "法务复核", status: (() => { const list = (reviews.get(caseId) || []).filter(r => r.service === "legal" && r.path === FINAL_REPORT); const r = list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]; return r ? (r.status === "clean" || r.status === "waived" ? "done" : (r.status === "returned" || r.status === "conditional" ? "failed" : "running")) : "pending"; })(),
          detail: (() => { const list = (reviews.get(caseId) || []).filter(r => r.service === "legal" && r.path === FINAL_REPORT); const r = list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0]; return r ? r.status : "未请求"; })() },
        { id: "synthesis", label: "跨报告综合", status: synth ? synth.status : "pending",
          detail: synth ? (synth.error ? String(synth.error).slice(0, 80) : (synth.status === "done" ? "已综合" : "后台运行中")) : "后台任务未启动" }
      ];
      return json(res, 200, { stages, synth: synth || null,
        finalExists: fs.existsSync(path.join(baseP, "final-report.docx")),
        done: stages.filter(x => x.status === "done").length, total: stages.length });
    }
    if (p === "/api/report/reader" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      let text = "";
      try { text = fs.readFileSync(vaultPath(caseId, "reports/investor-final.md"), "utf8"); } catch (e) {}
      return json(res, 200, { text, exists: !!text });
    }
    function evidenceSourceInfo(e, caseId) {
      const raw = String(e.raw || "");
      const url = String(e.url || "");
      const tier = String(e.source_tier || e.tier || "");
      const low = (raw + " " + url + " " + String(e.note || "")).toLowerCase();
      let label = "";
      if (low.includes("tushare")) label = "Tushare";
      else if (low.includes("chinabond") || low.includes("中债")) label = "中债";
      else if (low.includes("eastmoney") || low.includes("东方财富")) label = "东方财富";
      else if (low.includes("stats") || low.includes("统计局")) label = "国家统计局";
      else if (low.includes("cninfo") || low.includes("巨潮")) label = "巨潮资讯";
      else if (low.includes("nfra")) label = "国家金融监督管理总局";
      else if (low.includes("mof") || low.includes("财政部")) label = "财政部";
      else if (low.includes("sinajs") || low.includes("新浪")) label = "新浪财经";
      else if (low.includes("pbc") || low.includes("pbc.gov") || low.includes("人民银行")) label = "中国人民银行";
      else if (low.includes("gov.cn")) label = "中国政府网";
      else if (low.includes("uploads/") || tier === "upload" || tier === "supervisor-upload") label = "用户上传";
      else if (url) { try { label = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {} }
      if (!label) {
        const tierLabel = { official: "官方来源", "official-filing": "官方披露", "market-api": "市场数据 API",
          "supervisor-upload": "监督者上传", upload: "用户上传", "internal-check": "内部核验",
          derived: "衍生计算", mixed: "混合来源" };
        label = tierLabel[tier] || (tier ? ("来源：" + tier) : "未标注来源");
      }
      const rawName = raw ? path.basename(raw) : "";
      const uploadRel = (() => {
        for (const s of [raw, url]) {
          const m = String(s || "").match(/uploads\/[^；;（(]+?\.(pdf|xlsx|xls|csv|md|txt|json)/i);
          if (m) return m[0].replace(/^.*?(uploads\/)/, "uploads/");
        }
        return "";
      })();
      const fileName = uploadRel ? path.basename(uploadRel) :
        (String(url).startsWith("uploads/") ? path.basename(url.replace(/[（(].*$/, "")) : (rawName || ""));
      let sourceType = "other";
      if (uploadRel || tier === "upload" || tier === "supervisor-upload") sourceType = "file";
      else if (/^https?:\/\//i.test(url)) sourceType = "url";
      else if (raw) sourceType = "connector";
      else if (tier === "derived" || tier === "internal-check") sourceType = "derived";
      let sha = String(e.sha256 || "");
      let hashComputed = false;
      if (!sha && sourceType === "file") {
        const candidates = [];
        if (raw) candidates.push(path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
        if (uploadRel) candidates.push(path.join(ROOT, "vault", caseId, uploadRel));
        if (String(url).startsWith("uploads/")) candidates.push(path.join(ROOT, "vault", caseId, url.replace(/[（(].*$/, "")));
        for (const fp of candidates) {
          try {
            if (!fs.existsSync(fp)) continue;
            const st = fs.statSync(fp);
            if (st.size > 80 * 1024 * 1024) continue;
            const key = fp + "|" + st.mtimeMs + "|" + st.size;
            if (evidenceHashCache.has(key)) { sha = evidenceHashCache.get(key); }
            else { sha = sha256(fs.readFileSync(fp)); evidenceHashCache.set(key, sha); }
            hashComputed = true;
            break;
          } catch (e) {}
        }
      }
      return { sourceLabel: label, sourceTier: tier, sourceUrl: url, sourceRaw: rawName,
        sourceType, fileName, sha256: sha, hashComputed };
    }
    if (p === "/api/evidence" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const items = [];
      const superseded = loadEvidenceSuperseded(caseId);
      try { for (const line of fs.readFileSync(vaultPath(caseId, "evidence/sources.jsonl"), "utf8").split(String.fromCharCode(10))) { if (!line.trim()) continue; try { const e = JSON.parse(line); const sp = superseded[e.id] || null; const si = evidenceSourceInfo(e, caseId); items.push({ id: e.id, field: e.field || "", value: typeof e.value === "object" ? JSON.stringify(e.value).slice(0, 1200) : String(e.value || "").slice(0, 1200), url: e.url || "", fetchedAt: e.fetched_at || "", tier: e.source_tier || "", sourceLabel: si.sourceLabel, sourceTier: si.sourceTier, sourceUrl: si.sourceUrl, sourceRaw: si.sourceRaw,
                sourceType: si.sourceType, fileName: si.fileName, sha256: si.sha256, hashComputed: si.hashComputed, supersededBy: sp ? (sp.supersededBy || "") : "", superseded: !!sp, supersedeReason: sp ? (sp.reason || "") : "", supersededAt: sp ? (sp.at || "") : "" }); } catch (e) {} } } catch (e) {}
      return json(res, 200, { items });
    }
    if (p === "/api/evidence/supersede" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
      if (!ids.length) return json(res, 400, { error: "ids required" });
      const map = loadEvidenceSuperseded(caseId);
      const at = new Date().toISOString();
      const by = b.by || "you";
      const reason = String(b.reason || "被后续系列证据替代").slice(0, 500);
      ids.forEach(id => { map[id] = { supersededBy: String(b.supersededBy || "").slice(0, 20), reason, by, at }; });
      saveEvidenceSuperseded(caseId, map);
      emit("evidence.superseded", by, { case: caseId, ids, supersededBy: b.supersededBy || "", reason });
      return json(res, 200, { ok: true, superseded: ids, map });
    }
    if (p === "/api/needs" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const reg = loadDataRegistry();
      const list = (needs.get(caseId) || []).map(n => {
        const copy = Object.assign({}, n, needQueueInfo(n));
        if (copy.spec && Array.isArray(copy.spec.items)) {
          copy.spec = Object.assign({}, copy.spec, { items: copy.spec.items.map(it => {
            const mid = it && it.match && it.match.metricId;
            const m = mid ? reg.metrics.find(x => x.id === mid) : null;
            if (!m) return it;
            return Object.assign({}, it, { metricInfo: {
              id: m.id, name: m.name, definition: m.definition || "", unit: m.unit || "",
              frequency: m.frequency || "", stockFlow: m.stockFlow || "", region: m.region || "",
              sourceNote: m.sourceNote || "", sources: m.sources || []
            } });
          }) });
        }
        return copy;
      });
      return json(res, 200, { needs: list });
    }
    if (p === "/api/fanout/groups" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { groups: Array.from(fanoutGroups.values()).filter(g => g.case === caseId) });
    }
    if (p === "/api/fanout/dedupe" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const groups = Array.from(fanoutGroups.values()).filter(g => g.case === caseId).sort((a, b2) => String(a.createdAt).localeCompare(String(b2.createdAt)));
      const byGoal = {}; const removed = [];
      groups.forEach(g => { const gk = String(g.goal || "").trim().replace(/\s+/g, " "); byGoal[gk] = byGoal[gk] || []; byGoal[gk].push(g); });
      Object.keys(byGoal).forEach(goal => {
        const list = byGoal[goal]; if (list.length < 2) return;
        const keep = list[0];
        list.slice(1).forEach(g => {
          const pids = (g.tasks || []).map(t => t.planId).filter(Boolean);
          const ws = (works.get(caseId) || []).filter(w => pids.indexOf(w.planId) >= 0);
          if (ws.some(w => w.state === "running" || w.state === "cancelling")) return;
          ws.forEach(w => { if (w.state !== "done" && w.state !== "failed") { w.state = "cancelled"; w.error = "duplicate fanout superseded"; emit("work.cancelled", "system", { case: caseId, workId: w.id, planId: w.planId, agent: w.agent, nodeId: w.nodeId, cancelled: true, reason: "duplicate fanout" }); } });
          pids.forEach(pid => { const plan = (plans.get(caseId) || []).find(x => x.id === pid); if (plan) { plan.status = "rejected"; plan.note = "duplicate fanout superseded by " + keep.id; emit("plan.rejected", "system", { case: caseId, planId: pid, agent: plan.agent, note: plan.note }); } });
          fanoutGroups.delete(caseId + "|" + g.id); removed.push({ id: g.id, keep: keep.id, plans: pids });
          emit("fanout.deleted", "system", { case: caseId, groupId: g.id, keep: keep.id, plans: pids, reason: "duplicate fanout" });
        });
      });
      return json(res, 200, { ok: true, removed, groups: Array.from(fanoutGroups.values()).filter(g => g.case === caseId) });
    }
    if (p === "/api/valuation/methods" && req.method === "GET") {
      const list = [];
      try { for (const f of fs.readdirSync(path.join(ROOT, "config/valuation-methods"))) { if (!/\.json$/.test(f)) continue; const j = JSON.parse(fs.readFileSync(path.join(ROOT, "config/valuation-methods", f), "utf8")); list.push({ id: f.replace(/\.json$/, ""), label: j.label || f, required: j.required || [], fields: j.fields || [] }); } } catch (e) {}
      return json(res, 200, { methods: list });
    }
    if (p === "/api/valuation" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/valuation.js"), "--case", caseId, "--no-write"], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, j || { ok: false });
    }
    if (p === "/api/valuation/presets" && req.method === "GET") {
      const method = u.searchParams.get("method") || "dcf";
      const caseId = u.searchParams.get("case") || "default";
      let presets = {};
      try { presets = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/valuation-presets.json"), "utf8"))[method] || {}; } catch (e) {
        try { presets = JSON.parse(fs.readFileSync(path.join(ROOT, "config/valuation-presets.json"), "utf8"))[method] || {}; } catch (e2) {}
      }
      return json(res, 200, { method, presets });
    }
    if (p === "/api/valuation/prefill" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const pr = await runNode([path.join(ROOT, "scripts/prefill-valuation.js"), "--case", caseId], process.env, 30000);
      let pj = null; try { pj = JSON.parse(String(pr.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      const r = await runNode([path.join(ROOT, "scripts/valuation.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, { ok: !!(pj && pj.ok), filled: (pj && pj.filled) || [], valuation: j && j.valuation });
    }
    if (p === "/api/valuation" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const file = vaultPath(caseId, "research/valuation.json");
      let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
      const next = Object.assign({}, cur, { method: b.method || cur.method || "", inputs: b.inputs || cur.inputs || {}, inputMeta: b.inputMeta || cur.inputMeta || {}, reason: b.reason || cur.reason || "" });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { fs.appendFileSync(vaultPath(caseId, "research/valuation-history.jsonl"), JSON.stringify({ at: new Date().toISOString(), by: b.by || "you", before: { method: cur.method, inputs: cur.inputs, inputMeta: cur.inputMeta }, after: { method: next.method, inputs: next.inputs, inputMeta: next.inputMeta } }) + String.fromCharCode(10)); } catch (e) {}
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
      const r = await runNode([path.join(ROOT, "scripts/valuation.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      const vv = (j && j.valuation) || { method: next.method, result: { status: "missing", missing: [] } };
      syncValuationNeed(caseId, vv);
      emit("valuation.method", b.by || "you", { case: caseId, method: next.method });
      return json(res, 200, j || { ok: false });
    }
    if (p === "/api/investment-model" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/investment-model.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      return json(res, 200, j || { ok: false, error: "model failed" });
    }
    if (p === "/api/investment-model" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const m = b.model || {};
      const allowed = ["revenue2026e","growth","fcfMargins","terminalMargin","wacc","g","netCash","shares","price"];
      const out = {}; allowed.forEach(k => { if (m[k] !== undefined) out[k] = m[k]; });
      const file = vaultPath(caseId, "research/investment-model.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.assign({ case: caseId }, out), null, 2));
      const r = await runNode([path.join(ROOT, "scripts/investment-model.js"), "--case", caseId], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      emit("investment.model", b.by || "you", { case: caseId, perShare: j && j.model && j.model.computed && j.model.computed.perShare });
      return json(res, 200, j || { ok: false });
    }
    if (p === "/api/investor/summary" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      let claims = null, catalysts = null;
      try { claims = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/claims.json"), "utf8")); } catch (e) {}
      try { catalysts = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/catalysts.json"), "utf8")); } catch (e) {}
      let industryRaw = null;
      try { industryRaw = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/industry.json"), "utf8")); } catch (e) {}
      const iv0 = (industryRaw && (industryRaw.industryView || industryRaw.industry_view)) || null;
      if (claims && claims.industry && iv0) {
        claims.industry.industryView = iv0;
        if (!claims.industry.stance) claims.industry.stance = iv0.direction || "";
        if (!(claims.industry.claims || []).length) {
          claims.industry.claims = (iv0.keyVariables || []).slice(0, 5).map((x, i) => ({
            id: "I" + (i + 1), text: [x.name, x.value, x.direction].filter(Boolean).join("："),
            source: (x.evidence || []).join(","), confidence: 0.7, kind: "fact"
          }));
        }
      }
      const finalExists = fs.existsSync(vaultPath(caseId, FINAL_REPORT));
      let signed = false;
      try {
        const abs = vaultPath(caseId, FINAL_REPORT);
        const sha = sha256(fs.readFileSync(abs));
        const sig = (reportSignatures.get(caseId) || {})[FINAL_REPORT];
        let mv = 1; try { mv = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 1; } catch (e) {}
        signed = !!(sig && (!sig.sha || sig.sha === sha) && (sig.version || 1) === mv);
      } catch (e) {}
      let valuation = null; try { valuation = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/valuation.json"), "utf8")); } catch (e) {}
      let sectorPack = null; try { sectorPack = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/sector-pack.json"), "utf8")); } catch (e) {}
      try { const pe = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/peer-universe.json"), "utf8")); if (sectorPack) { sectorPack.l3 = pe.l3 || []; sectorPack.peerCount = pe.counts && pe.counts.peers || 0; } } catch (e) {}
      try { const iv = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/industry-valuation.json"), "utf8")); if (sectorPack) sectorPack.valuationStats = iv; } catch (e) {}
      if (!sectorPack) { try { await runNode([path.join(ROOT, "scripts/sector-pack.js"), "--case", caseId], process.env, 30000); sectorPack = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/sector-pack.json"), "utf8")); } catch (e) {} }
      return json(res, 200, { claims, catalysts, valuation, sectorPack, finalExists, signed, consistency: reportConsistency(caseId) });
    }
    if (p === "/api/report/profile" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      let current = { type: "mixed", label: "综合报告" };
      try { current = JSON.parse(fs.readFileSync(vaultPath(caseId, "research/report-profile.json"), "utf8")); } catch (e) {}
      const types = [];
      try { for (const f of fs.readdirSync(path.join(ROOT, "config/report-profiles"))) { if (!/\.json$/.test(f)) continue; const p0 = JSON.parse(fs.readFileSync(path.join(ROOT, "config/report-profiles", f), "utf8")); types.push({ type: p0.type || f.replace(/\.json$/, ""), label: p0.label || p0.type }); } } catch (e) {}
      return json(res, 200, { current, types });
    }
    if (p === "/api/report/profile" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const type = String(b.type || "mixed");
      if (!/^(mixed|industry|stock|macro|auto)$/.test(type)) return json(res, 400, { error: "bad profile" });
      const p0 = path.join(ROOT, "config/report-profiles", type + ".json");
      let prof = null; try { prof = JSON.parse(fs.readFileSync(p0, "utf8")); } catch (e) {}
      if (!prof) return json(res, 404, { error: "profile not found" });
      const out = vaultPath(caseId, "research/report-profile.json");
      fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(prof, null, 2));
      emit("report.profile", b.by || "you", { case: caseId, type });
      return json(res, 200, { ok: true, profile: prof });
    }
function syncValuationNeed(caseId, val) {
  try {
    const method = (val && val.method) || "valuation";
    const title = "估值输入缺失：" + method;
    if (!needs.has(caseId)) needs.set(caseId, []);
    const list = needs.get(caseId);
    const existing = list.find(n => n.title === title);
    const missing = (val && val.result && val.result.missing) || [];
    if (val && val.result && val.result.status !== "ok" && missing.length) {
      if (existing) {
        existing.detail = "需要补齐：" + missing.join("、");
        existing.spec = { items: missing.map((m, i) => ({ key: String(m).split("/")[0], indicator: String(m), definition: "估值方法 " + method + " 所需输入", source: "S# / URL / 文件 / 手动", status: "pending", value: "", file: "", note: "" })) };
        existing.status = "pending";
        if (!existing.owner) existing.owner = "analyst";
        if (!existing.dueAt) existing.dueAt = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
        existing.updatedAt = new Date().toISOString();
      } else {
        needSeq += 1;
        const need = { id: "N" + needSeq, case: caseId, agent: "stock", kind: "data", title,
          detail: "需要补齐：" + missing.join("、") + "，用于完成估值方法 " + method + "。",
          blocking: false, planId: "", stepId: "", spec: null, status: "pending",
          createdAt: new Date().toISOString(), answer: null, answeredAt: null, answeredBy: null,
          source: "valuation", missing, owner: "analyst", dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
          spec: { items: missing.map((m, i) => ({ key: String(m).split("/")[0], indicator: String(m), definition: "估值方法 " + method + " 所需输入", source: "S# / URL / 文件 / 手动", status: "pending", value: "", file: "", note: "" })) } };
        list.push(need);
        emit("need.created", "system", { case: caseId, needId: need.id, agent: "stock", kind: "data", title, detail: need.detail, blocking: false });
      }
    } else if (existing && existing.status === "pending") {
      existing.status = "provided";
      existing.answer = { by: "system", note: "估值输入已补齐", at: new Date().toISOString() };
      existing.updatedAt = new Date().toISOString();
      emit("need.updated", "system", { case: caseId, needId: existing.id, status: "provided", note: "估值输入已补齐" });
    }
  } catch (e) {}
}
// 数据补充后，如果已有最终报告，写一个持久化 stale 标记；报告重建时清除。
function reportStalePath(caseId) { return vaultPath(caseId, "reports/data-stale.json"); }
function markReportStale(caseId, reason, needId) {
  try {
    if (!fs.existsSync(vaultPath(caseId, "reports/final-manifest.json"))) return;
    const f = reportStalePath(caseId);
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
    const needs = Array.isArray(cur.needs) ? cur.needs : [];
    if (needId && needs.indexOf(needId) < 0) needs.push(needId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ stale: true, at: new Date().toISOString(),
      reason: String(reason || "数据补充"), needs }, null, 2));
    emit("report.stale", "system", { case: caseId, reason: String(reason || "数据补充"), needId: needId || "" });
  } catch (e) {}
}
function clearReportStale(caseId) {
  try { fs.unlinkSync(reportStalePath(caseId)); } catch (e) {}
}
function reportConsistency(caseId) {
  let m = null; try { m = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")); } catch (e) {}
  if (!m) return { ok: true, stale: false, reportVersion: 0, mismatches: [], noReport: true };
  const mismatches = [];
  try {
    const sm = JSON.parse(fs.readFileSync(reportStalePath(caseId), "utf8"));
    if (sm && sm.stale) mismatches.push({ path: "reports/data-stale.json", reason: "data_updated",
      at: sm.at || "", needs: sm.needs || [] });
  } catch (e) {}
  Object.keys(m.inputs || {}).forEach(rel => {
    try {
      const abs = vaultPath(caseId, rel);
      if (!fs.existsSync(abs)) { mismatches.push({ path: rel, reason: "missing" }); return; }
      const sha = sha256(fs.readFileSync(abs));
      if (sha !== m.inputs[rel].sha) mismatches.push({ path: rel, reason: "changed" });
    } catch (e) { mismatches.push({ path: rel, reason: "unreadable" }); }
  });
  let signed = false;
  try {
    const sha = sha256(fs.readFileSync(vaultPath(caseId, FINAL_REPORT)));
    const sig = (reportSignatures.get(caseId) || {})[FINAL_REPORT];
    signed = !!(sig && (!sig.sha || sig.sha === sha) && (sig.version || 1) === (m.version || 1));
  } catch (e) {}
  return { ok: mismatches.length === 0, stale: mismatches.length > 0, reportVersion: m.version || 0, signed, mismatches };
}
    if (p === "/api/report/freshness" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, reportFreshness(caseId));
    }
    if (p === "/api/report/consistency" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, reportConsistency(caseId));
    }
    if (p === "/api/final/preflight" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const rj = (f) => { try { return JSON.parse(fs.readFileSync(vaultPath(caseId, f), "utf8")); } catch (e) { return null; } };
      const vj = rj("research/validation.json");
      const cv = rj("research/claims-validation.json");
      const rd = rj("research/readability.json");
      const fg = rj("research/figures.json");
      const list = reviews.get(caseId) || [];
      const latest = svc => list.filter(r => r.service === svc && r.path === FINAL_REPORT).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      const audit = latest("audit"), legal = latest("legal");
      const checks = [
        { id: "report", label: "最终报告存在", ok: fs.existsSync(vaultPath(caseId, FINAL_REPORT)), detail: FINAL_REPORT },
        { id: "evidence", label: "证据引用校验", ok: !!(vj && vj.high === 0), detail: vj ? ("high " + (vj.high || 0) + " · evidence " + (vj.evidence || 0)) : "未运行" },
        { id: "claims", label: "投资论点映射", ok: !!(cv && cv.ok), detail: cv ? ((cv.claims || 0) + " 条 · high " + (cv.high || 0)) : "未运行" },
        { id: "readability", label: "投资者可读性", ok: !!(rd && rd.ok), detail: rd ? ((rd.chars || 0) + " 字 · 图 " + (rd.figures || 0) + (rd.bad && rd.bad.length ? " · " + rd.bad.join("、") : "")) : "未运行" },
        { id: "figures", label: "图表", ok: !!(fg && (!fg.missing || !fg.missing.length)), detail: fg ? ((fg.count || 0) + " 图 · 可用 " + (fg.usable || 0)) : "未运行" },
        { id: "audit", label: "审计复核", ok: !!(audit && (audit.status === "clean" || audit.status === "waived")), detail: audit ? audit.status : "未请求" },
        { id: "legal", label: "法务复核", ok: !!(legal && (legal.status === "clean" || legal.status === "waived")), detail: legal ? legal.status : "未请求" }
      ];
      return json(res, 200, { ok: checks.every(c => c.ok), checks, reportVersion: (() => { try { return JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 1; } catch (e) { return 1; } })() });
    }
    if (p === "/api/reports" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const dir = vaultPath(caseId, "reports");
      const sigs = reportSignatures.get(caseId) || {};
      let names = [];
      try { names = fs.readdirSync(dir).filter(x => /\.(docx|md)$/i.test(x) && !x.startsWith(".")); } catch (e) {}
      const reports = names.map(name => {
        const rel = "reports/" + name;
        const f = fileOf(caseId, rel);
        const abs = vaultPath(caseId, rel);
        let bytes = f.bytes || 0, sha = f.sha, version = f.version, generatedAt = "";
        try {
          const st = fs.statSync(abs); bytes = st.size; generatedAt = st.mtime.toISOString();
          if (!sha) sha = sha256(fs.readFileSync(abs));
          if (!version) version = 1;
        } catch (e) {}
        const agent = name.replace(/-report\.(docx|md)$/i, "").replace(/\.(docx|md)$/i, "");
        if (/final-report\.docx$/i.test(name)) {
          try { version = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || version; } catch (e) {}
        }
        let sig = sigs[rel] || null;
        if (sig && sig.sha && sha && sig.sha !== sha) sig = null;
        if (sig && (sig.version || 1) !== version) sig = null; // 版本不一致的旧签名失效
        return { path: rel, name, agent, type: /\.docx$/i.test(name) ? "docx" : "md",
          version, sha, bytes, generatedAt, signed: sig };
      }).filter(x => x.type === "docx").sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { reports });
    }
    if (p === "/api/report/unsign" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const rel = safeRel(b.path || "");
      const all = reportSignatures.get(caseId) || {};
      delete all[rel]; reportSignatures.set(caseId, all);
      emit("report.unsigned", b.by || "you", { case: caseId, path: rel });
      const cycU = cycles.get(caseId) || {};
      if (cycU.status === "signed") cycles.set(caseId, Object.assign({}, cycU, { status: "awaiting_review", signedAt: null }));
      return json(res, 200, { ok: true, path: rel });
    }
    if (p === "/api/report/pack" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const r = await runNode([path.join(ROOT, "scripts/build-committee-pack.js"), "--case", caseId], process.env, 60000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (!j || !j.ok) return json(res, 500, { error: "材料包生成失败：" + String((j && j.error) || r.err || "").slice(0, 300) });
      emit("report.pack", b.by || "you", { case: caseId, out: j.out });
      return json(res, 200, j);
    }
    if (p === "/api/report/verify" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const r = await runNode([path.join(ROOT, "scripts/verify-report.js"), "--case", caseId,
        "--path", u.searchParams.get("path") || FINAL_REPORT], process.env, 30000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim()); } catch (e) {}
      return json(res, j && j.ok ? 200 : 409, j || { error: "verify failed", stderr: String(r.err || "").slice(0, 300) });
    }
    if (p === "/api/report/sign" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const rel = safeRel(b.path || "");
      if (!rel || !/\.docx$/i.test(rel)) return json(res, 400, { error: "只支持签发 .docx 报告" });
      if (!/final/i.test(rel)) return json(res, 400, { error: "只能签发最终报告（final-report.docx）" });
      const abs = vaultPath(caseId, rel);
      if (!fs.existsSync(abs)) return json(res, 404, { error: "报告不存在" });
      const cons = reportConsistency(caseId);
      if (cons.stale && b.force !== true) {
        return json(res, 409, { error: "数据已更新，报告需重建后再签发", stale: true,
          mismatches: cons.mismatches || [] });
      }
      // 数据新鲜度门禁：过期序列必须人工确认原因后才能签发。
      const fresh = reportFreshness(caseId);
      const staleItems = fresh.items.filter(x => x.stale);
      if (staleItems.length && b.acceptStale !== true) {
        return json(res, 409, { error: "报告含过期数据，需确认原因后才能签发", code: "data_stale",
          staleItems: staleItems.map(x => ({ indicator: x.indicator, metricId: x.metricId,
            dataAsOf: x.dataAsOf, reason: x.reason, evidenceId: x.evidenceId })) });
      }
      if (staleItems.length && !String(b.reason || "").trim()) {
        return json(res, 400, { error: "接受过期数据需要填写 reason（为什么仍可签发）", code: "data_stale_reason_required" });
      }
      const regLic = loadDataRegistry();
      const licenseBlocked = fresh.items.filter(x => {
        const sid = x.sourceId || "";
        if (!sid) return false;
        const s = regLic.sources.find(z => z.id === sid || z.configSource === sid);
        return !!(s && s.license && s.license.reportUse === false);
      });
      if (licenseBlocked.length && b.acceptLicense !== true) {
        return json(res, 409, { error: "报告含不允许对外使用的数据源，需确认或替换", code: "license_blocked",
          sources: licenseBlocked.map(x => ({ indicator: x.indicator, sourceId: x.sourceId })) });
      }
      const f = fileOf(caseId, rel);
      let signVersion = f.version || 1;
      if (/final/i.test(rel)) {
        const list = reviews.get(caseId) || [];
        // manifest 是最终报告的版本真相源；fileOf 在脚本直接写文件后可能仍是旧版本。
        let curVer = 0;
        try { curVer = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 0; } catch (e) {}
        curVer = curVer || f.version || 1;
        signVersion = curVer;
        const blockers = ["audit", "legal"].map(service => {
          const r = list.filter(x => x.service === service && x.path === rel && x.version === curVer)
            .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0];
          if (!r) return { service, status: "missing" };
          if (r.status === "clean" || r.status === "waived") return null;
          return { service, status: r.status, id: r.id };
        }).filter(Boolean);
        if (blockers.length) return json(res, 409, { error: "签发前需完成审计/法务复核", blockers });
      }
      let signSha = f.sha || ""; try { signSha = signSha || sha256(fs.readFileSync(abs)); } catch (e) {}
      const sig = { by: b.by || "you", at: new Date().toISOString(), version: signVersion, sha: signSha,
        dataFreshness: { stale: staleItems.length, accepted: staleItems.length > 0, reason: staleItems.length ? String(b.reason || "") : "" } };
      const all = reportSignatures.get(caseId) || {};
      all[rel] = sig; reportSignatures.set(caseId, all);
      try {
        let mv = 1; try { mv = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 1; } catch (e) { mv = 1; }
        fs.writeFileSync(vaultPath(caseId, "reports/final-signature.json"),
          JSON.stringify(Object.assign({ path: rel, manifestVersion: mv }, sig), null, 2));
      } catch (e) {}
      emit("report.signed", b.by || "you", { case: caseId, path: rel, v: f.version, signature: sig,
        dataStaleAccepted: staleItems.length > 0 });
      if (staleItems.length) emit("report.sign.stale_accepted", b.by || "you", { case: caseId, path: rel,
        reason: String(b.reason || ""), items: staleItems.map(x => ({ indicator: x.indicator, dataAsOf: x.dataAsOf })) });
      const cycS = cycles.get(caseId) || {};
      cycles.set(caseId, Object.assign({}, cycS, { status: "signed", signedAt: new Date().toISOString(), signedPath: rel }));
      emit("cycle.signed", b.by || "you", { case: caseId, path: rel, v: signVersion });
      return json(res, 200, { ok: true, path: rel, signature: sig });
    }
    if (p === "/api/report/macro" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const ex = await runProcess([path.join(ROOT, "scripts/macro_report.js")],
        Object.assign({}, process.env, { DESK_CASE: caseId, DESK_ACTOR: "you",
          DESK_BROKER: "http://127.0.0.1:" + PORT }), 60000);
      let j = null; try { j = JSON.parse(String(ex.stdout || "").trim()); } catch (e) {}
      if (!j || (!j.ok && !j.docx)) return json(res, 400, { error: (j && j.error) || String(ex.stderr || "").slice(0, 300) });
      let tone = null;
      if (b.tone !== false && j.docx) {
        try {
          const docxPath = fs.existsSync(path.resolve(ROOT, j.docx)) ? path.resolve(ROOT, j.docx) : vaultPath(caseId, j.docx);
          const bak = path.join(ROOT, "runtime/backups", "macro-report.docx.bak");
          fs.mkdirSync(path.dirname(bak), { recursive: true });
          if (fs.existsSync(docxPath) && !fs.existsSync(bak)) fs.copyFileSync(docxPath, bak);
          const tr = await runPython([path.join(ROOT, "scripts/tone-docx.py"), "--docx", docxPath, "--out", docxPath],
            Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }), 60000);
          let tj = null; try { tj = JSON.parse(String(tr.stdout || "").trim()); } catch (e) {}
          if (tj && tj.ok) {
            tone = tj;
            fs.writeFileSync(path.join(ROOT, "vault", caseId, "reports", "macro-tone.json"), JSON.stringify(tj, null, 2));
          }
        } catch (e) { tone = { error: String(e && e.message || e) }; }
      }
      emit("report.assembled", "you", { case: caseId, path: j.out, version: j.version, type: "macro", tone: !!tone });
      return json(res, 200, Object.assign({}, j, { tone }));
    }
    if (p === "/api/need/bind" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const planId = String(b.planId || "");
      const plan = (plans.get(caseId) || []).find(x => x.id === planId);
      if (!plan) return json(res, 404, { error: "no such plan" });
      n.planId = planId; n.stepId = String(b.stepId || "");
      n.blocking = b.blocking !== false;
      if (n.blocking && n.status === "pending") {
        plan.blockedOnNeed = plan.blockedOnNeed || [];
        if (plan.blockedOnNeed.indexOf(n.id) < 0) plan.blockedOnNeed.push(n.id);
        emit("plan.blocked", b.by || "you", { case: caseId, planId, needId: n.id, stepId: n.stepId });
      } else {
        plan.blockedOnNeed = (plan.blockedOnNeed || []).filter(x => x !== n.id);
      }
      emit("need.bound", b.by || "you", { case: caseId, needId: n.id, planId, stepId: n.stepId,
        blocking: n.blocking });
      return json(res, 200, { need: n, plan });
    }
    if (p === "/api/need/rebuild-answer" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const p = needItemProgress(n);
      const lines = ((n.spec && n.spec.items) || []).map((it, i) =>
        (i + 1) + ". " + (it.indicator || "") + "：" + (it.value || "") +
        (it.file ? "（文件 " + it.file + "）" : "") + (it.source ? " 来源：" + it.source : ""));
      n.answer = (p.done >= p.total ? "已逐项补齐 " : "部分补齐 ") + p.done + "/" + p.total + " 个指标：\n" + lines.join("\n");
      n.status = (p.total && p.done >= p.total) ? "answered" : (p.done ? "partial" : "pending");
      if (n.status !== "answered") { delete n.answeredAt; delete n.answeredBy; }
      emit("need.updated", b.by || "you", { case: caseId, needId: n.id, agent: n.agent,
        title: n.title, detail: n.detail, spec: n.spec, answer: n.answer });
      return json(res, 200, { need: n });
    }
    if (p === "/api/need/waive" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      const items = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const missing = items.filter(i => i.status !== "provided").map(i => i.indicator).filter(Boolean);
      n.status = "waived";
      n.waived = true;
      n.waiveReason = String(b.reason || "部分数据无法补齐").slice(0, 1000);
      n.answer = "部分数据未提供（已豁免）：" + n.waiveReason +
        (missing.length ? "；缺失：" + missing.slice(0, 8).join("、") : "");
      n.answeredAt = new Date().toISOString(); n.answeredBy = b.by || "you";
      if (n.planId) {
        const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
        if (p && Array.isArray(p.blockedOnNeed)) {
          p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
          if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
        }
      }
      emit("need.waived", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
        kind: n.kind, title: n.title, reason: n.waiveReason, missing, planId: n.planId });
      invalidateCompletionNeed(caseId, n.id);
      markReportStale(caseId, "缺口豁免：" + n.id, n.id);
      try { resumeApprovedPlans(caseId, "need-waived"); } catch (e) {}
      return json(res, 200, { need: n, missing });
    }
    if (p === "/api/need/update" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      if (typeof b.title === "string" && b.title.trim()) n.title = b.title.trim().slice(0, 300);
      if (typeof b.detail === "string") n.detail = b.detail.slice(0, 4000);
      if (typeof b.blocking === "boolean") n.blocking = b.blocking;
      if (typeof b.kind === "string" && ["data","skill","info","plugin","permission","other"].indexOf(b.kind) >= 0) n.kind = b.kind;
      if (b.spec && typeof b.spec === "object") n.spec = b.spec;
      n.indicatorIds = canonicalNeedIds(n);
      emit("need.updated", b.by || "system", { case: caseId, needId: n.id, agent: n.agent,
        title: n.title, detail: n.detail, spec: n.spec || null, indicatorIds: n.indicatorIds,
        kind: n.kind, blocking: n.blocking });
      return json(res, 200, { need: n });
    }
    if (p === "/api/need/answer" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = needs.get(caseId) || [];
      const n = list.find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      if (n.status === "answered") return json(res, 200, { need: n, unchanged: true });
      // 结构化审批：approve/reject 是确定性字段，不再从自然语言猜。
      const decision = ["approve", "reject"].indexOf(b.decision) >= 0 ? b.decision : "";
      if (decision) {
        n.status = "answered"; n.waived = false;
        n.decision = decision;
        n.answer = String(b.answer || (decision === "approve" ? "批准" : "拒绝")).slice(0, 4000);
        n.answeredAt = new Date().toISOString();
        n.answeredBy = b.by || "you";
        n.decidedAt = n.answeredAt; n.decidedBy = n.answeredBy;
        if (n.planId) {
          const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
          if (p && Array.isArray(p.blockedOnNeed)) {
            p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
            if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
          }
        }
        emit("need.decided", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
          kind: n.kind, title: n.title, decision, answer: n.answer.slice(0, 500), planId: n.planId });
        emit("need.answered", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
          kind: n.kind, title: n.title, answer: n.answer.slice(0, 500), planId: n.planId, decision });
        invalidateCompletionNeed(caseId, n.id);
        return json(res, 200, { need: n, decided: true, decision });
      }
      // 显式豁免：说明框写“无法补充”并选择结束缺口时走这里，保证选项真正消失。
      if (b.waive === true) {
        const itemsW = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
        const missingW = itemsW.filter(i => i.status !== "provided").map(i => i.indicator).filter(Boolean);
        n.status = "waived"; n.waived = true;
        n.waiveReason = String(b.reason || b.answer || "无法补充").slice(0, 1000);
        n.answer = "无法补充（已结束缺口）：" + n.waiveReason +
          (missingW.length ? "；未补齐：" + missingW.slice(0, 10).join("、") : "");
        n.answeredAt = new Date().toISOString(); n.answeredBy = b.by || "you";
        if (n.planId) {
          const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
          if (p && Array.isArray(p.blockedOnNeed)) {
            p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
            if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
          }
        }
        emit("need.waived", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
          kind: n.kind, title: n.title, reason: n.waiveReason, missing: missingW, planId: n.planId });
        markReportStale(caseId, "缺口豁免：" + n.id, n.id);
        return json(res, 200, { need: n, answered: true, waived: true, missing: missingW });
      }
      const items0 = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
      const provided0 = items0.filter(i => i.status === "provided").length;
      if (items0.length && provided0 < items0.length) {
        if (b.forcePartial !== true) {
          n.status = "partial";
          n.partialAnswer = String(b.answer || "").slice(0, 4000);
          n.providedCount = provided0; n.totalCount = items0.length;
          emit("need.partial", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
            kind: n.kind, title: n.title, answer: n.partialAnswer.slice(0, 500),
            provided: provided0, total: items0.length });
          markReportStale(caseId, "缺口部分答复：" + n.id, n.id);
          return json(res, 200, { need: n, partial: true, provided: provided0, total: items0.length,
            missing: items0.filter(i => i.status !== "provided").map(i => i.indicator).filter(Boolean),
            requiresDecision: true, nextActions: ["provide", "waive"] });
        }
        // 用户二次确认：接受部分数据，关闭缺口并继续工作流
        const missing = items0.filter(i => i.status !== "provided").map(i => i.indicator).filter(Boolean);
        n.status = "answered"; n.partial = true;
        n.providedCount = provided0; n.totalCount = items0.length;
        n.answer = "部分数据已提交（" + provided0 + "/" + items0.length + "）：" +
          String(b.answer || "").slice(0, 3000) +
          (missing.length ? "\n未补齐：" + missing.slice(0, 10).join("、") : "");
        n.answeredAt = new Date().toISOString(); n.answeredBy = b.by || "you";
        if (n.planId) {
          const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
          if (p && Array.isArray(p.blockedOnNeed)) {
            p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
            if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
          }
        }
        emit("need.answered", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
          kind: n.kind, title: n.title, answer: n.answer.slice(0, 500), planId: n.planId,
          partial: true, provided: provided0, total: items0.length, missing });
        markReportStale(caseId, "缺口答复：" + n.id, n.id);
        return json(res, 200, { need: n, answered: true, partial: true, provided: provided0, total: items0.length });
      }
      n.status = "answered";
      n.answer = String(b.answer || "").slice(0, 4000);
      n.answeredAt = new Date().toISOString();
      n.answeredBy = b.by || "you";
      if (n.planId) {
        const p = (plans.get(caseId) || []).find(x => x.id === n.planId);
        if (p && Array.isArray(p.blockedOnNeed)) {
          p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== n.id);
          if (!p.blockedOnNeed.length) emit("plan.unblocked", b.by || "you", { case: caseId, planId: p.id, needId: n.id });
        }
      }
      emit("need.answered", b.by || "you", { case: caseId, agent: n.agent, needId: n.id,
        kind: n.kind, title: n.title, answer: n.answer.slice(0, 500), planId: n.planId });
      markReportStale(caseId, "缺口答复：" + n.id, n.id);
      return json(res, 200, { need: n });
    }
    if (p === "/api/need/consume" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const n = (needs.get(caseId) || []).find(x => x.id === b.id);
      if (!n) return json(res, 404, { error: "no such need" });
      if (n.status !== "answered") return json(res, 409, { error: "need not answered", status: n.status });
      if (n.consumedAt) return json(res, 200, { need: n, already: true });
      n.consumedAt = new Date().toISOString(); n.consumedBy = b.by || "lead";
      emit("need.consumed", b.by || "lead", { case: caseId, needId: n.id, title: n.title,
        decision: n.decision || "", consumedAt: n.consumedAt });
      return json(res, 200, { need: n, consumed: true });
    }

    /* --- 用户上传文件（监督者直接放进 vault，不走员工锁队列；资料可达 40MB） --- */
    if (p === "/api/upload" && req.method === "POST") {
      const b = await readBody(req, 120e6);
      const caseId = b.case || "default";
      const rel = safeRel(b.path);
      if (!rel) return json(res, 400, { error: "bad path" });
      if (b.contentBase64 === undefined) return json(res, 400, { error: "contentBase64 required" });
      let buf;
      try { buf = Buffer.from(String(b.contentBase64), "base64"); } catch (_) { return json(res, 400, { error: "bad base64" }); }
      const f = fileOf(caseId, rel);
      const abs = vaultPath(caseId, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      f.version += 1; f.sha = sha256(buf); f.writes += 1; f.lastWriteAt = new Date().toISOString();
      const hpath = path.join(HISTORY, caseId, rel.replace(/\//g, "__") + ".v" + f.version + "." + f.sha.slice(0, 8));
      fs.mkdirSync(path.dirname(hpath), { recursive: true });
      fs.writeFileSync(hpath, buf);
      S.stats.writes += 1;
      emit("file.uploaded", b.by || "you", { case: caseId, path: rel, v: f.version,
        sha: f.sha, bytes: buf.length, name: b.name || path.basename(rel) });
      return json(res, 200, { path: rel, version: f.version, sha: f.sha, bytes: buf.length });
    }

    /* --- 通用事件（员工进程上报 run 生命周期） --- */
    if (p === "/api/event" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      if (!b.type) return json(res, 400, { error: "type required" });
      if (!/^[a-z][a-z0-9._-]*$/i.test(b.type)) return json(res, 400, { error: "bad type" });
      const actor = b.actor || "system";
      const payload = Object.assign({}, b);
      delete payload.type; delete payload.actor;
      payload.case = caseId;
      emit(b.type, actor, payload);
      if (b.type === "agent.run.finished" || b.type === "agent.run.failed") runs.delete(actor);
      if (b.type === "agent.usage") {
        const u = usageOf(caseId);
        const a = u[b.agent] = u[b.agent] || { input: 0, output: 0, cacheRead: 0, total: 0, runs: 0, lastMs: 0 };
        a.input += b.inputTokens || 0; a.output += b.outputTokens || 0;
        a.cacheRead += b.cacheReadTokens || 0; a.total += b.totalTokens || 0;
        a.runs += 1; a.lastMs = b.ms || 0;
      }
      if (b.type === "cycle.started") {
        cycles.set(caseId, Object.assign({}, cycles.get(caseId) || {}, { status: "running",
          startedAt: new Date().toISOString() }));
      }
      if (b.type === "cycle.completed") {
        cycles.set(caseId, Object.assign({}, cycles.get(caseId) || {}, { status: "awaiting_review" }));
      }
      return json(res, 200, { ok: true, seq: S.seq });
    }

    /* --- 全文索引检索：返回 路径+版本+摘要，员工不必把整份文件读进上下文 --- */
    if (p === "/api/search" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const q = String(u.searchParams.get("q") || "").trim();
      const limit = Math.min(20, parseInt(u.searchParams.get("limit") || "8", 10) || 8);
      if (!q) return json(res, 400, { error: "q required" });
      const dir = path.join(VAULT, caseId);
      const files = [];
      (function walk(d, base) {
        if (!fs.existsSync(d)) return;
        fs.readdirSync(d).forEach(name => {
          const abs = path.join(d, name), rel = base ? base + "/" + name : name;
          const st = fs.statSync(abs);
          if (st.isDirectory()) { if (name !== "history" && name !== "_trash") walk(abs, rel); return; }
          if (!/\.(md|json|jsonl|csv|txt)$/i.test(name)) return;
          files.push({ rel, abs, mtime: st.mtimeMs, size: st.size });
        });
      })(dir, "");
      const sig = files.map(f => f.rel + ":" + f.mtime + ":" + f.size).join("|");
      let cache = INDEX_CACHE.get(caseId);
      if (!cache || cache.sig !== sig) {
        const docs = files.map(f => {
          let text = "";
          try { text = fs.readFileSync(f.abs, "utf8"); } catch (_) {}
          const snip = text.replace(/\s+/g, " ").slice(0, 600);
          return { path: f.rel, version: fileOf(caseId, f.rel).version, text: text, snippet: snip };
        });
        cache = { sig, docs };
        INDEX_CACHE.set(caseId, cache);
      }
      // 关键词：拉丁词 + 中文二元组；命中数打分，返回摘要而不是全文
      const terms = [];
      String(q).toLowerCase().replace(/[a-z0-9_]+/g, s => { terms.push(s); return s; });
      const cjk = String(q).replace(/[^\u4e00-\u9fa5]/g, "");
      for (let i = 0; i < cjk.length - 1; i++) terms.push(cjk.slice(i, i + 2));
      if (!terms.length) terms.push(String(q).toLowerCase());
      const hits = cache.docs.map(d => {
        const low = d.text.toLowerCase();
        let score = 0;
        terms.forEach(t => { if (!t) return; let i = low.indexOf(t); while (i >= 0) { score += 1; i = low.indexOf(t, i + t.length); } });
        if (low.indexOf(String(q).toLowerCase()) >= 0) score += 5;
        return { path: d.path, version: d.version, score, snippet: d.snippet };
      }).filter(h => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
      return json(res, 200, { case: caseId, q, hits, indexed: cache.docs.length });
    }

    /* --- 员工知识库（LLM Wiki）：每个员工一个库，页面 = markdown + frontmatter + 链接 --- */
    if (p === "/api/kb/put" && req.method === "POST") {
      const b = await readBody(req);
      const agent = String(b.agent || "agent").replace(/[^a-z0-9_-]/gi, "");
      if (!agent) return json(res, 400, { error: "agent required" });
      if (!b.title || !b.body) return json(res, 400, { error: "title and body required" });
      fs.mkdirSync(path.join(KB_ROOT, agent), { recursive: true });
      const idxPath = path.join(KB_ROOT, agent, "index.json");
      let idx = { agent, pages: [] };
      if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, "utf8")); } catch (_) {} }
      let slug = String(b.slug || b.title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      if (!slug) slug = "page";
      const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? String(b.tags).split(",").map(s => s.trim()).filter(Boolean) : []);
      const sources = Array.isArray(b.sources) ? b.sources : (b.sources ? [String(b.sources)] : []);
      const links = Array.isArray(b.links) ? b.links : (b.links ? [String(b.links)] : []);
      const now = new Date().toISOString();
      const old = idx.pages.filter(x => x.slug === slug)[0];
      const fm = ["---", "title: " + JSON.stringify(b.title), "agent: " + agent,
        "tags: " + JSON.stringify(tags), "sources: " + JSON.stringify(sources),
        "links: " + JSON.stringify(links), "created: " + (old ? old.created : now),
        "updated: " + now, "---", ""].join("\n");
      fs.writeFileSync(path.join(KB_ROOT, agent, slug + ".md"), fm + String(b.body));
      const page = { slug, title: String(b.title), tags, sources, links, created: old ? old.created : now,
        updated: now, bytes: Buffer.byteLength(String(b.body)), snippet: String(b.body).replace(/\s+/g, " ").slice(0, 180) };
      idx.pages = idx.pages.filter(x => x.slug !== slug).concat([page]);
      idx.updated = now;
      fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));
      emit("kb.page.saved", agent, { case: b.case || "default", agent, slug, title: page.title, tags });
      return json(res, 200, { page });
    }
    if (p === "/api/kb/list" && req.method === "GET") {
      const agent = (u.searchParams.get("agent") || "").replace(/[^a-z0-9_-]/gi, "");
      const idxPath = path.join(KB_ROOT, agent, "index.json");
      const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, "utf8")) : { pages: [] };
      return json(res, 200, { agent, pages: idx.pages.slice().sort((a, b2) => a.updated < b2.updated ? 1 : -1) });
    }
    if (p === "/api/kb/search" && req.method === "GET") {
      const agent = (u.searchParams.get("agent") || "").replace(/[^a-z0-9_-]/gi, "");
      const q = String(u.searchParams.get("q") || "").toLowerCase();
      const idxPath = path.join(KB_ROOT, agent, "index.json");
      const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, "utf8")) : { pages: [] };
      const hits = idx.pages.filter(pg => !q || (pg.title + " " + (pg.tags || []).join(" ") + " " +
        (pg.snippet || "")).toLowerCase().indexOf(q) >= 0).slice(0, 10);
      return json(res, 200, { agent, q, hits });
    }
    if (p === "/api/kb/page" && req.method === "GET") {
      const agent = (u.searchParams.get("agent") || "").replace(/[^a-z0-9_-]/gi, "");
      const slug = String(u.searchParams.get("slug") || "").replace(/[^a-z0-9\u4e00-\u9fa5_-]/gi, "");
      const f = path.join(KB_ROOT, agent, slug + ".md");
      if (!fs.existsSync(f)) return json(res, 404, { error: "no such page" });
      return json(res, 200, { agent, slug, content: fs.readFileSync(f, "utf8") });
    }
    if (p === "/api/kb/counts" && req.method === "GET") {
      const out = {};
      CONFIG.agents.map(a => a.id).forEach(a => {
        const idxPath = path.join(KB_ROOT, a, "index.json");
        try { out[a] = JSON.parse(fs.readFileSync(idxPath, "utf8")).pages.length; } catch (_) { out[a] = 0; }
      });
      return json(res, 200, { counts: out });
    }

    /* --- 复核服务：请求 → 结论（绑版本）→ 失效/豁免，结束由结算规则判定 --- */
    if (p === "/api/review/request" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const service = b.service === "legal" ? "legal" : "audit";
      const rel = safeRel(b.path);
      if (!rel) return json(res, 400, { error: "path required" });
      const ver = fileOf(caseId, rel).version;
      if (!(ver > 0)) return json(res, 409, { error: "产物还不是 v1，不能发起复核", path: rel });
      if (!reviews.has(caseId)) reviews.set(caseId, []);
      const list = reviews.get(caseId);
      const dup = list.filter(r => r.service === service && r.path === rel && r.version === ver &&
        r.status !== "waived")[0];
      if (dup) return json(res, 200, { review: dup, reused: true });
      const round = list.filter(r => r.service === service && r.path === rel).length + 1;
      reviewSeq += 1;
      const rv = { id: "R" + reviewSeq, case: caseId, service, path: rel, version: ver, round,
        status: "requested", requester: b.requester || "lead", criteria: String(b.criteria || "").slice(0, 800),
        findings: [], createdAt: new Date().toISOString(), finishedAt: null,
        note: "", waivedBy: null };
      list.push(rv);
      emit("review.requested", rv.requester, { case: caseId, reviewId: rv.id, service, path: rel,
        version: ver, round });
      return json(res, 200, { review: rv });
    }
function syncFinalManifestReviews(caseId) {
  try {
    const p0 = vaultPath(caseId, "reports/final-manifest.json");
    const m = JSON.parse(fs.readFileSync(p0, "utf8"));
    m.reviews = (reviews.get(caseId) || []).filter(r => r.path === FINAL_REPORT && (r.service === "audit" || r.service === "legal"))
      .map(r => ({ id: r.id, service: r.service, version: r.version, status: r.status, result: r.result || "", note: r.note || "" }));
    fs.writeFileSync(p0, JSON.stringify(m, null, 2));
  } catch (e) {}
}
    if (p === "/api/review/verdict" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = reviews.get(caseId) || [];
      const rv = list.find(r => r.id === b.id);
      if (!rv) return json(res, 404, { error: "no such review" });
      if (rv.status === "waived") return json(res, 409, { error: "已被监督者豁免，不用再出结论" });
      const result = ["pass", "conditional", "fail"].indexOf(b.result) >= 0 ? b.result : "fail";
      rv.status = result === "pass" ? "clean" : (result === "conditional" ? "conditional" : "returned");
      rv.result = result;
      rv.findings = Array.isArray(b.findings) ? b.findings.slice(0, 80)
        : (b.findings ? [String(b.findings)] : []);
      rv.note = String(b.note || "").slice(0, 1000);
      rv.finishedAt = new Date().toISOString();
      emit("review.verdict", b.agent || rv.service, { case: caseId, reviewId: rv.id, service: rv.service,
        path: rv.path, version: rv.version, round: rv.round, result, findings: rv.findings.length });
      syncFinalManifestReviews(caseId);
      return json(res, 200, { review: rv });
    }
    if (p === "/api/review/waive" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = reviews.get(caseId) || [];
      const rv = list.find(r => r.id === b.id);
      if (!rv) return json(res, 404, { error: "no such review" });
      rv.status = "waived";
      rv.waivedBy = b.by || "you";
      rv.note = String(b.note || "监督者接受风险").slice(0, 500);
      rv.finishedAt = new Date().toISOString();
      emit("review.waived", rv.waivedBy, { case: caseId, reviewId: rv.id, service: rv.service,
        path: rv.path, version: rv.version, note: rv.note });
      syncFinalManifestReviews(caseId);
      return json(res, 200, { review: rv });
    }
    if (p === "/api/review/opinion" && req.method === "POST") {
      const b = await readBody(req); const caseId = b.case || "default";
      const r = await runNode([path.join(ROOT, "scripts/review-opinion.js"), "--case", caseId, "--service", String(b.service || "audit")], process.env, 130000);
      let j = null; try { j = JSON.parse(String(r.out || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
      if (j && j.ok) {
        const svc = String(b.service || "audit");
        const rv = (reviews.get(caseId) || []).filter(x => x.service === svc && x.path === FINAL_REPORT).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
        if (rv) { rv.findings = (rv.findings || []).concat((j.findings || []).map(f => ({ level: f.level || "warn", text: f.text || "" }))); rv.note = (rv.note || "") + "；独立意见已生成"; }
      }
      return json(res, 200, j || { ok: false, findings: [] });
    }
    if (p === "/api/reviews" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const list = reviews.get(caseId) || [];
      // 结算：产物升版后，旧版本的结论自动 stale（失效），需要重新发起复核
      let manifestVersion = 0;
      try { manifestVersion = JSON.parse(fs.readFileSync(vaultPath(caseId, "reports/final-manifest.json"), "utf8")).version || 0; } catch (e) {}
      const shown = list.map(r => {
        const isFinal = /final-report\.docx$/i.test(r.path);
        const cur = isFinal && manifestVersion ? manifestVersion : fileOf(caseId, r.path).version;
        const stale = r.version !== cur && r.status !== "waived";
        return Object.assign({}, r, { stale, currentVersion: cur,
          findings: (r.findings && r.findings.length) ? r.findings : reviewFindings(caseId, r.service),
          status: stale ? "stale" : r.status });
      });
      const cnt = { pending: 0, clean: 0, conditional: 0, returned: 0, stale: 0, waived: 0 };
      shown.forEach(r => { if (cnt[r.status] !== undefined) cnt[r.status] += 1; });
      return json(res, 200, { reviews: shown, counts: cnt });
    }
    if (p === "/api/cycle/readiness" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, readinessOf(caseId));
    }

    /* --- 一轮研究流程的生命周期：跑完就停在"等你看"，绝不自动进入下一轮 --- */
    if (p === "/api/cycle" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const c = cycles.get(caseId) || { status: "idle" };
      return json(res, 200, { case: caseId, cycle: c });
    }
    if (p === "/api/cycle/start" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const c = cycles.get(caseId);
      if (c && c.status === "running") return json(res, 409, { error: "这一轮还在跑", cycle: c });
      if (c && (c.status === "awaiting_review" || c.status === "signed") && !b.force) {
        return json(res, 409, { error: "上一轮还没被你确认（看/签发），不会自动开下一轮", cycle: c });
      }
      const args = [path.join(ROOT, "scripts/pipeline.js"), "--case", caseId];
      if (b.force) args.push("--force");
      const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      const cyc = { status: "running", startedAt: new Date().toISOString(), pid: child.pid, summary: null };
      cycles.set(caseId, cyc);
      emit("cycle.started", b.by || "you", { case: caseId, pid: child.pid });
      return json(res, 200, { cycle: cyc });
    }
    if (p === "/api/sign" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const rel = safeRel(b.path || FINAL_REPORT);
      if (!rel) return json(res, 400, { error: "bad path" });
      const f = fileOf(caseId, rel);
      if (!(f.version > 0)) return json(res, 409, { error: "还没有终稿，不能签发" });
      // 签发前检查 G-REPORT：章节/字数/引用/图表/免责/证据池/复核收敛
      // 注意：不能 spawnSync——check-report 会回调本 Broker，会死锁；用异步 spawn
      const chk = await runNode([path.join(ROOT, "scripts/check-report.js"),
        "--case", caseId, "--path", rel, "--write"]);
      let report = null;
      try { report = JSON.parse(String(chk.out || "{}")); } catch (_) {}
      if (!b.force && (!report || !report.pass)) {
        return json(res, 409, { error: "G-REPORT 未通过，不能签发", checks: (report && report.checks) || [],
          hint: "修完再签；确实要带着问题签发请传 force:true（会记 waive 事件）" });
      }
      const partials = (works.get(caseId) || []).filter(w => w.partial && w.planId);
      if (partials.length && !b.force) {
        return json(res, 409, { error: "存在部分完成节点，不能直接签发",
          hint: "补齐数据或确认可接受 partial 后再签发；如确需带 partial 签发，传 force:true 记录豁免",
          partial: partials.map(w => ({ workId: w.id, nodeId: w.nodeId, name: w.name, error: w.error })) });
      }
      if (partials.length && b.force) {
        emit("report.partial.waived", b.by || "you", { case: caseId, path: rel, count: partials.length,
          nodes: partials.map(w => w.nodeId) });
      }
      const c = caseOf(caseId);
      c.gates["G-SIGN::" + rel] = { gate: "G-SIGN", scope: rel, status: "pass",
        note: b.note || "监督者签发", at: new Date().toISOString(), by: b.by || "you" };
      emit("gate.passed", b.by || "you", { case: caseId, gate: "G-SIGN", scope: rel, status: "pass", note: "监督者签发" });
      emit("report.published", b.by || "you", { case: caseId, path: rel, v: f.version, sha: f.sha });
      const cyc = cycles.get(caseId) || { status: "awaiting_review" };
      cycles.set(caseId, Object.assign({}, cyc, { status: "signed", signedAt: new Date().toISOString() }));
      emit("cycle.signed", b.by || "you", { case: caseId, path: rel, v: f.version });
      return json(res, 200, { ok: true, path: rel, version: f.version, cycle: cycles.get(caseId) });
    }
    if (p === "/api/cycle/fail" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const cyc = cycles.get(caseId) || {};
      cycles.set(caseId, Object.assign({}, cyc, { status: "failed", stage: b.stage || "",
        agent: b.agent || "", error: String(b.error || "").slice(0, 800),
        failedAt: new Date().toISOString() }));
      emit("cycle.failed", b.agent || "lead", { case: caseId, stage: b.stage || "",
        agent: b.agent || "", error: String(b.error || "").slice(0, 500) });
      return json(res, 200, { cycle: cycles.get(caseId) });
    }
    if (p === "/api/cycle/retry" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const cyc = cycles.get(caseId) || {};
      if (cyc.status === "running") return json(res, 409, { error: "还在跑，等它结束" });
      const args = [path.join(ROOT, "scripts/pipeline.js"), "--case", caseId, "--force"];
      if (b.agent) args.push("--only", b.agent);
      const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      cycles.set(caseId, { status: "running", startedAt: new Date().toISOString(), pid: child.pid });
      emit("cycle.started", b.by || "you", { case: caseId, pid: child.pid, retry: true, agent: b.agent || null });
      return json(res, 200, { cycle: cycles.get(caseId) });
    }
    if (p === "/api/case/intent" && req.method === "POST") {
      const b = await readBody(req);
      const text = String(b.text || b.mandate || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      return json(res, 200, Object.assign({ ok: true }, caseIntent.parse(text)));
    }
    if (p === "/api/case/mission" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const text = String(b.text || b.mandate || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const r = applyMissionIntent(caseId, text, b.force === true);
      if (!r) return json(res, 409, { error: "mission 未更新（文件不存在或无需更新）" });
      return json(res, 200, Object.assign({ ok: true, case: caseId }, r));
    }
    if (p === "/api/case" && req.method === "POST") {
      const b = await readBody(req);
      // 显示名与内部 ID 分离：新 case 用唯一 hash ID，显示名可重复。
      const displayName = String(b.name || b.case || "").trim().slice(0, 80);
      const safeName = String(b.case || b.name || "").replace(/\s+/g, "").replace(/[^\w.\-\u4e00-\u9fa5]/g, "").slice(0, 40);
      if (!displayName || !safeName) return json(res, 400, { error: "case 名称不能为空" });
      if (safeName === "." || safeName === ".." || safeName.startsWith(".")) return json(res, 400, { error: "case 名称不能以 . 开头" });
      let caseId = safeName;
      const useUnique = b.uniqueId !== false && !!b.name;
      if (useUnique) {
        let salt = 0;
        do { caseId = "c_" + sha256(displayName + "|" + Date.now() + "|" + (++salt)).slice(0, 12); } while (S.cases.has(caseId));
      } else if (S.cases.has(caseId)) return json(res, 409, { error: "case 已存在" });
      // 标的不必在创建时确定；如果只给自然语言，先用 case-intent 规则抽取标的/类型/任务。
      const intentText = String(b.text || b.mandate || "").trim();
      const parsed = intentText ? caseIntent.parse(intentText) : null;
      const ticker = String(b.ticker || (parsed && parsed.ticker) || "").trim().slice(0, 40);
      const name = displayName;
      const kind = String(b.kind || b.type || (parsed && parsed.kind) || "").trim().slice(0, 20);
      const mandate = String(b.mandate || (parsed && parsed.mandate) || intentText || "").trim().slice(0, 500);
      const roles = Array.isArray(b.roles) && b.roles.length ? b.roles : CONFIG.case.roles.slice();
      const targetText = ticker
        ? ticker + (kind ? " · " + kind : "")
        : "待定（创建后通过对话补齐：代码 / 名称 / 类型，如 ETF 510300、行业 白酒）";
      const mandateText = mandate || "待补充（创建后通过与员工对话明确研究范围与目标）";
      const rel = "mission.md";
      const body = ["# mission.md", "", "- case: " + caseId,
        "- 显示名: " + displayName,
        "- 标的: " + targetText,
        "- 标的类型: " + (kind || "待定（个股 / ETF / 行业 / 指数 / 其他）"),
        "- 任务: " + mandateText, "- 参与角色: " + roles.join(" / "),
        "- 受众与用途: " + (b.audience || "内部研究"),
        "- 期限: " + (b.horizon || "6~12 个月"), ""].join("\n");
      const f = fileOf(caseId, rel);
      const abs = vaultPath(caseId, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, "utf8");
      f.version += 1; f.sha = sha256(body); f.writes += 1;
      const hpath = path.join(HISTORY, caseId, rel.replace(/\//g, "__") + ".v" + f.version + "." + f.sha.slice(0, 8));
      fs.mkdirSync(path.dirname(hpath), { recursive: true });
      fs.writeFileSync(hpath, body, "utf8");
      caseOf(caseId);
      caseNames.set(caseId, displayName);
      deletedCases.delete(caseId);
      plans.delete(caseId); works.delete(caseId); tasks.delete(caseId); needs.delete(caseId); reviews.delete(caseId);
      intakes.delete(caseId); usage.delete(caseId);
      Array.from(fanoutGroups.keys()).forEach(k => { if (k.indexOf(caseId + "|") === 0) fanoutGroups.delete(k); });
      Array.from(autoRuns.keys()).forEach(k => { if (k.indexOf(caseId + "|") === 0) autoRuns.delete(k); });
      cycles.set(caseId, { status: "idle" });
      // 新 case = 全新团队：清掉每位员工在这个 case 的会话指针与工作记忆，避免沿用上个 case 的上下文
      try {
        const homeRoot = path.join(ROOT, "runtime/dsh-home");
        const caseDir = String(caseId).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "default";
        AGENT_IDS.forEach(agent => {
          // 新布局：<case>/<agent>/session.json；旧布局：<agent>/session.json（迁移清理）
          try { fs.unlinkSync(path.join(homeRoot, caseDir, agent, "alphadesk-session.json")); } catch (e) {}
          try { fs.unlinkSync(path.join(homeRoot, agent, "alphadesk-session.json")); } catch (e) {}
        });
      } catch (e) {}
      try { fs.rmSync(path.join(ROOT, "runtime/memory", caseId), { recursive: true, force: true }); } catch (e) {}
      emit("case.created", b.by || "you", { case: caseId, ticker, name, kind, mandate, roles });
      return json(res, 200, { case: caseId, name: displayName, mission: rel, version: f.version, roles,
        ticker: ticker || null, kind: kind || null });
    }
    if (p === "/api/case/restore" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "";
      const t = trash.get(caseId);
      if (!t) return json(res, 404, { error: "回收站里没有这个 case" });
      // 用磁盘目录判断"已存在"，不能用 S.cases：快照/账本回放会把 case 注册进内存，
      // 那样即使 vault 里目录已经删掉，也会被误判成"已存在"而恢复不了
      if (fs.existsSync(path.join(VAULT, caseId))) return json(res, 409, { error: "这个 case 已存在，不能恢复覆盖" });
      const from = path.join(VAULT, t.trash), to = path.join(VAULT, caseId);
      if (!fs.existsSync(from)) return json(res, 410, { error: "回收站里的目录已不存在" });
      fs.mkdirSync(path.dirname(to), { recursive: true });
      try { fs.renameSync(from, to); } catch (e) { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
      trash.delete(caseId); deletedCases.delete(caseId); caseOf(caseId);
      emit("case.restored", b.by || "you", { case: caseId });
      return json(res, 200, { ok: true, case: caseId });
    }
    if (p === "/api/trash" && req.method === "GET") {
      const items = Array.from(trash.entries()).map(([id, t]) => ({ case: id, trash: t.trash,
        at: t.at, files: t.files, exists: fs.existsSync(path.join(VAULT, t.trash)) }));
      return json(res, 200, { items });
    }
    if (p === "/api/trash/purge" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "";
      const t = trash.get(caseId);
      if (!t) return json(res, 404, { error: "回收站里没有这个 case" });
      if (!b.confirm) return json(res, 400, { error: "需要 confirm:true" });
      const abs = path.join(VAULT, t.trash);
      if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
      trash.delete(caseId);
      emit("trash.purged", b.by || "you", { case: caseId, trash: t.trash });
      return json(res, 200, { ok: true, case: caseId });
    }
    if (p === "/api/case/delete" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "";
      if (!caseId) return json(res, 400, { error: "case required" });
      if (caseId === "default") return json(res, 400, { error: "不能删除 default" });
      if (!b.confirm) return json(res, 400, { error: "需要 confirm:true" });
      if (Array.from(runs.values()).some(r => r.case === caseId))
        return json(res, 409, { error: "这个 case 还有员工在跑，等结束再删" });
      const cy = cycles.get(caseId);
      if (cy && cy.status === "running") return json(res, 409, { error: "这个 case 这一轮还在跑" });
      const dir = path.join(VAULT, caseId);
      const existed = fs.existsSync(dir);
      let files = 0;
      S.files.forEach((v, key) => { if (key.indexOf(caseId + "::") === 0) files += 1; });
      let trashRel = null;
      if (existed) {
        trashRel = "_trash/" + caseId + "-" + Date.now();
        fs.mkdirSync(path.dirname(path.join(VAULT, trashRel)), { recursive: true });
        try { fs.renameSync(dir, path.join(VAULT, trashRel)); }
        catch (e) { fs.cpSync(dir, path.join(VAULT, trashRel), { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
        trash.set(caseId, { trash: trashRel, at: new Date().toISOString(), files });
      }
      S.cases.delete(caseId); cycles.delete(caseId); tasks.delete(caseId);
      needs.delete(caseId); reviews.delete(caseId); caseNames.delete(caseId); INDEX_CACHE.delete(caseId);
      plans.delete(caseId); works.delete(caseId); intakes.delete(caseId); usage.delete(caseId);
      Array.from(fanoutGroups.keys()).forEach(k => { if (k.indexOf(caseId + "|") === 0) fanoutGroups.delete(k); });
      Array.from(autoRuns.keys()).forEach(k => { if (k.indexOf(caseId + "|") === 0) autoRuns.delete(k); });
      Array.from(S.files.keys()).forEach(k => { if (k.indexOf(caseId + "::") === 0) S.files.delete(k); });
      deletedCases.add(caseId);
      emit("case.deleted", b.by || "you", { case: caseId, files, existed, trash: trashRel });
      return json(res, 200, { ok: true, case: caseId, removedFiles: files, existed, trash: trashRel,
        hint: "已进回收站，可 POST /api/case/restore 恢复" });
    }
    if (p === "/api/case/rename" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const name = String(b.name || "").trim().slice(0, 80);
      if (!name) return json(res, 400, { error: "name required" });
      caseNames.set(caseId, name);
      emit("case.renamed", b.by || "you", { case: caseId, name });
      return json(res, 200, { case: caseId, name });
    }
    if (p === "/api/usage" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      const uu = usageOf(caseId);
      const total = { input: 0, output: 0, cacheRead: 0, total: 0, runs: 0 };
      Object.keys(uu).forEach(k => { ["input", "output", "cacheRead", "total", "runs"].forEach(f => total[f] += uu[k][f] || 0); });
      return json(res, 200, { case: caseId, agents: uu, total });
    }
    if (p === "/api/cases" && req.method === "GET") {
      const out = Array.from(S.cases.keys()).filter(k => !deletedCases.has(k) &&
        !/^(lead-test|fanout-test|final-case|mission-final|verify-test|case-view|claimtest)/.test(k)).map(k => {
        const c = cycles.get(k) || { status: "idle" };
        let files = 0;
        S.files.forEach((v, key) => { if (key.indexOf(k + "::") === 0 && v.version > 0) files += 1; });
        const uu = usageOf(k);
        let tokens = 0;
        Object.keys(uu).forEach(a => { tokens += uu[a].total || 0; });
        let updated = c.finishedAt || c.startedAt || null;
        if (!updated) {
          try { updated = fs.statSync(path.join(VAULT, k)).mtime.toISOString(); } catch (e) {}
        }
        return { id: k, name: caseNames.get(k) || null, cycle: c.status, files, tokens, updated };
      });
      out.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
      return json(res, 200, { cases: out });
    }
    if (p === "/api/cycle/finish" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const c = cycles.get(caseId) || {};
      const ready = readinessOf(caseId);
      cycles.set(caseId, Object.assign({}, c, { status: ready.ready ? "awaiting_review" : "blocked",
        finishedAt: new Date().toISOString(), summary: b.summary || null, blockers: ready.blockers }));
      emit(ready.ready ? "cycle.completed" : "cycle.blocked", b.agent || "lead",
        { case: caseId, summary: b.summary || null, files: b.files || 0, gates: b.gates || 0,
          blockers: ready.blockers.length });
      return json(res, 200, { cycle: cycles.get(caseId), ready: ready.ready, blockers: ready.blockers });
    }

    /* --- 派活 + 启动这名员工自己的 DSH 会话（独立进程、独立模型） --- */
    if (p === "/api/agent/run" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const agent = b.agent;
      if (!agent || !AGENT_IDS.has(agent)) return json(res, 400, { error: "unknown agent" });
      const task = String(b.task || "").trim();
      if (!task) return json(res, 400, { error: "task required" });
      const cur = runs.get(agent);
      if (cur && Date.now() - cur.startedAt < 30 * 60 * 1000) {
        return json(res, 409, { error: "这位员工已经有一轮在跑", run: cur });
      }
      const child = spawn(process.execPath, [path.join(ROOT, "runtime/agents/employee.js"),
        "--agent", agent, "--case", caseId, "--task", task],
        { cwd: ROOT, detached: true, stdio: "ignore" });
      child.unref();
      const run = { agent, case: caseId, pid: child.pid, task: task.slice(0, 200), startedAt: Date.now() };
      runs.set(agent, run);
      emit("agent.run.dispatched", "you", { case: caseId, agent, pid: child.pid, task: task.slice(0, 200) });
      return json(res, 200, { run });
    }
    if (p === "/api/agent/runs" && req.method === "GET") {
      return json(res, 200, { runs: Array.from(runs.values()) });
    }

    /* --- 能力申请 / 审批 --- */
    if (p === "/api/capability" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      if (!b.agent || !b.skill) return json(res, 400, { error: "agent and skill required" });
      capSeq += 1;
      const cap = { id: "C" + capSeq, case: caseId, agent: b.agent, skill: b.skill,
        reason: b.reason || "", status: "pending", createdAt: new Date().toISOString() };
      if (!caps.has(caseId)) caps.set(caseId, []);
      caps.get(caseId).push(cap);
      emit("capability.requested", b.agent, { case: caseId, agent: b.agent, skill: b.skill,
        reason: cap.reason, requestId: cap.id });
      return json(res, 200, { request: cap });
    }
    if (p === "/api/capabilities" && req.method === "GET") {
      const caseId = u.searchParams.get("case") || "default";
      return json(res, 200, { requests: (caps.get(caseId) || []) });
    }
    if (p === "/api/capability/decide" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const list = caps.get(caseId) || [];
      const cap = list.find(x => x.id === b.id);
      if (!cap) return json(res, 404, { error: "no such request" });
      if (cap.status !== "pending") return json(res, 409, { error: "already decided", status: cap.status });
      if (b.approve) {
        const st = skillsOf(caseId);
        const sk = st.catalog.find(x => x.id === cap.skill);
        if (sk) {
          if (!sk.installed) {
            sk.installed = true;
            emit("skill.installed", "you", { case: caseId, skill: sk.id, name: sk.name, via: "capability" });
          }
          const list = st.byAgent[cap.agent] = st.byAgent[cap.agent] || [];
          if (list.indexOf(sk.id) < 0) {
            list.push(sk.id);
            emit("skill.granted", "you", { case: caseId, agent: cap.agent, skill: sk.id,
              name: sk.name, via: "capability" });
          }
        }
      }
      cap.status = b.approve ? "approved" : "denied";
      cap.decidedAt = new Date().toISOString();
      cap.decidedBy = b.by || "you";
      emit(b.approve ? "capability.approved" : "capability.denied", b.by || "you",
        { case: caseId, agent: cap.agent, skill: cap.skill, requestId: cap.id });
      return json(res, 200, { request: cap });
    }

    /* --- 门禁 --- */
    if (p === "/api/gate" && req.method === "POST") {
      const b = await readBody(req);
      const caseId = b.case || "default";
      const c = caseOf(caseId);
      const status = b.status;
      if (["pass", "fail", "pending"].indexOf(status) < 0) return json(res, 400, { error: "bad status" });
      const scope = b.scope || "case";
      const key = b.gate + "::" + scope;
      c.gates[key] = { gate: b.gate, scope, status, note: b.note || "",
        at: new Date().toISOString(), by: b.actor || "broker" };
      emit(status === "fail" ? "gate.failed" : "gate.passed", b.actor || "broker",
        { case: caseId, gate: b.gate, scope, status, note: b.note || "" });
      return json(res, 200, { gate: b.gate, scope, status });
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("broker error:", err);
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

function vaultPath(caseId, rel) { return path.join(VAULT, caseId, rel); }
// 产出声明常见两种写法："research/x.md §章节" 和 "research/x.md 章节说明"；后者不能被当成完整路径。
function recoveryForWork(w) {
  const kind = String((w && w.failureKind) || "");
  if (kind === "heartbeat_timeout") return { action: "retry", hint: "瞬时心跳/租约问题，可重试一次" };
  if (kind === "wall_timeout") return { action: "split", hint: "任务过大，建议拆分或提高 maxWallMs" };
  if (kind === "artifact_missing") return { action: "contract_fix", hint: "检查 outputs 路径与章节，修契约后重试" };
  if (kind === "citation_missing") return { action: "escalate", hint: "补证据/修引用后再重试" };
  if (kind === "budget_exceeded") return { action: "stop", hint: "预算用尽，需调整预算" };
  return { action: "escalate", hint: "查看错误并人工判断" };
}
function splitSuggestion(w) {
  const outs = Array.isArray(w && w.outputs) ? w.outputs : [];
  if (outs.length < 2) return [{ name: (w && w.name || "任务") + " · 子任务", outputs: outs }];
  const mid = Math.ceil(outs.length / 2);
  return [{ name: (w.name || "任务") + " · 上", outputs: outs.slice(0, mid) },
    { name: (w.name || "任务") + " · 下", outputs: outs.slice(mid) }];
}
function validOutputSpec(o) {
  const raw = String(o || "").trim();
  if (!raw) return false;
  const first = raw.split(/\s+/)[0].replace(/[（(][^）)]*[）)]/g, "").replace(/[§#].*$/, "");
  if (/\/$/.test(first) && first.length > 1) return true;
  return /\.(md|markdown|json|jsonl|csv|tsv|xlsx|xls|pdf|docx|txt|svg|png|jpe?g|gif|webp)$/i.test(first);
}
function outputRel(caseId, o) {
  const raw = String(o || "").trim();
  const clean = s => String(s || "").replace(/[（(][^）)]*[）)]/g, "").trim();
  let rel = clean(raw.split(/\s+§|#/)[0]);
  if (rel && fs.existsSync(vaultPath(caseId, rel))) return rel;
  const first = clean(raw.split(/\s+/)[0]);
  if (first && fs.existsSync(vaultPath(caseId, first))) return first;
  return rel || first;
}
// 缺口闭环状态：auto=后台自动采集，human=需要人，closed=已关闭。
// 队列只把 human 放进“待补数据”，auto 只在后台显示进度，避免把“重试自动采集”混进人工队列。
function activeDataTaskOf(caseId, needId) {
  const list = dataTasks.get(caseId) || [];
  return list.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .find(t => t.needId === needId && ["source_pending", "ready", "parsing", "needs_more", "needs_human", "ready_for_review", "write_failed"].indexOf(t.status) >= 0) || null;
}
function needQueueInfo(n) {
  const items = (n && n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
  const provided = items.filter(i => i.status === "provided").length;
  if (!n) return { queue: "closed", stage: "closed", reason: "" };
  if (n.status === "answered" || n.status === "waived" || n.status === "superseded") {
    return { queue: "closed", stage: "closed", reason: "" };
  }
  const dt = activeDataTaskOf(n.case, n.id);
  if (dt) {
    if (dt.status === "ready_for_review") {
      return { queue: "human", stage: "datatask_review", reason: "数据补齐任务 " + dt.id + " 已通过门禁，等待你确认写入" };
    }
    if (dt.status === "needs_human" || dt.status === "failed" || dt.status === "write_failed") {
      return { queue: "human", stage: "datatask_needs_human", reason: "数据补齐任务 " + dt.id + " 需要人工处理" + (dt.error ? "：" + dt.error : "") };
    }
    if (dt.status === "ready" || dt.status === "source_pending") {
      return { queue: "human", stage: "datatask_ready", reason: "数据补齐任务 " + dt.id + " 待开始/待补来源" };
    }
    if (dt.status === "needs_more") {
      return { queue: "human", stage: "datatask_needs_source", reason: "数据补齐任务 " + dt.id + " 还缺数据，请补充来源或文件" };
    }
    return { queue: "auto", stage: "datatask_running", reason: "数据补齐任务 " + dt.id + " 正在处理" };
  }
  if (Array.isArray(n.conflicts) && n.conflicts.some(c => c.state === "open")) {
    return { queue: "human", stage: "conflict_open", reason: "同一指标存在多来源冲突，需要裁决或豁免" };
  }
  if (Array.isArray(n.parseJobs) && n.parseJobs.some(j => j.status === "queued" || j.status === "running")) {
    return { queue: "auto", stage: "source_parsing", reason: "来源解析中，完成后进入候选确认" };
  }
  if (!items.length) {
    return { queue: "human", stage: "human_required", reason: "该缺口没有结构化指标，需要人工提供" };
  }
  const resolved = items.filter((it, i) => it.status === "provided" || it.status === "waived" ||
    (n.waivedItems || []).some(w => w.index === i)).length;
  if (resolved >= items.length) return { queue: "closed", stage: "closed", reason: "" };
  const unresolved = items.map((it, i) => ({ it, i })).filter(x =>
    x.it.status !== "provided" && x.it.status !== "waived" && !(n.waivedItems || []).some(w => w.index === x.i));
  const pendingMatch = unresolved.map(x => x.it).find(i => i.match && i.match.state === "candidate_pending");
  if (pendingMatch) return { queue: "human", stage: "metric_pending", reason: "指标匹配待确认：" + ((pendingMatch.match.reasons || []).join("；") || "多候选/定义冲突") };
  const draftMatch = unresolved.map(x => x.it).find(i => i.match && i.match.state === "draft");
  if (draftMatch) return { queue: "human", stage: "draft", reason: "指标未注册，需建 draft 或人工确认" };
  const autos = unresolved.map(x => (x.it && x.it.auto) || {});
  if (autos.some(a => a.status === "queued" || a.status === "running")) {
    return { queue: "auto", stage: "auto_running", reason: "自动采集进行中，完成后会自动回填" };
  }
  if (autos.some(a => a.status === "failed")) {
    const a = autos.find(x => x.status === "failed");
    return { queue: "human", stage: "auto_failed", reason: (a && a.reason) || "自动采集重试耗尽，需要人工补充或手动重试" };
  }
  if (autos.some(a => a.status === "needs_review")) {
    const a = autos.find(x => x.status === "needs_review");
    const reason = (a && a.reason) || "数据源已注册但未启用，需要先启用来源";
    return { queue: "human", stage: /数据质量/.test(reason) ? "quality_pending" : "needs_review", reason };
  }
  if (autos.length && autos.every(a => a.status === "no_source")) {
    const a = autos.find(x => x.status === "no_source");
    return { queue: "human", stage: "no_source", reason: (a && a.reason) || "指标注册表未覆盖或无可用数据源，自动采集无法完成" };
  }
  if (autos.some(a => a.status === "done" || a.status === "partial")) {
    const a = autos.find(x => x.status === "partial") || autos.find(x => x.status === "done");
    const suffix = a && a.dataAsOf ? "（数据截至 " + a.dataAsOf + "）" : "";
    return { queue: "human", stage: "human_required", reason: "部分指标已自动采集，仍需人工补齐剩余项" + suffix };
  }
  return { queue: "human", stage: "human_required", reason: "需要人工补充" };
}
/**
 * 报告数据新鲜度：从 need item 的 dataAsOf/auto.quality 汇总，用于 manifest、报告脚注、签发门禁。
 */
function reportFreshness(caseId) {
  let metrics = [];
  try { metrics = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8")).metrics || []; } catch (e) {}
  const items = [];
  for (const n of (needs.get(caseId) || [])) {
    if (!n || n.status === "superseded") continue;
    const its = (n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
    its.forEach(it => {
      if (!it || it.status === "waived") return;
      const dataAsOf = it.dataAsOf || (it.auto && it.auto.dataAsOf) || "";
      if (!dataAsOf) return;
      const metricId = (it.match && it.match.metricId) || (it.auto && it.auto.metric) || "";
      const metric = metrics.find(m => m.id === metricId) || null;
      let stale = false, reason = "";
      if (it.auto && it.auto.quality) { stale = it.auto.quality.fresh === false; reason = it.auto.reason || ""; }
      else if (metric) {
        try {
          const q = dataQuality.check(metric, [{ period: dataAsOf, value: 1, unit: metric.unit || "" }], {});
          stale = !q.fresh; reason = q.staleDetail || "";
        } catch (e) {}
      }
      items.push({ needId: n.id, indicator: it.indicator || "", metricId, dataAsOf,
        stale, reason, evidenceId: it.evidenceId || (it.auto && it.auto.evidenceId) || "",
        status: it.status || "", sourceId: (it.auto && it.auto.sourceId) || "" });
    });
  }
  return { generatedAt: new Date().toISOString(), items, stale: items.filter(x => x.stale) };
}
function ensureNeedV2(n) {
  if (!n.sources) n.sources = [];
  if (!n.parseJobs) n.parseJobs = [];
  if (!n.candidates) n.candidates = [];
  if (!n.conflicts) n.conflicts = [];
  if (!n.waivedItems) n.waivedItems = [];
  return n;
}
function needHasOpenConflict(n) {
  return !!(n && Array.isArray(n.conflicts) && n.conflicts.some(c => c.state === "open"));
}
function needAllResolved(n) {
  const items = (n && n.spec && Array.isArray(n.spec.items)) ? n.spec.items : [];
  if (!items.length) return false;
  if (needHasOpenConflict(n)) return false;
  return items.every((it, i) => it.status === "provided" || it.status === "waived" ||
    (n.waivedItems || []).some(w => w.index === i));
}
function refreshNeedConflict(n, itemIndex) {
  ensureNeedV2(n);
  const accepted = n.candidates.filter(c => c.itemIndex === itemIndex && c.status === "accepted");
  if (accepted.length < 2) return null;
  const sig = new Set(accepted.map(c => String(c.value) + "|" + String(c.unit || "") + "|" + String(c.period || "")));
  if (sig.size < 2) return null;
  const open = n.conflicts.find(c => c.itemIndex === itemIndex && c.state === "open");
  if (open) return open;
  const cf = { id: "CF" + (++conflictSeq), needId: n.id, itemIndex,
    candidateIds: accepted.map(c => c.id), state: "open", createdAt: new Date().toISOString() };
  n.conflicts.push(cf);
  accepted.forEach(c => { c.conflictGroup = cf.id; });
  emit("need.conflict.opened", "system", { case: n.case, needId: n.id, conflictId: cf.id,
    itemIndex, candidateIds: cf.candidateIds });
  return cf;
}
function evidenceSupersededFile(caseId) { return vaultPath(caseId, "evidence/superseded.json"); }
function loadEvidenceSuperseded(caseId) {
  try { return JSON.parse(fs.readFileSync(evidenceSupersededFile(caseId), "utf8")) || {}; } catch (e) { return {}; }
}
function saveEvidenceSuperseded(caseId, map) {
  const f = evidenceSupersededFile(caseId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(map, null, 2));
}
function appendEvidence(caseId, ev) {
  const f = vaultPath(caseId, "evidence/sources.jsonl");
  let max = 0;
  try {
    fs.readFileSync(f, "utf8").split(String.fromCharCode(10)).filter(Boolean).forEach(line => {
      try { const x = JSON.parse(line); const m = String(x.id || "").match(/^S(\d+)$/); if (m) max = Math.max(max, Number(m[1])); } catch (e) {}
    });
  } catch (e) {}
  const rec = Object.assign({ id: "S" + (max + 1), fetched_at: new Date().toISOString() }, ev);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(rec) + String.fromCharCode(10));
  return rec;
}
/**
 * 自动采集证据化：把 data job 的 records 变成一条 S# 证据（含 raw snapshot / sha256 / 数据截至）。
 * 同一 job 只生成一次，避免重试/重复 update 产生重复 S#。
 */
function ensureDataJobEvidence(job) {
  if (!job || job.evidenceId) return job.evidenceId || "";
  if (!Array.isArray(job.records) || !job.records.length) return "";
  let metric = null, source = null;
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
    metric = (mj.metrics || []).find(m => m.id === job.metric) || null;
  } catch (e) {}
  try {
    const sj = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/sources.json"), "utf8"));
    source = (sj.sources || []).find(s => s.id === job.sourceId) || null;
  } catch (e) {}
  const rows = job.records.filter(r => r && r.period !== undefined).slice().sort((a, b) => String(a.period).localeCompare(String(b.period)));
  if (!rows.length) return "";
  const first = String(rows[0].period), last = String(rows[rows.length - 1].period);
  const latest = rows[rows.length - 1];
  let hash = "";
  try {
    if (job.out) {
      const abs = path.resolve(ROOT, job.out);
      if (fs.existsSync(abs)) hash = sha256(fs.readFileSync(abs));
    }
  } catch (e) {}
  if (!hash) { try { hash = sha256(JSON.stringify(rows)); } catch (e) {} }
  const tier = source ? ((source.access && source.access.tier) || source.tier || "") : "";
  const url = job.url || (source && (source.homepage || source.name)) || job.sourceId || "auto-collect";
  const ev = appendEvidence(job.case, {
    url,
    field: (metric ? metric.name : job.metric) + "（" + (job.range || first + ".." + last) + "）",
    value: { metric: job.metric, sourceId: job.sourceId, range: job.range || "",
      first, last, count: rows.length,
      latest: { period: latest.period, value: latest.value, unit: latest.unit || "" } },
    raw: job.out || "",
    note: "自动采集 · " + (source ? source.name : job.sourceId) + " · coverage " + (job.coverage || 0) + "%" +
      (job.dataAsOf ? " · 数据截至 " + job.dataAsOf : "") +
      (job.quality && job.quality.ok === false ? " · 质量门禁未通过：" + (job.quality.issues || []).slice(0, 3).join("；") : "") +
      (job.crossCheck ? " · 多源校验 " + job.crossCheck.status + (job.crossCheck.secondarySource ? "（" + job.crossCheck.secondarySource + "）" : "") : ""),
    source_tier: tier,
    sha256: hash,
    snapshot: job.snapshot ? { id: job.snapshot.id || "", sha256: job.snapshot.sha256 || "",
      out: job.snapshot.out || "", at: job.snapshot.at || "" } : null,
    auto: true,
    jobId: job.id
  });
  job.evidenceId = ev.id;
  job.evidenceSha = hash;
  return ev.id;
}
function pubFile(f) {
  return { path: f.path, version: f.version, sha: f.sha, mode: f.mode, writes: f.writes,
    holders: f.holders.map(h => ({ actor: h.actor, mode: h.mode, lockId: h.id,
      expiresInMs: Math.max(0, h.until - Date.now()) })),
    queue: f.queue.map((w, i) => ({ position: i + 1, actor: w.actor, mode: w.mode })) };
}

/* ---------------------------------------------------------------- 启动：重放账本 */
function reapStaleLoops() {
  const dir = path.join(ROOT, "runtime/agent-loops");
  let reaped = 0;
  try {
    fs.readdirSync(dir).filter(f => f.endsWith(".json")).forEach(f => {
      const file = path.join(dir, f);
      let st = null;
      try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return; }
      if (!st || st.status !== "running") return;
      if (st.pid && pidAlive(st.pid)) return;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (e) { age = 0; }
      if (age < 10 * 60 * 1000) return;
      // 旧 loop 没有 pid 字段：如果对应 WorkItem 仍在跑且 owner 活着，不能误杀。
      if (!st.pid && st.workId) {
        const w = (works.get(st.case || "") || []).find(x => x.id === st.workId);
        const op = w ? parseInt(String(w.owner || "").replace(/^dag-/, ""), 10) : 0;
        if (w && w.state === "running" && op > 0 && pidAlive(op)) return;
      }
      st.status = "failed";
      st.error = "orphan loop: no active process after broker restart";
      st.updatedAt = new Date().toISOString();
      try { fs.writeFileSync(file, JSON.stringify(st, null, 2)); } catch (e) {}
      emit("agent.loop.reaped", "system", { case: st.case || "", loopId: st.id || f.replace(/\.json$/, ""),
        agent: st.agent || "", reason: st.error });
      reaped += 1;
    });
  } catch (e) {}
  if (reaped) console.log("[broker] reaped stale loops=" + reaped);
}
function recoverPlansFromWork() {
  works.forEach((list, caseId) => {
    if (deletedCases.has(caseId)) return;
    const groups = {};
    list.filter(w => w.kind !== "child" && w.planId && ["queued", "running", "cancelling", "failed"].indexOf(w.state) >= 0).forEach(w => {
      (groups[w.planId] = groups[w.planId] || []).push(w);
    });
    Object.keys(groups).forEach(pid => {
      const existing = (plans.get(caseId) || []).find(p => p.id === pid);
      if (existing) return;
      const ws = groups[pid];
      const agent = ws[0].agent || "system";
      const steps = [];
      const seen = {};
      ws.forEach(w => {
        if (!w.nodeId || seen[w.nodeId]) return;
        seen[w.nodeId] = 1;
        steps.push({ id: w.nodeId, name: w.name || w.nodeId, task: w.task || w.name || "",
          tier: w.tier || "strong", outputs: w.outputs || [], depends: w.depends || [],
          failurePolicy: "degradable" });
      });
      if (!steps.length) return;
      const p = { id: pid, case: caseId, agent, goal: "恢复计划（broker 重启后从 WorkItem 重建）",
        steps, planner: null, version: 1, history: [], status: "approved", recovered: true,
        blockedOnNeed: [], createdAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
        approvedBy: "system", note: "recovered" };
      if (!plans.has(caseId)) plans.set(caseId, []);
      plans.get(caseId).push(p);
      emit("plan.recovered", "system", { case: caseId, planId: pid, agent, steps: steps.length, stepsData: steps });
    });
  });
}
function replay() {
  if (!fs.existsSync(LEDGER)) return;
  // 审批事件可能早于 plan.created 落账（旧版 fanout 先占位、后发事件）；先暂存，等计划创建后补应用。
  const orphanPlanEvents = new Map();
  const lines = fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch (_) { continue; }
    S.seq = Math.max(S.seq, e.seq || 0);
    S.events.push(e);
    if (S.events.length > 4000) S.events.splice(0, S.events.length - 4000);
    if (GRAPH_TYPES.has(e.type)) {
      const lane = e.lane || laneOf(e.actor);
      lastGraphSeq.set(lane, e.seq);
    }
    if (e.type === "file.written") {
      const f = fileOf(e.case || "default", e.path);
      f.version = e.v; f.sha = e.sha; f.writes += 1;
    }
    if (e.type === "skill.installed" || e.type === "skill.uninstalled") {
      const st = skillsOf(e.case || "default");
      const sk = st.catalog.find(x => x.id === e.skill || x.name === e.skill);
      if (sk) sk.installed = e.type === "skill.installed";
    }
    if (e.type === "skill.granted" || e.type === "skill.revoked") {
      const st = skillsOf(e.case || "default");
      const list = st.byAgent[e.agent] = st.byAgent[e.agent] || [];
      if (e.type === "skill.granted" && list.indexOf(e.skill) < 0) list.push(e.skill);
      if (e.type === "skill.revoked") st.byAgent[e.agent] = list.filter(x => x !== e.skill);
    }
    if (e.type === "case.created") { caseOf(e.case || "default"); if (e.name) caseNames.set(e.case || "default", e.name); }
    if (e.type === "case.renamed") caseNames.set(e.case || "default", e.name || "");
    if (e.type === "agent.usage") {
      const u = usageOf(e.case || "default");
      const a = u[e.agent] = u[e.agent] || { input: 0, output: 0, cacheRead: 0, total: 0, runs: 0, lastMs: 0 };
      a.input += e.inputTokens || 0; a.output += e.outputTokens || 0;
      a.cacheRead += e.cacheReadTokens || 0; a.total += e.totalTokens || 0;
      a.runs += 1; a.lastMs = e.ms || 0;
    }
    if (e.type === "case.deleted") {
      deletedCases.add(e.case || "default");
      if (e.trash) trash.set(e.case, { trash: e.trash, at: e.ts, files: e.files || 0 });
    }
    if (e.type === "case.restored") { deletedCases.delete(e.case); trash.delete(e.case); caseOf(e.case); }
    if (e.type === "trash.purged") trash.delete(e.case);
    if (e.type === "review.requested") {
      const caseId = e.case || "default";
      caseOf(caseId);
      if (!reviews.has(caseId)) reviews.set(caseId, []);
      const list = reviews.get(caseId);
      if (!list.some(x => x.id === e.reviewId)) {
        list.push({ id: e.reviewId || ("R" + (++reviewSeq)), case: caseId, service: e.service || "audit",
          path: e.path, version: e.version, round: e.round || 1, status: "requested",
          requester: e.actor || "lead", criteria: "", findings: [], createdAt: e.ts,
          finishedAt: null, note: "", waivedBy: null });
      }
      const n = parseInt(String(e.reviewId || "").replace(/^R/, ""), 10);
      if (n > reviewSeq) reviewSeq = n;
    }
    if (e.type === "review.verdict") {
      const rv = (reviews.get(e.case || "default") || []).find(x => x.id === e.reviewId);
      if (rv) {
        rv.status = e.result === "pass" ? "clean" : (e.result === "conditional" ? "conditional" : "returned");
        rv.result = e.result; rv.finishedAt = e.ts;
      }
    }
    if (e.type === "review.waived") {
      const rv = (reviews.get(e.case || "default") || []).find(x => x.id === e.reviewId);
      if (rv) { rv.status = "waived"; rv.waivedBy = e.actor; rv.note = e.note || ""; rv.finishedAt = e.ts; }
    }
    if (e.type === "cycle.started") {
      cycles.set(e.case || "default", { status: "running", startedAt: e.ts, retry: !!e.retry });
    }
    if (e.type === "cycle.completed") {
      cycles.set(e.case || "default", { status: "awaiting_review", finishedAt: e.ts,
        summary: e.summary || { files: e.files || 0, gates: e.gates || 0 } });
    }
    if (e.type === "cycle.signed") {
      const cc = cycles.get(e.case || "default") || {};
      cycles.set(e.case || "default", Object.assign({}, cc, { status: "signed", signedAt: e.ts }));
    }
    if (e.type === "cycle.failed") {
      cycles.set(e.case || "default", { status: "failed", stage: e.stage || "",
        agent: e.agent || "", error: e.error || "", failedAt: e.ts });
    }
    if (e.type === "need.requested") {
      const caseId = e.case || "default";
      caseOf(caseId);
      if (!needs.has(caseId)) needs.set(caseId, []);
      const list = needs.get(caseId);
      if (!list.some(x => x.id === e.needId)) {
        const autoFail = /^采集失败/.test(e.title || "") && !/请手动上传/.test(e.title || "") && !e.spec;
        list.push({ id: e.needId || ("N" + (++needSeq)), case: caseId, agent: e.agent,
          kind: autoFail ? "info" : (e.kind || "other"), title: e.title || "", detail: "",
          blocking: autoFail ? false : (e.blocking !== false),
          planId: e.planId || "", stepId: e.stepId || "", spec: e.spec || null,
          indicatorIds: e.indicatorIds || [],
          status: "pending", createdAt: e.ts, answer: null, answeredAt: null, answeredBy: null });
      }
      const n = parseInt(String(e.needId || "").replace(/^N/, ""), 10);
      if (n > needSeq) needSeq = n;
    }
    if (e.type === "need.updated") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.title = e.title || n.title; n.detail = e.detail || n.detail; n.spec = e.spec || n.spec;
        if (typeof e.kind === "string") n.kind = e.kind;
        if (typeof e.blocking === "boolean") n.blocking = e.blocking;
        n.indicatorIds = e.indicatorIds || n.indicatorIds || []; n.answer = e.answer || n.answer; }
    }
    if (e.type === "need.superseded") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.status = "superseded"; n.supersededBy = e.canonicalId || ""; }
    }
    if (e.type === "report.unsigned") {
      const caseId = e.case || "default";
      const all = reportSignatures.get(caseId) || {};
      delete all[e.path]; reportSignatures.set(caseId, all);
    }
    if (e.type === "report.signed") {
      const caseId = e.case || "default";
      const all = reportSignatures.get(caseId) || {};
      all[e.path] = e.signature || { by: e.actor || "you", at: e.ts || new Date().toISOString(), version: e.v };
      reportSignatures.set(caseId, all);
    }
    if (e.type === "need.partial") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.status = "partial"; n.partialAnswer = e.answer || "";
        n.providedCount = e.provided || 0; n.totalCount = e.total || 0; }
    }
    if (e.type === "need.waived") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.status = "waived"; n.waived = true; n.waiveReason = e.reason || ""; n.answer = e.answer || n.answer; }
    }
    if (e.type === "need.merge_suggested") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) n.mergeSuggestion = { targetId: e.targetId, relation: e.relation || "related",
        confidence: e.confidence || 0, reason: e.reason || "" };
    }
    if (e.type === "need.merge_ignored") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.mergeSuggestion = null; n.dedupeIgnored = true; }
    }
    if (e.type === "need.item.reset") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items) && n.spec.items[e.index]) {
        const it = n.spec.items[e.index]; it.status = "pending";
        delete it.value; delete it.source; delete it.file; delete it.evidenceId;
        n.status = "pending";
        n.providedCount = n.spec.items.filter(i => i.status === "provided").length;
        n.totalCount = n.spec.items.length;
      }
    }
    if (e.type === "intake.created") {
      const caseId = e.case || "default";
      const list = intakes.get(caseId) || [];
      list.push({ id: e.intakeId, case: caseId, agent: e.agent, text: e.text || "", url: e.url || "",
        needId: e.needId || "", index: e.index === undefined ? null : e.index,
        parentPlanId: e.parentPlanId || "", parentStepId: e.parentStepId || "",
        candidates: e.candidates || [], status: e.status || "needs_target", attempts: [],
        createdAt: e.ts, updatedAt: e.ts });
      intakes.set(caseId, list);
      const n = parseInt(String(e.intakeId || "").replace(/\D/g, ""), 10); if (n > intakeSeq) intakeSeq = n;
    }
    if (e.type === "intake.updated") {
      const it = (intakes.get(e.case || "default") || []).find(x => x.id === e.intakeId);
      if (it) { it.status = e.status || it.status; it.needId = e.needId !== undefined ? e.needId : it.needId;
        it.index = e.index !== undefined ? e.index : it.index; it.updatedAt = e.ts;
        if (e.found || e.coverage !== undefined) { const at = { at: e.ts, by: e.actor || "you", found: e.found || "",
          coverage: e.coverage, missing: e.missing || "" }; it.attempts.push(at); it.lastAttempt = at; }
      }
    }
    if (e.type === "need.source.added") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); if (!n.sources.some(s => s.id === e.sourceId)) n.sources.push({ id: e.sourceId, needId: n.id, kind: e.kind, ref: e.ref, label: "", status: "added", lastError: "", parseJobId: "", addedAt: e.ts, addedBy: e.actor });
        sourceSeq = Math.max(sourceSeq, parseInt(String(e.sourceId || "").replace(/[^0-9]/g, ""), 10) || 0); }
    }
    if (e.type === "need.parse.started") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n);
        if (!n.parseJobs.some(j => j.id === e.parseJobId)) n.parseJobs.push({ id: e.parseJobId, needId: n.id, sourceId: e.sourceId, status: "running", extractor: "", startedAt: e.ts, finishedAt: "", error: "", candidateCount: 0 });
        const s = n.sources.find(x => x.id === e.sourceId); if (s) { s.status = "parsing"; s.parseJobId = e.parseJobId; }
        parseJobSeq = Math.max(parseJobSeq, parseInt(String(e.parseJobId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "need.parse.finished") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n);
        const j = n.parseJobs.find(x => x.id === e.parseJobId);
        if (j) { j.status = e.ok ? "done" : "failed"; j.finishedAt = e.ts; j.error = e.error || ""; j.candidateCount = e.candidateCount || 0; }
        const s = n.sources.find(x => x.id === e.sourceId); if (s) { s.status = e.ok ? "parsed" : "failed"; s.lastError = e.error || ""; }
      }
    }
    if (e.type === "need.candidate.created") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); if (!n.candidates.some(c => c.id === e.candidateId)) n.candidates.push({ id: e.candidateId, needId: n.id,
        taskId: e.taskId || "", attemptId: e.attemptId || "", itemIndex: e.itemIndex, sourceId: e.sourceId || "",
        parseJobId: e.parseJobId || "", indicator: e.indicator || "", value: e.value, unit: e.unit, period: e.period,
        locator: e.locator || null, confidence: e.confidence || 0, extractor: e.extractor || "",
        sourceUrl: e.sourceUrl || "", dataAsOf: e.dataAsOf || "", status: "pending", decidedBy: "", decidedAt: "",
        rejectReason: "", conflictGroup: "" });
        candidateSeq = Math.max(candidateSeq, parseInt(String(e.candidateId || "").replace(/[^0-9]/g, ""), 10) || 0); }
    }
    if (e.type === "need.candidate.decided") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); const c = n.candidates.find(x => x.id === e.candidateId);
        if (c) { c.status = e.decision === "rejected" ? "rejected" : "accepted"; c.decidedBy = e.actor;
          c.decidedAt = e.ts; c.rejectReason = e.reason || ""; if (e.evidenceId) c.evidenceId = e.evidenceId;
          if (c.status === "accepted") {
            const it = (n.spec && n.spec.items || [])[c.itemIndex];
            if (it) { it.status = "provided"; it.value = c.value || ""; it.source = c.sourceUrl || it.source || "";
              it.evidenceId = c.evidenceId || e.evidenceId || ""; it.dataAsOf = c.dataAsOf || it.dataAsOf || "";
              it.note = it.note || ("DataTask 候选 " + c.id); }
          }
        } }
    }
    if (e.type === "need.conflict.opened") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); if (!n.conflicts.some(c => c.id === e.conflictId)) n.conflicts.push({ id: e.conflictId, needId: n.id, itemIndex: e.itemIndex, candidateIds: e.candidateIds || [], state: "open", createdAt: e.ts });
        conflictSeq = Math.max(conflictSeq, parseInt(String(e.conflictId || "").replace(/[^0-9]/g, ""), 10) || 0); }
    }
    if (e.type === "need.conflict.resolved") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); const c = n.conflicts.find(x => x.id === e.conflictId); if (c) { c.state = e.waived ? "waived" : "resolved"; c.resolution = { chosenCandidateId: e.chosenCandidateId || "", waived: !!e.waived, reason: e.reason || "", by: e.actor, at: e.ts }; } }
    }
    if (e.type === "need.item.waived") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { ensureNeedV2(n); const it = (n.spec && n.spec.items || [])[e.index]; if (it) it.status = "waived"; if (!n.waivedItems.some(w => w.index === e.index)) n.waivedItems.push({ index: e.index, reason: e.reason || "", by: e.actor, at: e.ts }); }
    }
    if (e.type === "need.auto") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items) && n.spec.items[e.index]) {
        const it = n.spec.items[e.index];
        it.auto = e.auto || null;
        if (e.match) it.match = e.match;
        if (e.auto && e.auto.evidenceId) it.evidenceId = e.auto.evidenceId;
        if (e.auto && e.auto.dataAsOf) it.dataAsOf = e.auto.dataAsOf;
      }
    }
    if (e.type === "need.item.attempt") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items) && n.spec.items[e.index]) {
        const it = n.spec.items[e.index];
        it.attempts = Array.isArray(it.attempts) ? it.attempts : [];
        it.attempts.push(e.attempt); it.lastAttempt = e.attempt;
      }
    }
    if (e.type === "need.series.accepted") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items) && n.spec.items[e.index]) {
        ensureNeedV2(n);
        const it = n.spec.items[e.index];
        it.status = "provided"; it.value = e.value || ""; it.unit = e.unit || it.unit;
        it.source = e.source || ""; it.evidenceId = e.evidenceId || ""; it.dataAsOf = e.dataAsOf || "";
        it.note = "DataTask 序列 " + (e.records || 0) + " 条";
        if (e.file) it.file = e.file;
        const src = (n.sources || []).find(s => s.ref === it.source);
        if (!it.file && src && src.kind === "file") it.file = src.ref;
        (e.candidateIds || []).forEach((cid, i) => {
          const c = n.candidates.find(x => x.id === cid);
          if (c) { c.status = i === 0 ? "accepted" : "superseded"; c.evidenceId = e.evidenceId || ""; }
        });
        n.providedCount = n.spec.items.filter(i => i.status === "provided").length;
        n.totalCount = n.spec.items.length;
      }
    }
    if (e.type === "need.item.provided") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items) && n.spec.items[e.index]) {
        const it = n.spec.items[e.index];
        it.status = "provided"; it.value = e.value || ""; it.source = e.source || "";
        if (e.file) it.file = e.file;
        if (Array.isArray(e.files)) it.files = e.files;
        else if (e.file && !it.files) it.files = [e.file];
        if (e.evidenceId) it.evidenceId = e.evidenceId;
        if (e.dataAsOf) it.dataAsOf = e.dataAsOf;
        if (e.note) it.note = e.note;
        if (e.file) it.file = e.file;
        n.providedCount = n.spec.items.filter(i => i.status === "provided").length;
        n.totalCount = n.spec.items.length;
      }
    }
    if (e.type === "need.items.provided") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n && n.spec && Array.isArray(n.spec.items)) {
        (e.items || []).forEach(x => {
          const it = n.spec.items[x.index];
          if (!it) return;
          it.status = "provided"; it.value = x.value || ""; it.source = x.source || "";
          it.file = x.file || ""; if (x.evidenceId) it.evidenceId = x.evidenceId;
          if (x.dataAsOf) it.dataAsOf = x.dataAsOf; if (x.note) it.note = x.note;
        });
        n.providedCount = n.spec.items.filter(i => i.status === "provided").length;
        n.totalCount = n.spec.items.length;
      }
    }
    if (e.type === "need.answered") {
      const list = needs.get(e.case || "default") || [];
      const n = list.find(x => x.id === e.needId);
      if (n) { n.status = "answered"; n.answer = e.answer || ""; n.answeredAt = e.ts; n.answeredBy = e.actor;
        if (e.decision) n.decision = e.decision; }
    }
    if (e.type === "need.consumed") {
      const n = (needs.get(e.case || "default") || []).find(x => x.id === e.needId);
      if (n) { n.consumedAt = e.consumedAt || e.ts; n.consumedBy = e.actor || "lead"; }
    }
    if (e.type === "datatask.updated" && e.task && e.task.id) {
      const caseId = e.case || e.task.case || "default";
      if (!dataTasks.has(caseId)) dataTasks.set(caseId, []);
      const list = dataTasks.get(caseId);
      const idx = list.findIndex(t => t.id === e.task.id);
      if (idx >= 0) list[idx] = e.task; else list.push(e.task);
      dataTaskSeq = Math.max(dataTaskSeq, parseInt(String(e.task.id || "").replace(/[^0-9]/g, ""), 10) || 0);
      (e.task.sources || []).forEach(s => {
        dataTaskSourceSeq = Math.max(dataTaskSourceSeq, parseInt(String(s.id || "").replace(/[^0-9]/g, ""), 10) || 0);
      });
      (e.task.attempts || []).forEach(a => {
        dataTaskAttemptSeq = Math.max(dataTaskAttemptSeq, parseInt(String(a.id || "").replace(/[^0-9]/g, ""), 10) || 0);
      });
    }
    if (e.type === "agent.usage" && (e.case || "default")) {
      const tok = e.totalTokens || e.total || 0;
      caseTokens.set(e.case || "default", (caseTokens.get(e.case || "default") || 0) + tok);
      if (e.workId) { const w = (works.get(e.case || "default") || []).find(x => x.id === e.workId);
        if (w) { w.tokens = (w.tokens || 0) + tok; w.inputTokens = (w.inputTokens || 0) + (e.inputTokens || 0);
          w.outputTokens = (w.outputTokens || 0) + (e.outputTokens || 0); } }
    }
    // WorkItem：回放 DAG 节点状态（重启后调度器可继续）
    if (e.type === "fanout.started") {
      fanoutGroups.set((e.case || "default") + "|" + e.groupId, { id: e.groupId, case: e.case || "default",
        goal: e.goal || "", tasks: e.tasks || [], createdAt: e.ts });
    }
    if (e.type === "fanout.deleted") {
      fanoutGroups.delete((e.case || "default") + "|" + e.groupId);
    }
    if (e.type === "fanout.synthesis.started") {
      const g = fanoutGroups.get((e.case || "default") + "|" + e.groupId);
      if (g) g.synthesisStarted = true;
    }
    if (e.type === "fanout.synthesis.finished" || e.type === "fanout.synthesis.failed") {
      const g = fanoutGroups.get((e.case || "default") + "|" + e.groupId);
      if (g) { g.synthesisStarted = false; g.synthesisDone = e.ok === true; }
    }
    if (e.type === "work.created") {
      const caseId = e.case || "default";
      if (!works.has(caseId)) works.set(caseId, []);
      const list = works.get(caseId);
      if (!list.some(x => x.id === e.workId)) {
        list.push({ id: e.workId, case: caseId, planId: e.planId || "", agent: e.agent || "",
          nodeId: e.nodeId || "", name: e.name || "", task: "", depends: e.depends || [],
          tier: e.tier || "strong", state: "queued", owner: "", attempt: 0,
          outputs: e.outputs || [], mergeFrom: e.mergeFrom || [],
          maxWallMs: Number(e.maxWallMs) || 0, estimate: e.estimate || null,
          leaseId: "", leaseUntil: 0, retryAfter: 0,
          cancelRequested: false, traceId: e.traceId || e.planId || "",
          createdAt: e.ts, startedAt: null, finishedAt: null, heartbeatAt: null, error: "" });
        workSeq = Math.max(workSeq, parseInt(String(e.workId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "work.contract.updated") {
      const w = (works.get(e.case || "default") || []).find(x => x.id === e.workId);
      if (w) {
        if (Array.isArray(e.outputs) && e.outputs.length) w.outputs = e.outputs;
        if (e.maxWallMs) w.maxWallMs = Number(e.maxWallMs) || 0;
        if (e.maxTokens) w.maxTokens = Number(e.maxTokens) || 0;
      }
    }
    if (e.type === "work.child.created") {
      const caseId = e.case || "default";
      if (!works.has(caseId)) works.set(caseId, []);
      const list = works.get(caseId);
      if (!list.some(x => x.id === e.workId)) {
        list.push({ id: e.workId, case: caseId, planId: e.planId || "", parentWorkId: e.parentWorkId || "",
          agent: e.agent || "", nodeId: e.nodeId || "", name: e.name || "", task: "",
          depends: [], tier: "strong", state: "queued", kind: "child", depth: e.depth || 1,
          owner: "", attempt: 0, outputs: [], mergeFrom: [], leaseId: "", leaseUntil: 0,
          retryAfter: 0, cancelRequested: false, traceId: e.planId || "", createdAt: e.ts,
          startedAt: null, finishedAt: null, heartbeatAt: null, error: "" });
        childSeq = Math.max(childSeq, parseInt(String(e.workId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "work.child.started") {
      const w = (works.get(e.case || "default") || []).find(x => x.id === e.workId);
      if (w) { w.state = "running"; w.startedAt = e.ts; w.heartbeatAt = e.ts; }
    }
    if (e.type === "work.child.finished") {
      const w = (works.get(e.case || "default") || []).find(x => x.id === e.workId);
      if (w) { w.state = e.ok ? "done" : (e.cancelled ? "cancelled" : "failed");
        w.partial = !!e.partial; w.error = e.error || ""; w.finishedAt = e.ts; }
    }
    if (e.type === "work.started") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.state = "running"; w.owner = e.owner || w.owner; w.attempt = e.attempt || (w.attempt + 1);
        w.leaseId = e.leaseId || w.leaseId; w.leaseUntil = e.leaseUntil || w.leaseUntil;
        w.retryAfter = 0; w.startedAt = e.ts; }
    }
    if (e.type === "work.worker") {
      const w = (works.get(e.case || "default") || []).find(x => x.id === e.workId);
      if (w) w.workerPid = e.pid || 0;
    }
    if (e.type === "work.heartbeat") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.heartbeatAt = e.ts; w.leaseUntil = e.leaseUntil || w.leaseUntil; }
    }
    if (e.type === "work.finished" || e.type === "work.failed" || e.type === "work.cancelled") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.state = e.type === "work.finished" ? "done" : (e.type === "work.cancelled" ? "cancelled" : "failed");
        w.finishedAt = e.ts;
        if ((!w.outputs || !w.outputs.length) && Array.isArray(e.outputs) && e.outputs.length) w.outputs = e.outputs;
        w.error = e.error || ""; w.leaseUntil = 0; w.leaseId = ""; }
    }
    if (e.type === "work.pause.requested") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) w.pauseRequested = true;
    }
    if (e.type === "work.orphaned" || e.type === "work.requeued") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0;
        w.retryAfter = e.retryAfter || 0; w.error = e.reason || (e.type === "work.orphaned" ? "broker restart" : "requeued"); }
    }
    if (e.type === "work.retried") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0; w.retryAfter = 0; w.error = ""; }
    }
    if (e.type === "work.cancel.requested") {
      const list = works.get(e.case || "default") || [];
      const w = list.find(x => x.id === e.workId);
      if (w) { w.state = "cancelling"; w.cancelRequested = true; }
    }
    if (e.type === "work.paused") pausedCases.add(e.case || "default");
    if (e.type === "work.resumed") pausedCases.delete(e.case || "default");
    // 计划与协作请求：从账本回放（计划步骤完整存进事件，重启后仍可审批/执行）
    if (e.type === "plan.created") {
      const caseId = e.case || "default";
      if (!plans.has(caseId)) plans.set(caseId, []);
      const list = plans.get(caseId);
      if (!list.some(x => x.id === e.planId)) {
        const created = { id: e.planId, case: caseId, agent: e.agent, goal: e.goal || "",
          steps: e.steps || [], planner: e.planner || null, status: e.status || "pending",
          planning: e.planning === true || e.status === "planning",
          blockedOnNeed: [], createdAt: e.ts, approvedAt: e.status === "approved" ? e.ts : null,
          approvedBy: e.status === "approved" ? e.actor : null, note: "" };
        const orphan = orphanPlanEvents.get(caseId + "|" + e.planId);
        if (orphan) {
          created.status = orphan.type === "plan.approved" ? "approved" : "rejected";
          created.approvedAt = orphan.ts; created.approvedBy = orphan.actor; created.note = orphan.note || "";
          orphanPlanEvents.delete(caseId + "|" + e.planId);
        }
        list.push(created);
        planSeq = Math.max(planSeq, parseInt(String(e.planId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "plan.revised") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p) {
        if (Array.isArray(e.stepsData) && e.stepsData.length) p.steps = e.stepsData;
        if (e.version) p.version = e.version;
      }
    }
    if (e.type === "plan.ready") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p) {
        if (Array.isArray(e.steps) && e.steps.length) p.steps = e.steps;
        p.planning = false;
        if (p.status === "planning") p.status = e.status || "pending";
        if (e.planner) p.planner = e.planner;
      }
    }
    if (e.type === "plan.recovered") {
      const caseId = e.case || "default";
      if (!plans.has(caseId)) plans.set(caseId, []);
      const list = plans.get(caseId);
      if (Array.isArray(e.stepsData) && e.stepsData.length && !list.some(x => x.id === e.planId)) {
        list.push({ id: e.planId, case: caseId, agent: e.agent, goal: "恢复计划（broker 重启后从 WorkItem 重建）",
          steps: e.stepsData, planner: null, version: 1, history: [], status: "approved",
          recovered: true, blockedOnNeed: [], createdAt: e.ts, approvedAt: e.ts, approvedBy: "system", note: "recovered" });
        planSeq = Math.max(planSeq, parseInt(String(e.planId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "plan.blocked") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p) { p.blockedOnNeed = p.blockedOnNeed || []; if (p.blockedOnNeed.indexOf(e.needId) < 0) p.blockedOnNeed.push(e.needId); }
    }
    if (e.type === "plan.unblocked") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p && Array.isArray(p.blockedOnNeed)) p.blockedOnNeed = p.blockedOnNeed.filter(x => x !== e.needId);
    }
    if (e.type === "plan.completed") {
      completionSeen.add((e.case || "default") + "|" + e.planId);
    }
    if (e.type === "completion.options") {
      const caseId = e.case || "default";
      const item = { case: caseId, planId: e.planId || "", agent: e.agent || "",
        title: e.title || "任务已完成", message: e.message || "",
        options: Array.isArray(e.options) ? e.options : [],
        createdAt: e.createdAt || e.ts, chosen: null };
      completions.set(caseId, item);
      if (item.planId) completionsByPlan.set(caseId + "|" + item.planId, item);
    }
    if (e.type === "completion.chosen") {
      const caseId = e.case || "default";
      const item = completionsByPlan.get(caseId + "|" + e.planId) || completions.get(caseId);
      if (item) item.chosen = e.optionId || "chosen";
    }
    if (e.type === "plan.approved" || e.type === "plan.rejected") {
      const list = plans.get(e.case || "default") || [];
      const p = list.find(x => x.id === e.planId);
      if (p) { p.status = e.type === "plan.approved" ? "approved" : "rejected"; p.approvedAt = e.ts; p.approvedBy = e.actor; p.note = e.note || ""; }
      else orphanPlanEvents.set((e.case || "default") + "|" + e.planId, e);
    }
    if (e.type === "plan.updated") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p && Array.isArray(e.stepsData) && e.stepsData.length) p.steps = e.stepsData;
    }
    if (e.type === "plan.rolledback") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p) {
        if (Array.isArray(e.stepsData) && e.stepsData.length) p.steps = e.stepsData;
        if (e.version) p.version = e.version;
      }
    }
    if (e.type === "plan.reordered") {
      const p = (plans.get(e.case || "default") || []).find(x => x.id === e.planId);
      if (p && Array.isArray(e.order)) {
        const byId = {};
        (p.steps || []).forEach(s => { byId[s.id] = s; });
        const next = e.order.map(id => byId[id]).filter(Boolean);
        if (next.length === (p.steps || []).length) p.steps = next;
      }
    }
    if (e.type === "coordination.requested") {
      const caseId = e.case || "default";
      if (!coords.has(caseId)) coords.set(caseId, []);
      const list = coords.get(caseId);
      if (!list.some(x => x.id === e.coordId)) {
        list.push({ id: e.coordId, case: caseId, from: e.from, to: e.to, task: e.task || "",
          reason: e.reason || "", status: "pending", createdAt: e.ts, decidedBy: null });
        coordSeq = Math.max(coordSeq, parseInt(String(e.coordId || "").replace(/[^0-9]/g, ""), 10) || 0);
      }
    }
    if (e.type === "coordination.approved" || e.type === "coordination.denied") {
      const list = coords.get(e.case || "default") || [];
      const c = list.find(x => x.id === e.coordId);
      if (c) { c.status = e.type === "coordination.approved" ? "approved" : "denied"; c.decidedBy = e.actor; c.decidedAt = e.ts; }
    }
    if (e.type === "task.assigned") {
      const caseId = e.case || "default";
      if (!tasks.has(caseId)) tasks.set(caseId, []);
      const list = tasks.get(caseId);
      if (!list.some(x => x.id === e.taskId)) {
        list.push({ id: e.taskId || ("T" + (++taskSeq)), case: caseId, agent: e.agent,
          text: e.text || "", target: e.target || null, status: "queued",
          createdAt: e.ts, by: e.actor || "you" });
      }
      const n = parseInt(String(e.taskId || "").replace(/^T/, ""), 10);
      if (n > taskSeq) taskSeq = n;
    }
    if (e.type === "task.delivered") {
      const list = tasks.get(e.case || "default") || [];
      const t = list.find(x => x.id === e.taskId);
      if (t) { t.status = "done"; t.doneAt = e.ts; if (e.summary) t.summary = e.summary; }
    }
    if (e.type === "task.updated") {
      const list = tasks.get(e.case || "default") || [];
      const t = list.find(x => x.id === e.taskId);
      if (t) { if (e.name) t.name = e.name; if (e.model != null) t.model = e.model; }
    }
    if (e.type === "agent.model_actual") {
      const c = caseOf(e.case || "default");
      c.actualModels = c.actualModels || {};
      c.actualModels[e.agent] = { model: e.model, provider: e.provider || null, at: e.ts };
    }
    if (e.type === "model.changed") {
      const ms = modelsOf(e.case || "default");
      if (e.agent) ms.byAgent[e.agent] = { provider: e.provider, model: e.model };
      else ms.default = { provider: e.provider, model: e.model };
    }
    if (e.type === "model.added") {
      const ms = modelsOf(e.case || "default");
      if (!ms.catalog.some(m => m.provider === e.provider && m.model === e.model)) {
        ms.catalog.push({ id: e.provider + "/" + e.model, provider: e.provider, model: e.model,
          label: e.label || e.model, ctx: e.ctx || 128000, tag: "自建", builtin: false,
          verified: e.verified === true, key_ref: e.key_ref || "",
          base_url: e.base_url || "", api: e.api || "", headers: e.headers || {} });
      }
    }
    if (e.type === "model.verified") {
      const ms = modelsOf(e.case || "default");
      const m = ms.catalog.find(x => x.provider === e.provider && x.model === e.model);
      if (m) m.verified = true;
    }
    if (e.type === "model.removed") {
      const ms = modelsOf(e.case || "default");
      ms.catalog = ms.catalog.filter(m => !(m.provider === e.provider && m.model === e.model));
      Object.keys(ms.byAgent).forEach(a => {
        if (ms.byAgent[a].provider === e.provider && ms.byAgent[a].model === e.model) delete ms.byAgent[a];
      });
    }
    if (e.type === "gate.passed" || e.type === "gate.failed") {
      const scope = e.scope || "case";
      caseOf(e.case || "default").gates[e.gate + "::" + scope] =
        { gate: e.gate, scope, status: e.status, note: e.note, at: e.ts, by: e.actor };
    }
  }
  // 只有确实落过 completion.options 的计划才算“已完成通知过”；否则让 watchdog 重新生成下一步选项。
  Array.from(completionSeen).forEach(k => { if (!completionsByPlan.has(k)) completionSeen.delete(k); });
  console.log("[broker] replayed " + lines.length + " events, seq=" + S.seq);
  // 重启后不把历史未完成步骤算作"正在运行"（否则会反复告警旧 case）；
  // 只监察本次进程启动后的事件。历史中断可在账本/面板里查看。
  runningSteps.clear(); runningRuns.clear(); watchdogAlerts.clear();
}

replay();
reapStaleLoops();
adoptRunLocks();
recoverPlansFromWork();
// 重启对账：上次进程留下的 running/cancelling WorkItem 不可能还在跑；
// running 重新入队（等 Worker claim），cancelling 直接取消，避免永久卡住。
(function reconcileWorkOnStart() {
  let requeued = 0, cancelled = 0;
  works.forEach((list, caseId) => {
    list.forEach(w => {
      if (w.state === "running") {
        // 有存活 run-dag（锁已接管）时不打断，让它继续跑完；否则重新入队。
        if (autoRuns.has(caseId + "|" + w.planId)) return;
        w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0; w.cancelRequested = false;
        requeued += 1;
        emit("work.orphaned", "system", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, action: "requeued", reason: "broker restart" });
      } else if (w.state === "cancelling") {
        w.state = "cancelled"; w.finishedAt = new Date().toISOString();
        w.error = "cancelled during broker restart";
        cancelled += 1;
        emit("work.cancelled", "system", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, ok: false, cancelled: true, reason: w.error });
      }
    });
  });
  if (requeued || cancelled) console.log("[broker] reconcile: requeued=" + requeued + " cancelled=" + cancelled);
})();
// 重启对账：DataTask 的 parsing attempt 如果 worker 已不在，不能永久卡住。
function failStaleDataTaskAttempts(reason, onlyDeadPid, timeoutOnly) {
  let changed = 0;
  dataTasks.forEach((list, caseId) => {
    list.forEach(t => {
      if (t.status !== "parsing") return;
      const running = (t.attempts || []).filter(a => a.status === "running");
      if (!running.length) return;
      running.forEach(a => {
        if (timeoutOnly) {
          const started = Date.parse(a.startedAt || "");
          const budget = (t.policy && t.policy.maxWallClockMs) || 600000;
          if (!started || Date.now() - started <= budget + 120000) return;
        }
        if (onlyDeadPid && a.pid) {
          let alive = false;
          try { process.kill(a.pid, 0); alive = true; } catch (e) {}
          if (alive) return;
        }
        a.status = "failed"; a.finishedAt = new Date().toISOString();
        a.error = reason;
        const used = (t.attempts || []).filter(x => x.status !== "cancelled").length;
        t.status = used >= t.policy.maxAttempts ? "needs_human" : "needs_more";
        t.error = reason;
        t.nextAction = t.status === "needs_human" ? "needs_human" : "add_source_or_retry";
        emit("datatask.updated", "system", { case: caseId, id: t.id, task: t });
        emit("datatask.attempt.finished", "system", { case: caseId, id: t.id,
          attemptId: a.id, ok: false, error: reason, status: t.status });
        changed += 1;
      });
    });
  });
  if (changed) console.log("[broker] reconcile datatask: failed attempts=" + changed);
  return changed;
}
failStaleDataTaskAttempts("broker restart: parsing worker is not alive", true);
setInterval(() => {
  dataTasks.forEach((list) => list.forEach(t => {
    if (t.status !== "parsing") return;
    (t.attempts || []).forEach(a => {
      if (a.status !== "running") return;
      const started = Date.parse(a.startedAt || "");
      const budget = (t.policy && t.policy.maxWallClockMs) || 600000;
      if (started && Date.now() - started > budget + 120000) {
        failStaleDataTaskAttempts("数据任务超时：attempt 超过预算", false, true);
      }
    });
  }));
}, 30000).unref();
function postOwn(pathname, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body || {});
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
      let data = ""; res.on("data", d => data += d); res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", e => resolve({ status: 0, body: String(e && e.message || e) }));
    req.write(payload); req.end();
  });
}
function autoResumeWaitingLeads() {
  const dir = path.join(ROOT, "runtime/agent-loops");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch (e) { return; }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { continue; }
    if (!j || j.kind !== "lead" || j.status !== "waiting_human" || j.autoResumeRequestedAt) continue;
    const caseId = j.case || "default";
    const cur = leadLeases.get(caseId);
    if (cur && Number(cur.until) > Date.now() && cur.pid && pidAlive(cur.pid)) continue;
    const answered = (needs.get(caseId) || []).filter(n =>
      (n.status === "answered" || n.status === "waived") && !n.consumedAt && n.blocking !== false &&
      Date.parse(n.answeredAt || 0) >= Date.parse(j.updatedAt || j.createdAt || 0));
    if (!answered.length) continue;
    j.autoResumeRequestedAt = new Date().toISOString();
    j.status = "resuming";
    try { fs.writeFileSync(path.join(dir, f), JSON.stringify(j, null, 2)); } catch (e) {}
    emit("agent.loop.auto_resume", "system", { case: caseId, loopId: j.id, needId: answered[0].id,
      reason: "blocking need answered; resume Lead" });
    postOwn("/api/agent/loop/resume", { case: caseId, id: j.id, by: "system:need-answer" });
  }
}
setInterval(autoResumeWaitingLeads, 15000).unref();
emit("broker.started", "system", { pid: process.pid, port: PORT });

function runPython(args, env, timeoutMs) {
  return new Promise(resolve => {
    const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(py, args, { cwd: ROOT, env: env || process.env });
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, timeoutMs || 120000);
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout: out, stderr: err }); });
  });
}
function runProcess(args, env, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT,
      env: env || process.env });
    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, timeoutMs || 120000);
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout: out, stderr: err }); });
  });
}
function planDepsDone(caseId, plan) {
  const deps = (plan && plan.dependsOn) || [];
  return deps.every(id => {
    const p0 = (plans.get(caseId) || []).find(x => x.id === id);
    if (!p0) return false;
    const ws = (works.get(caseId) || []).filter(w => w.planId === p0.id && w.kind !== "child");
    return ws.length > 0 && ws.every(w => w.state === "done");
  });
}
function spawnRecoveryRunner(caseId, planId, trigger) {
  if ((CONFIG.scheduler || {}).autoRun === false) return null;
  const key = caseId + "|" + planId;
  if (autoRuns.has(key)) return null;
  const lock = readRunLock(caseId, planId);
  if (lock) { autoRuns.set(key, lock.pid); return null; }
  const plan = (plans.get(caseId) || []).find(x => x.id === planId);
  if (!plan || plan.status !== "approved") return null;
  if (!planDepsDone(caseId, plan)) return null;
  if (Array.isArray(plan.blockedOnNeed) && plan.blockedOnNeed.length) return null;
  if (plan.parentPlanId) {
    const parentItems = (works.get(caseId) || []).filter(w => w.planId === plan.parentPlanId && w.kind !== "child");
    if (parentItems.length && !parentItems.every(w => w.state === "done")) return null;
  }
  const dir = path.join(ROOT, "runtime/auto-runs");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, planId + "-" + Date.now() + ".log");
  let fd = null;
  try {
    fd = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/run-dag.js"),
      "--case", caseId, "--plan", planId, "--max-concurrency",
      String(Math.max(1, Number((CONFIG.scheduler || {}).maxConcurrency) || 1))],
      { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd],
        env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
    autoRuns.set(key, child.pid);
    writeRunLock(caseId, planId, child.pid);
    child.on("exit", () => { autoRuns.delete(key); clearRunLock(caseId, planId, child.pid); });
    child.unref();
    emit("watchdog.recover", "system", { case: caseId, planId, agent: plan.agent,
      pid: child.pid, trigger: trigger || "stalled", log: path.relative(ROOT, logPath) });
    return child.pid;
  } catch (e) {
    emit("watchdog.recover_failed", "system", { case: caseId, planId, error: String(e && e.message || e) });
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}
let lastMetricSweep = 0;
function metricResolveSweep() {
  const now = Date.now();
  if (now - lastMetricSweep < 30000) return;
  lastMetricSweep = now;
  needs.forEach((list, caseId) => list.forEach(n => {
    const items = (n.spec && n.spec.items) || [];
    items.forEach((it, i) => {
      if (!it.match || it.match.state !== "resolving") return;
      const at = Date.parse(it.match.at || 0) || 0;
      if (now - at < 120000) return;
      it.match.state = "candidate_pending";
      it.match.reasons = ["语义匹配超时，请重试或人工确认"];
      it.auto = { status: "needs_review", metric: it.match.metricId || "",
        reason: "语义匹配超时", matchState: "candidate_pending", at: new Date().toISOString() };
      emit("metric.resolved", "system", { case: caseId, needId: n.id, index: i, state: "candidate_pending",
        metricId: it.match.metricId || "", method: "semantic", confidence: 0, reasons: it.match.reasons });
      emit("need.auto", "system", { case: caseId, needId: n.id, index: i, indicator: it.indicator, auto: it.auto, match: it.match });
    });
  }));
}
let lastSourceHealthRefreshAt = 0;
function maybeRefreshSourceHealth() {
  const now = Date.now();
  const ttl = 6 * 60 * 60 * 1000;
  if (now - lastSourceHealthRefreshAt < ttl) return;
  lastSourceHealthRefreshAt = now;
  let checkedAt = 0;
  try { checkedAt = Date.parse(sourceHealth.loadHealth().checkedAt) || 0; } catch (e) {}
  if (checkedAt && now - checkedAt < ttl) return;
  try {
    const cp = spawn(process.execPath, [path.join(ROOT, "scripts/source-doctor.js"), "--refresh"],
      { cwd: ROOT, detached: true, stdio: "ignore", env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
    cp.unref();
    emit("source.health.refresh", "system", { reason: "scheduled", intervalMs: ttl });
  } catch (e) {}
}
let lastLoopReapAt = 0;
function watchdogPass() {
  if (!WATCHDOG.enabled) return;
  if (Date.now() - lastLoopReapAt > 60000) { lastLoopReapAt = Date.now(); try { reapStaleLoops(); } catch (e) {} }
  metricResolveSweep();
  maybeRefreshSourceHealth();
  // 清掉已退出 runner 的锁，避免“锁还在、watchdog 不敢恢复”导致计划永远卡住。
  autoRuns.forEach((pid, key) => {
    const parts = key.split("|");
    if (parts.length < 2) { autoRuns.delete(key); return; }
    // 锁文件是 runner 的唯一权威；锁没了说明 runner 已退出，即使 pid 被系统复用也不能继续占位。
    if (!fs.existsSync(runLockFile(parts[0], parts[1]))) { autoRuns.delete(key); return; }
    if (pidAlive(pid)) return;
    autoRuns.delete(key);
    clearRunLock(parts[0], parts[1], pid);
  });
  const passNow = Date.now();
  if (lastWatchdogAt && passNow - lastWatchdogAt > Math.max(10000, WATCHDOG.intervalMs * 5)) {
    runningWork.forEach(v => { v.heartbeatAt = passNow; });
    works.forEach(list => list.forEach(w => {
      if (w.state !== "running") return;
      // 宿主休眠后只给“owner 进程仍存活”的 WorkItem 顺延心跳；
      // owner 已死的不能因为休眠被误判为活着，否则会永久 running。
      const op = parseInt(String(w.owner || "").replace(/^dag-/, ""), 10);
      if (!op || pidAlive(op)) w.heartbeatAt = new Date(passNow).toISOString();
    }));
    emit("watchdog.slept", "system", { gapMs: passNow - lastWatchdogAt,
      note: "检测到宿主休眠/事件循环停顿，已顺延运行中心跳，不判超时" });
  }
  lastWatchdogAt = passNow;
  const now = Date.now();
  // 计划级停滞：已批准、无阻塞、无 running、无活跃 runner，但仍有就绪节点（或还没建节点）
  if (WATCHDOG.recoverStalled !== false) {
    plans.forEach((list, caseId) => {
      if (pausedCases.has(caseId) || deletedCases.has(caseId)) return;
      // 每个员工只恢复“最新已批准计划”，避免历史计划被重复拉起
      const latestByAgent = {};
      list.filter(p => p.status === "approved").forEach(p => {
        const cur = latestByAgent[p.agent];
        if (!cur || String(p.createdAt || "") > String(cur.createdAt || "")) latestByAgent[p.agent] = p;
      });
      Object.keys(latestByAgent).map(k => latestByAgent[k]).forEach(p => {
        if (Array.isArray(p.blockedOnNeed) && p.blockedOnNeed.length) { stallSince.delete(caseId + "|" + p.id); return; }
        const key = caseId + "|" + p.id;
        if (autoRuns.has(key)) { stallSince.delete(key); return; }
        let items = (works.get(caseId) || []).filter(w => w.planId === p.id);
        // 失败节点自动重试（受次数/冷却限制）；重试后由下面恢复 runner
        if (WATCHDOG.autoRetryFailed !== false) {
          const done0 = new Set(items.filter(w => w.state === "done").map(w => w.nodeId));
          items.filter(w => w.state === "failed" && !w.needsReview && w.attempt < WATCHDOG.maxAttempts &&
            (w.depends || []).every(d => done0.has(d)) &&
            (now - (lastFailedRetry.get(w.id) || 0) >= WATCHDOG.failedRetryCooldownMs))
            .forEach(w => {
              lastFailedRetry.set(w.id, now);
              releaseWorkBudget(w, "watchdog.retry");
              w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0;
              w.retryAfter = 0; w.heartbeatAt = null;
              emit("work.retried", "system", { case: caseId, workId: w.id, planId: w.planId,
                agent: w.agent, nodeId: w.nodeId, reason: "auto-retry failed node",
                attempt: w.attempt, traceId: w.traceId });
            });
        }
        // 若有失败节点（含重试耗尽），不要反复拉起 runner；run-dag 会在启动时直接退出
        const hasFailed = items.some(w => w.state === "failed");
        if (hasFailed) {
          const fk = "planfail|" + key;
          if (!watchdogAlerts.get(fk)) {
            watchdogAlerts.set(fk, now);
            emit("watchdog.alert", "system", { case: caseId, planId: p.id, agent: p.agent,
              kind: "plan_failed", note: "计划 " + p.id + " 存在失败节点，已停止自动恢复；请重试失败任务或修订计划" });
          }
          stallSince.delete(key);
          return;
        }
        const running = items.some(w => w.state === "running" || w.state === "cancelling");
        const done = new Set(items.filter(w => w.state === "done").map(w => w.nodeId));
        const ready = items.some(w => w.state === "queued" &&
          (w.depends || []).every(d => done.has(d)));
        // 计划全部完成：生成“下一步选择”选项（模型生成；失败则用默认选项）
        const completionKey = "completion|" + key;
        // 依赖已满足的 approved 计划，在运行中计划完成后自动启动。
        (plans.get(caseId) || []).filter(p2 => p2.status === "approved" && (p2.dependsOn || []).length)
          .forEach(p2 => {
            const key2 = caseId + "|" + p2.id;
            if (autoRuns.has(key2)) return;
            if (planDepsDone(caseId, p2)) { try { spawnRecoveryRunner(caseId, p2.id, "dependencies-ready"); } catch (e) {} }
          });
        // 冲突修订完成后自动重跑语义复核。
        if (items.length && items.every(w => w.state === "done") && p.planner && p.planner.by === "ConflictResolver") {
          const revs = (plans.get(caseId) || []).filter(x => x.planner && x.planner.by === "ConflictResolver");
          const allDone = revs.length && revs.every(x => {
            const ws2 = (works.get(caseId) || []).filter(w => w.planId === x.id && w.kind !== "child");
            return ws2.length && ws2.every(w => w.state === "done");
          });
          if (allDone && !p.revisionSemanticQueued) {
            p.revisionSemanticQueued = true;
            // 修订完成后旧冲突方案已过期，先下架，避免用户继续点旧方案。
            try {
              const cf = vaultPath(caseId, "research/conflicts.json");
              if (fs.existsSync(cf)) {
                fs.mkdirSync(path.join(ROOT, "runtime/backups"), { recursive: true });
                fs.copyFileSync(cf, path.join(ROOT, "runtime/backups", caseId + "-conflicts-old.json"));
                fs.unlinkSync(cf);
              }
            } catch (e) {}
            try { enqueueAsyncJob(caseId, "semantic_review", {}, "system"); } catch (e) {}
          }
        }
        if (items.length && items.every(w => w.state === "done") && !completionSeen.has(completionKey)) {
          completionSeen.add(completionKey);
          emit("plan.completed", "system", { case: caseId, planId: p.id, agent: p.agent });
          try {
            if (fs.existsSync(vaultPath(caseId, FINAL_REPORT))) return;
            const planner = path.join(ROOT, "scripts/planner.js");
            const child = spawn(process.execPath, [planner, "--case", caseId, "--agent", p.agent,
              "--completion-options", p.id], { cwd: ROOT, detached: true, stdio: "ignore",
              env: Object.assign({}, process.env, { DESK_BROKER: "http://127.0.0.1:" + PORT }) });
            child.unref();
          } catch (e) {}
        }
        if (running || (!ready && items.length)) { stallSince.delete(key); return; }
        if (!stallSince.has(key)) stallSince.set(key, now);
        if (now - stallSince.get(key) < WATCHDOG.stallThresholdMs) return;
        if (now - (lastRecovery.get(key) || 0) < WATCHDOG.recoverCooldownMs) return;
        lastRecovery.set(key, now);
        const pid = spawnRecoveryRunner(caseId, p.id, "stalled-plan");
        if (pid) stallSince.delete(key);
      });
    });
  }
  runningSteps.forEach((v, k) => {
    const age = now - v.startedAt;
    if (age < WATCHDOG.stepTimeoutMs) return;
    if (watchdogAlerts.get(k)) return;
    watchdogAlerts.set(k, now);
    emit("watchdog.alert", "system", { case: v.case, agent: v.agent, stage: v.stage,
      kind: "step_timeout", ageMs: age, timeoutMs: WATCHDOG.stepTimeoutMs,
      note: "步骤超过 " + Math.round(WATCHDOG.stepTimeoutMs / 60000) + " 分钟未完成，请检查会话/重试" });
  });
  runningRuns.forEach((v, k) => {
    const age = now - v.startedAt;
    if (age < WATCHDOG.runTimeoutMs) return;
    if (watchdogAlerts.get(k)) return;
    watchdogAlerts.set(k, now);
    emit("watchdog.alert", "system", { case: v.case, agent: v.agent,
      kind: "run_timeout", ageMs: age, timeoutMs: WATCHDOG.runTimeoutMs,
      note: "员工会话超过 " + Math.round(WATCHDOG.runTimeoutMs / 60000) + " 分钟未结束" });
  });
  works.forEach((list, caseId) => {
    list.forEach(w => {
      if (w.state !== "running" && w.state !== "cancelling") return;
      const base = Date.parse(w.heartbeatAt || w.startedAt || w.createdAt) || now;
      const age = now - base;
      // 进度 watchdog：心跳正常但长期没有有效进展时告警；不复用 heartbeat，避免假活跃
      const progressAt = Date.parse(w.lastProgressAt || w.startedAt || w.createdAt) || now;
      const progressAge = now - progressAt;
      if (progressAge >= WATCHDOG.progressTimeoutMs) {
        w.progressStalled = true;
        if (!w.progressAlertedAt || now - w.progressAlertedAt >= WATCHDOG.progressCooldownMs) {
          w.progressAlertedAt = now;
          const mins = Math.round(progressAge / 60000);
          emit("watchdog.progress", "system", { case: caseId, agent: w.agent, nodeId: w.nodeId,
            workId: w.id, elapsedMs: progressAge, lastProgress: w.lastProgressText || "",
            kind: "no_progress", note: (w.nodeId || w.id) + " 已 " + mins + " 分钟没有有效进展" });
          emit("watchdog.alert", "system", { case: caseId, agent: w.agent, nodeId: w.nodeId,
            workId: w.id, kind: "progress_stalled", ageMs: progressAge,
            note: "步骤 " + (w.nodeId || w.id) + " 已 " + mins + " 分钟没有有效进展，请检查会话/重试" });
        }
        if (WATCHDOG.progressHardTimeoutMs && progressAge >= WATCHDOG.progressHardTimeoutMs &&
            !w.progressHardAlertedAt) {
          w.progressHardAlertedAt = now;
          emit("watchdog.alert", "system", { case: caseId, agent: w.agent, nodeId: w.nodeId,
            workId: w.id, kind: "progress_hard_timeout", ageMs: progressAge,
            note: "步骤 " + (w.nodeId || w.id) + " 超过 " + Math.round(WATCHDOG.progressHardTimeoutMs / 60000) + " 分钟无有效进展" });
        }
      } else {
        w.progressStalled = false;
      }
      // macOS App Nap / 事件循环短暂停顿会让 dag 心跳晚到；只要 run-dag 进程还活着，就不把 WorkItem 判死。
      const ownerPid = parseInt(String(w.owner || "").replace(/^dag-/, ""), 10);
      const ownerDead = ownerPid > 0 && !pidAlive(ownerPid);
      // owner 已死不必等满 heartbeat 周期：立即进入 requeue 逻辑，避免“新 run-dag 活着但领不到旧 running 节点”。
      if (age < WATCHDOG.workHeartbeatMs && !ownerDead) return;
      if (!w.cancelRequested && ownerPid > 0 && pidAlive(ownerPid)) {
        w.heartbeatAt = new Date().toISOString();
        return;
      }
      if (w.cancelRequested || w.state === "cancelling") {
        w.state = "cancelled"; w.finishedAt = new Date().toISOString();
        w.error = "cancelled: worker lost heartbeat while cancelling"; w.leaseId = ""; w.leaseUntil = 0;
        emit("work.cancelled", "system", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, ok: false, cancelled: true, reason: w.error });
        return;
      }
      if (WATCHDOG.requeueOnLease && w.attempt < WATCHDOG.maxAttempts) {
        const backoff = Math.min(WATCHDOG.backoffMaxMs, WATCHDOG.backoffMs * Math.pow(2, Math.max(0, w.attempt - 1)));
        // 心跳超时说明旧员工大概率卡死；先杀掉旧进程，避免重派后两份模型调用并行烧 token。
        if (w.workerPid) {
          try { process.kill(-w.workerPid, "SIGTERM"); } catch (e) { try { process.kill(w.workerPid, "SIGTERM"); } catch (x) {} }
          w.workerPid = 0;
        }
        releaseWorkBudget(w, "watchdog.requeue");
        w.state = "queued"; w.owner = ""; w.leaseId = ""; w.leaseUntil = 0;
        w.heartbeatAt = null;
        w.retryAfter = now + backoff; w.error = "watchdog requeue: heartbeat timeout";
        emit("work.requeued", "system", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, attempt: w.attempt, retryAfter: w.retryAfter,
          reason: "heartbeat timeout", traceId: w.traceId });
      } else {
        w.state = "failed"; w.finishedAt = new Date().toISOString();
        w.error = "watchdog: heartbeat timeout, max attempts reached"; w.leaseId = ""; w.leaseUntil = 0;
        if (WATCHDOG.pauseOnExhausted) pausedCases.add(caseId);
        emit("work.failed", "system", { case: caseId, workId: w.id, planId: w.planId,
          agent: w.agent, nodeId: w.nodeId, ok: false, error: w.error, traceId: w.traceId });
        emit("watchdog.alert", "system", { case: caseId, agent: w.agent, nodeId: w.nodeId,
          workId: w.id, kind: "work_exhausted", ageMs: age, attempts: w.attempt,
          note: "WorkItem 心跳超时且重试耗尽，已暂停该 case 的新派发" });
      }
    });
  });
}
if (WATCHDOG.enabled) setInterval(watchdogPass, Math.max(500, WATCHDOG.intervalMs));

server.listen(PORT, HOST, () => {
  const base = "http://" + HOST + ":" + PORT;
  console.log("[broker] listening on " + base + "  root=" + ROOT);
  console.log("[broker] 实时看板  " + base + "/live?case=case-2026-001");
  console.log("[broker] 剧本原型  " + base + "/?proto=1");
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    const lan = lanAddress();
    const lanBase = "http://" + (lan || HOST) + ":" + PORT;
    console.log("[broker] 局域网看板  " + lanBase + "/live?case=case-2026-001" +
      (TOKEN ? "  （需要口令：URL 后加 ?token=<口令> 或走 /login）"
             : "  【警告】没设 --token：同网段任何人都能读写账本/下载文件"));
  }
  if (!DSH_BIN) console.log("[broker] ! 未找到 dsh：面板可看可配，但员工无法启动（用 DSH_BIN 指向 dsh）");
});

process.on("SIGINT", () => { emit("broker.stopped", "system", {}); process.exit(0); });
