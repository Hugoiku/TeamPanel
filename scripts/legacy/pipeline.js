#!/usr/bin/env node
/**
 * pipeline — 按 DAG 把 6 名员工各自作为独立 DSH 会话跑一遍
 *
 *   node scripts/pipeline.js --case case-2026-002
 *   node scripts/pipeline.js --case c --only macro,industry
 *
 * 每名员工的模型来自 Broker 里该员工的配置（面板左下角改的就是它），
 * 员工进程由 runtime/agents/employee.js 启动，互不共享会话模型。
 */
"use strict";
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BROKER = process.env.DESK_BROKER || "http://127.0.0.1:7801";
// 角色名单来自 config/desk.json（与 broker/employee 同源），缺配置时回落六角色
const CFG = (function loadConfig() {
  try { return JSON.parse(require("fs").readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); }
  catch (_) { return {}; }
})();
const AGENT_IDS = (CFG.agents || []).filter(a => a.role && a.id !== "lead").map(a => a.id);
const AGENT = (a) => (AGENT_IDS.length ? AGENT_IDS
  : ["macro", "industry", "stock", "audit", "legal", "trader"]).includes(a);
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BROKER + p);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      agent: false, method, headers: payload ? { "content-type": "application/json",
        "content-length": Buffer.byteLength(payload) } : {} }, res => {
      let data = ""; res.on("data", c => data += c);
      res.on("end", () => { let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}

// 任务文案必须由 mission 标的推导，不能写死某个行业/代码（否则换标的会整段跑偏）
let TARGET = "", CODE = "";
const TASKS = {
  macro: [
    "【本轮任务 · 宏观】",
    "- 范围：政策周期、流动性（社融/M1-M2/超储）、汇率与外部约束、财政；板块含义要落到 <TARGET> 所属产业链（先读 mission.md 与已有 research/ 产出确认标的，不要套用其它行业模板）",
    "- 期限：未来 6~12 个月；受众：内部投研（不对外）",
    "- 字数：正文 ≤2000 字（表格不算）",
    "- 分析路径：按技能 macro-method 的六步法走（定题→现状仪表盘→宏观季节→需求拆解→政策预判→市场验证→情景与风险）",
    "- 必答：1) 现状三要素（增长冷暖/通胀方向/金融条件松紧）2) 增长×通胀象限与政策约束 3) 需求拆解与可持续性 4) 政策方向+理由+掣肘 5) 市场定价与你的判断是否一致、分歧点 6) 最大风险触发器与传导链条 7) 待验证问题",
    "- 数据：本轮无 evidence/sources.jsonl，所有数字标「待补」，绝不编造；结论只能是方向判断 + 待验证清单",
    "- 交付：research/macro.md v1 + research/macro.json v1（claims 带 confidence 与 source），各报 G-DATA",
    "- 自检：写完对照 ROLE.md 的输出模板逐节检查，缺哪节就在交付说明里写明缺什么"
  ].join("\n"),
  industry: [
    "【本轮任务 · 行业】",
    "- 范围：<TARGET> 所属行业 4~6 段（格局、量价、供需、政策、竞争），≤2000 字；先读 mission.md 确认标的",
    "- 取数（优先新浪/Tushare，见技能 data-access）：用 node scripts/market quote --code <CODE> / tsu / cpi 取至少 3 条真实数据（标的行情、可比公司行情、相关宏观指标），把每条写入 evidence/sources.jsonl 并在正文引用 [S#]",
    "- 接口失败如实记录，不得用别的数字替代；取不到就标待补",
    "- 本轮不做案例抽样（不写 reports/sampling.json）",
    "- 交付：research/industry.md v1 + research/industry.json v1，各报 G-DATA"
  ].join("\n"),
  stock: [
    "【本轮任务 · 个股】",
    "- 输入：research/macro.md、research/industry.md、research/reverse_dcf.md（先 desk cat 读）",
    "- 取数（见技能 data-access）：用 node scripts/market quote --code <CODE> 取现价；node scripts/market tsu --api daily / income / fina_indicator 取近 8 季营收、净利、毛利率与日线，写入 evidence/sources.jsonl 并引用 [S#]",
    "- 口径：Tushare daily 是未复权收盘价，必须注明；财务用报告期，不用抓取日",
    "- 目标区间：参数不全（WACC/g/可比倍数）就留 null，写明还缺哪些参数；取到的数据要真的用上",
    "- 交付：research/stock.md v1 + research/stock.json v1，各报 G-DATA；接口失败如实记录"
  ].join("\n"),
  audit: "你是一条复核服务，不是流水线上的一站。先运行 ./scripts/desk review --list --service audit 看你的待复核队列（每条 = 某个产物的某个版本），逐条用 ./scripts/desk review --verdict --id R? --result pass|conditional|fail --finding \"具体修订项\" 出结论；结论只对那一个版本有效。然后照常把本轮意见写成 review/audit.md 与 review/audit.json（v1），并对队列里涉及的文件报 G-AUDIT。数字缺失是事实：如实写 L1=0 并给 conditional，不要替研究员补数字。若某条请求缺关键信息，用 desk need 上报后再给 conditional。",
  legal: "你是一条合规复核服务：先运行 ./scripts/desk review --list --service legal 看你的待复核队列（可能是研究底稿，也可能是交易计划），逐条用 ./scripts/desk review --verdict --id R? --result pass|conditional|fail --finding \"具体修订项\" 出结论（只对那个版本有效）。然后写 review/legal.md 与 review/legal.json（v1），对研究底稿报 G-LEGAL。审查点：内幕信息/MNPI、收益承诺、绝对化用语、评级外发口径、A0 免责声明。",
  trader: "基于 research/stock.md v1、review/audit.json v1、review/legal.json v1，写 trade/plan.md v1（≤300 字）与 trade/plan.json v1：给仓位结论（target_weight）、入场/止损框架。硬约束：审计 conditional=true 或 target_range=null 时不得建仓，给 0 仓位 + 恢复建仓的前置条件；不许编造价格。写完对两个文件各报 G-DATA。"
};

const taskFor = a => String(TASKS[a] || "")
  .replace(/<TARGET>/g, TARGET || "mission.md 里的标的")
  .replace(/<CODE>/g, CODE || "（代码见 mission.md）");

function run(agent, caseId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "runtime/agents/employee.js"),
      "--agent", agent, "--case", caseId, "--task", taskFor(agent)], { cwd: ROOT });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", (code) => {
      const lastErr = err.trim().split("\n").filter(Boolean).pop() || "";
      console.log("  [" + agent + "] exit=" + code + (code ? " " + lastErr : ""));
      resolve({ agent, code, out, err });
    });
  });
}

async function dispatch(agent, caseId) {
  const r = await api("POST", "/api/task", { case: caseId, agent, text: taskFor(agent).slice(0, 160) + "…", by: "lead" });
  if (r.status !== 200) console.log("  [" + agent + "] 派活失败", JSON.stringify(r.body));
}

async function finish(agent, caseId, res) {
  const ok = res.code === 0;
  await api("POST", "/api/task/done", { case: caseId, agent,
    summary: ok ? "本轮产出已通过 desk 落盘" : "本轮失败：" + (res.err.trim().split("\n").filter(Boolean).pop() || "exit " + res.code) });
}

// 汇编带图终稿：report.js 生成 figures/*.svg + final_report.md，再用 check-report 报 G-REPORT
function assemble(caseId) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/legacy/report.js"), "--case", caseId],
    { cwd: ROOT, encoding: "utf8" });
  const tail = String(r.stdout || "").trim().split("\n").slice(-2).join(" | ");
  console.log("[汇编] " + (r.status === 0 ? tail : ("report.js 失败 exit " + r.status + " " + String(r.stderr || "").slice(0, 200))));
  const chk = spawnSync(process.execPath, [path.join(ROOT, "scripts/check-report.js"), "--case", caseId, "--write"],
    { cwd: ROOT, encoding: "utf8" });
  const line = String(chk.stdout || "").split("\n").filter(l => /图表|引用|readiness|未通过/.test(l)).slice(-3).join(" | ");
  console.log("[汇编] check-report exit=" + chk.status + (line ? "（" + line.trim() + "）" : ""));
  return r.status === 0;
}

(async () => {
  const caseId = arg("case", "default");
  const only = (arg("only", "") || "").split(",").filter(Boolean);
  const h = await api("GET", "/api/health");
  if (h.status !== 200) { console.error("Broker 没起来:", BROKER); process.exit(2); }
  // 从 mission 推导标的与代码：任务文案不能写死行业/代码
  try {
    const s0 = await api("GET", "/api/snapshot?case=" + encodeURIComponent(caseId));
    const mission = (s0.body && s0.body.mission) || {};
    TARGET = mission.target || "mission.md 里的标的";
    CODE = (String(TARGET).match(/\d{6}/) || [""])[0];
  } catch (e) {
    console.error("读 mission 失败（继续用占位符）:", String(e && e.message || e));
  }
  // 循环保护：上一轮如果还在等用户查看/签发，不自动再跑一轮
  const cy = await api("GET", "/api/cycle?case=" + encodeURIComponent(caseId));
  const st = (cy.body && cy.body.cycle && cy.body.cycle.status) || "idle";
  if (process.argv.includes("--report-only")) {   // 只汇编带图终稿（不跑员工），用于调版式
    const ok = assemble(caseId);
    process.exit(ok ? 0 : 3);
  }
  if (st === "awaiting_review" && !process.argv.includes("--force")) {
    console.error("上一轮还没被用户确认（查看/签发），已停止：不会自动进入下一轮。要重跑加 --force。");
    process.exit(4);
  }
  if (st !== "running") await api("POST", "/api/event", { case: caseId, type: "cycle.started", actor: "lead" });
  const ms = (await api("GET", "/api/models?case=" + encodeURIComponent(caseId))).body || {};
  const modelOf = a => ((ms.byAgent && ms.byAgent[a]) || ms.default || {}).model || "?";
  async function reqReview(service, path, criteria) {
    const r = await api("POST", "/api/review/request", { case: caseId, service, path,
      requester: "lead", criteria });
    if (r.status === 200) console.log("  复核请求 " + service + " ← " + path +
      "（v" + r.body.review.version + "，第 " + r.body.review.round + " 轮）");
    else console.log("  复核请求失败（" + path + "）：" + JSON.stringify(r.body));
  }
  const stages = [
    ["宏观", ["macro"]],
    ["行业", ["industry"]],
    ["个股", ["stock"]],
    ["评审", ["audit", "legal"], async () => {
      await reqReview("audit", "research/macro.md", "数字与来源、结论是否过度断言");
      await reqReview("audit", "research/industry.md", "数字与来源、结论是否过度断言");
      await reqReview("audit", "research/stock.md", "数字与来源、估值参数是否可回溯");
      await reqReview("legal", "research/stock.md", "内幕/MNPI、收益承诺、绝对化用语、评级外发口径");
    }],
    ["交易前合规检查", [], async () => {
      const rd = await api("GET", "/api/cycle/readiness?case=" + encodeURIComponent(caseId));
      const blockers = (rd.body && rd.body.blockers) || [];
      const hard = blockers.filter(b => b.kind !== "need");
      if (hard.length) {
        console.error("复核未收敛，停在交易前：" + JSON.stringify(hard).slice(0, 400));
        await api("POST", "/api/cycle/fail", { case: caseId, stage: "交易前", agent: "audit",
          error: "复核未收敛：" + hard.map(b => b.kind + ":" + (b.id || "")).join(", ") });
        process.exit(3);
      }
    }],
    ["交易", ["trader"]],
    ["交易后合规", ["legal"], async () => {
      await reqReview("legal", "trade/plan.md", "交易计划合规：适当性、集中度、关联交易、限制名单");
    }]
  ];
  const results = [];
  console.log("case=" + caseId + "  模型来自 Broker 的员工配置");
  for (const [name, agents, hook] of stages) {
    if (hook) await hook();   // 阶段前置：生成复核请求 / 收敛检查
    const list = only.length ? agents.filter(a => only.includes(a)) : agents;
    if (!list.length) continue;
    console.log("[" + name + "] " + list.map(a => a + "=" + modelOf(a)).join("  "));
    for (const a of list) await dispatch(a, caseId);
    const rs = await Promise.all(list.map(a => run(a, caseId)));
    for (let i = 0; i < rs.length; i++) { await finish(list[i], caseId, rs[i]); results.push(rs[i]); }
    if (rs.some(r => r.code !== 0)) {
      const bad = rs.filter(r => r.code !== 0)[0];
      const err = String(bad.err || "").trim().split("\n").filter(Boolean).pop() || ("exit " + bad.code);
      await api("POST", "/api/cycle/fail", { case: caseId, stage: name, agent: bad.agent, error: err });
      console.error("阶段失败，停在 " + name + "（已登记 cycle.failed；修好后在面板点「重试这一阶段」）");
      process.exit(3);
    }
  }
  // 一轮跑完：先汇编带图终稿（--no-report 可跳过），再登记"等你查看"
  if (!process.argv.includes("--no-report")) assemble(caseId);
  const snap = await api("GET", "/api/snapshot?case=" + encodeURIComponent(caseId));
  const files = ((snap.body && snap.body.files) || []).filter(f => f.version > 0).length;
  const gates = Object.keys((snap.body && snap.body.gates) || {}).length;
  await api("POST", "/api/cycle/finish", { case: caseId, agent: "lead",
    files, gates, summary: results.length + " 名员工完成；终稿待 Lead 汇编/签发" });
  console.log("完成 " + results.length + " 名员工 · 文件 " + files + " 个 · 门禁 " + gates + " 条");
  console.log("已停止：本轮进入「等你查看/签发」，不会自动进入下一轮（要开新一轮请显式点面板「开始下一轮」或 --force）。");
  process.exit(0);
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
