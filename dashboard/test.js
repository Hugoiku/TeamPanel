#!/usr/bin/env node
/* 无浏览器验证：① 状态机断言 ② 三栏渲染在桩 DOM 上跑通 ③ 泳道图血缘完整性 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "mockup.html"), "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const simJs = blocks[0], appJs = blocks[blocks.length - 1];
let fails = [], passes = 0;
const ok = (c, m) => { c ? passes++ : fails.push(m); };

/* ---------- A. 状态机 ---------- */
const sb = { console, setTimeout(){return 1;}, clearTimeout(){}, setInterval(){return 1;},
  location: { search: "" }, fetch: () => Promise.reject(new Error("no fetch in stub")) };
sb.window = sb; sb.self = sb;
vm.createContext(sb);
vm.runInContext(simJs, sb);
const sim = sb.AlphaSim.createSim(), S = sim.state;
let t = 0; while (t < 130) { sim.step(0.05); t += 0.05; }

ok(Object.values(S.files).every(f => f.holders.length === 0), "结束时不应有残留锁");
ok(Object.values(S.files).every(f => f.queue.length === 0), "结束时不应有残留队列");
ok(!S.alerts.some(a => /越权/.test(a.text)), "不应出现越权写入");
ok(S.blocks.every(b => b.status === "done"), "不应有未关闭的工作块");
ok(S.blocks.filter(b => b.kind !== "note").every(b => b.steps.length > 0), "工作块应有步骤");
ok(S.mission.doneStages.join("/") === "S1/S2/S3/S4/S5", "阶段应为 5/6");
ok(S.mission.signoff === "awaiting", "应停留在等待签发");
ok(S.gates.filter(g => g.status === "pass").length === 3, "应有三道门禁通过");
ok(S.files["research/stock.md"].version === 2, "个股底稿应为 v2（经历退回重做）");
ok(S.events.some(e => e.kind === "wait"), "应有排队节点");
ok(S.events.some(e => e.kind === "fail"), "应有退回节点");
ok(S.events.some(e => e.kind === "merge"), "应有汇合节点");
ok(S.reports.length === 2, "应有两份交付物（宏观月报 + 终稿）");
ok(S.reports.some(r => r.type === "macro" && r.status === "published"), "宏观月报应已发布");
ok(S.events.some(e => e.type === "report.draft" && e.lane === "macro"), "起草报告应写进账本");
ok(S.events.some(e => e.type === "report.published"), "报告发布应有事件");
ok(S.files["reports/macro-2026-11.md"] && S.files["reports/macro-2026-11.md"].version === 1, "月报应有 v1 且走锁");
ok(sim.sign() === true, "签发应成功");
ok(S.events[S.events.length - 1].type === "report.published", "签发后应追加发布事件");

/* ---------- B. 血缘完整性 ---------- */
const bySeq = new Map(S.events.map(e => [e.seq, e]));
S.events.forEach(e => e.parents.forEach(p => ok(bySeq.has(p) && p < e.seq, "血缘指向非法：" + e.type + "#" + e.seq + "->" + p)));
const lanes = new Set(S.events.map(e => e.lane));
["macro", "industry", "stock", "audit", "legal", "trader", "lead"].forEach(l => ok(lanes.has(l), "缺少车道 " + l));

/* ---------- C. 三栏渲染 ---------- */
function mkEl(id) { return { id, innerHTML: "", textContent: "", __h: undefined, style: {}, className: "",
  value: "", disabled: false, placeholder: "", focus(){}, addEventListener(){}, 
  scrollHeight: 2000, scrollTop: 1800, clientHeight: 600,
  classList: { add(){}, remove(){}, toggle(){}, contains(){ return false } },
  querySelectorAll(){ return [] }, getAttribute(){ return null }, setAttribute(){}, parentNode: null,
  closest(){ return null }, appendChild(){}, onclick: null }; }
const els = {};
const doc = { getElementById(id){ if (!els[id]) els[id] = mkEl(id); return els[id]; },
  querySelectorAll(){ return [] }, createElement(){ return mkEl("x"); }, addEventListener(){} };
const sb2 = { document: doc, console, setTimeout(){return 1;}, clearTimeout(){}, setInterval(){return 1;},
  location: { search: "" }, fetch: () => Promise.reject(new Error("no fetch in stub")) };
sb2.window = sb2; sb2.self = sb2;
vm.createContext(sb2);
vm.runInContext(simJs, sb2);
const base = sb2.AlphaSim.createSim();
sb2.AlphaSim.createSim = function () { return base; };
let t2 = 0;
[1, 8, 20, 42, 63, 75, 81, 95, 108, 114, 121, 124].forEach(m => {
  while (t2 < m) { base.step(0.05); t2 += 0.05; }
  try { vm.runInContext(appJs, sb2); } catch (e) { fails.push("t=" + m + " 渲染异常: " + e.message); return; }
  const tl = els["timeline"].innerHTML, gr = els["graph"].innerHTML,
        lk = els["lockList"].innerHTML, ll = els["laneList"].innerHTML;
  ok(tl.indexOf("blk") >= 0, "t=" + m + " 中栏应有工作块");
  ok(gr.indexOf("<svg") >= 0 && (gr.match(/<rect/g) || []).length > 0, "t=" + m + " 右栏应有泳道图节点");
  ok(ll.indexOf("case-card") >= 0, "t=" + m + " 左栏应有任务线卡");
  ok(els["convHead"].innerHTML.indexOf("全部会话") >= 0, "t=" + m + " 默认应为全局会话视图");
  ok(/^\d\d:\d\d:\d\d$/.test(els["clock"].textContent), "t=" + m + " 时钟格式");
});
console.log("DEBUG_FAILS", JSON.stringify(fails));
// 终态：中栏必须出现"等待你签发"
ok(els["timeline"].innerHTML.indexOf("等待你签发") >= 0, "终态中栏应提示签发");
ok(els["lockList"].innerHTML.indexOf('class="frow') >= 0, "终态应有文件锁行");
ok(els["deliver"].innerHTML.indexOf("已发布") >= 0, "左栏交付物应显示已发布");

/* ---------- D. 员工对话与派活 ---------- */
const before = els["timeline"].innerHTML;
sb2.__sel("stock");
const conv = els["timeline"].innerHTML;
ok(conv !== before, "切到个股研究员后视图应变化");
ok(conv.indexOf("bubble") >= 0, "会话里应有气泡");
ok(conv.indexOf("个股研究员") >= 0, "会话头应是这位员工");
ok(els["convHead"].innerHTML.indexOf("个股研究员") >= 0, "会话头应显示员工名");
ok(els["msgInput"].disabled === false, "选中员工后输入框应可用");
ok(els["quick"].innerHTML.indexOf("追问依据") >= 0, "应有快捷追问");

const tasksBefore = base.state.tasks["stock"].length;
sb2.__send("把估值区间再收窄一点，DCF 那版太乐观");
ok(base.state.tasks["stock"].length === tasksBefore + 1, "派活后任务应入队");
ok(base.state.threads["stock"].some(m => m.from === "you" && /收窄/.test(m.text)), "你的消息应进会话线程");
ok(base.state.events.some(e => e.type === "task.assigned" && e.lane === "stock"), "派活应写进账本（task.assigned）");
ok(els["timeline"].innerHTML.indexOf("收窄") >= 0, "会话里应立刻出现你的消息");

// 推进时间，员工应答
let t4 = 0; while (t4 < 4) { base.step(0.05); t4 += 0.05; }
sb2.__sel("stock");
const answered = els["timeline"].innerHTML;
ok(base.state.threads["stock"].some(m => m.from === "stock" && /口径|区间|数据|确认/.test(m.text)), "员工应给出应答");
ok(answered.indexOf("回应你的追问") >= 0, "应答应生成一个工作块");

/* ---------- E. 模型配置 ---------- */
const DEF = { provider: "opencode-go", model: "deepseek-v4.1-flash" };
ok(base.state.models.default.provider === DEF.provider && base.state.models.default.model === DEF.model,
   "默认模型应为 opencode-go / deepseek-v4.1-flash");
ok(AlphaSimIds().every(id => base.state.models.byAgent[id] === undefined), "初始不应有员工级覆盖");
function AlphaSimIds() { return ["macro", "industry", "stock", "audit", "legal", "trader"]; }
sb2.__sel("all");
ok(els["modelbar"].innerHTML.indexOf("opencode-go") >= 0, "左下角应显示 provider");
ok(els["modelbar"].innerHTML.indexOf("deepseek-v4.1-flash") >= 0, "左下角应显示默认模型");
ok(els["modelbar"].innerHTML.indexOf("全员默认") >= 0, "全局视图下应标明这是全员默认");

sb2.__sel("stock");
sb2.__model(true);
ok(els["modelbar"].innerHTML.indexOf("个股研究员 使用的模型") >= 0, "选中员工后应显示该员工的模型面板");
sb2.__send("换模型继续"); // 保底，确保会话可用
const beforeEvents = base.state.events.length;
base.setModel("stock", "opencode-go", "deepseek-v4.1");
ok(base.state.models.byAgent.stock.model === "deepseek-v4.1", "员工级覆盖应生效");
ok(base.state.models.default.model === "deepseek-v4.1-flash", "默认不应被员工覆盖影响");
ok(base.state.events.length > beforeEvents, "切模型应写进账本");
ok(base.state.events.some(e => e.type === "model.changed" && e.lane === "stock"), "应记录 model.changed 事件");
sb2.__sel("stock");
ok(els["convHead"].innerHTML.indexOf("deepseek-v4.1") >= 0, "会话头应显示该员工的模型");

/* ---------- F. 新建模型配置 ---------- */
ok(base.state.models.catalog.length === 4, "内置目录应为 4 个模型");
ok(base.state.models.catalog.every(m => m.builtin), "内置模型应标记 builtin");

sb2.__sel("stock");
sb2.__newModel();
sb2.__fillModel({ provider: "acme", model: "reason-1", label: "ACME Reason 1", base: "https://api.acme.ai/v1", ctx: "200000", key: "sk-plaintext-123" });
ok(sb2.__saveModel() === false, "明文 Key 应被拒绝");
ok(els["fErr"].textContent.indexOf("明文") >= 0, "错误提示应说明不接受明文");

sb2.__fillModel({ provider: "acme", model: "reason-1", label: "ACME Reason 1", base: "not-a-url", ctx: "200000", key: "env:ACME_KEY" });
ok(sb2.__saveModel() === false, "非法 Base URL 应被拒绝");

sb2.__fillModel({ provider: "acme", model: "reason-1", label: "ACME Reason 1", base: "https://api.acme.ai/v1", ctx: "200000", key: "env:ACME_KEY" });
ok(sb2.__saveModel() === true, "合法配置应保存成功");
ok(base.state.models.catalog.length === 5, "目录应新增一条");
const added = base.state.models.catalog[4];
ok(added.builtin === false && added.provider === "acme", "新增项应标记为非内置");
ok(base.state.models.byAgent.stock.provider === "acme", "保存后应自动应用到当前员工");
ok(base.state.events.some(e => e.type === "model.added"), "新建模型应写进账本");
ok(!JSON.stringify(base.state.models.catalog).includes("sk-plaintext"), "账本与目录都不应出现明文 Key");

sb2.__fillModel({ provider: "acme", model: "reason-1", key: "env:K" });
ok(sb2.__saveModel() === false, "重复模型应被拒绝");

ok(sb2.__sel("stock") === undefined, "切回员工视图不应报错");

/* ---------- G. 技能与插件 ---------- */
ok(base.state.skills.catalog.length === 8, "内容库应为 8 条");
ok(base.state.skills.catalog.some(s => !s.installed), "库中应有未安装的条目");
ok(base.state.skills.catalog.every(s => s.ver && s.author && s.doc), "每条都应有版本/作者/文档预览");
ok(base.state.skills.catalog.some(s => s.kind === "plugin"), "目录里应区分 skill 与 plugin");
ok(base.state.skills.catalog.some(s => s.perms && s.perms.sensitive), "应有标记为敏感的条目");
ok(base.skillsOf("stock").length === 2, "个股研究员应装配 2 个技能");
ok(base.skillsOf("legal").indexOf("compliance-cn") >= 0, "法律顾问应装配合规规则库");
ok(base.state.skills.loaded.length >= 2, "剧本里应有加载技能的动作");
ok(base.state.events.some(e => e.type === "skill.loaded" && e.lane === "stock"), "加载技能应写进账本");

const beforeSkills = base.skillsOf("stock").length;
base.toggleSkill("stock", "chart-render", true);
ok(base.skillsOf("stock").length === beforeSkills + 1, "授权后技能数应 +1");
ok(base.state.events.some(e => e.type === "skill.granted" && e.lane === "stock"), "授权应写进账本");
base.toggleSkill("stock", "chart-render", false);
ok(base.skillsOf("stock").length === beforeSkills, "收回后应回到原状");

sb2.__sel("stock");
ok(els["convHead"].innerHTML.indexOf("技能 2") >= 0, "会话头应显示技能数");
sb2.__skills("stock");
ok(els["sList"].innerHTML.indexOf("valuation-dcf") >= 0, "库列表应列出技能");
ok(els["sList"].innerHTML.indexOf("未安装") >= 0, "库列表应标出未安装条目");
ok(els["sDetail"].innerHTML.indexOf("v1.4.0") >= 0, "详情应显示版本");
ok(els["sDetail"].innerHTML.indexOf("description:") >= 0, "详情应展示 SKILL.md 预览");
ok(els["sDetail"].innerHTML.indexOf("装配给") >= 0 || els["sDetail"].innerHTML.indexOf("撤回") >= 0, "详情应有装配动作");
ok(els["sCats"].innerHTML.indexOf("合规") >= 0, "应有分类筛选");

// 库操作：未安装不能装配；安装后可装配
ok(base.toggleSkill("trader", "peer-scraper", true) === false, "未安装的技能不能装配");
base.installSkill("peer-scraper", true);
ok(base.state.skills.catalog.filter(s => s.id === "peer-scraper")[0].installed === true, "安装后应变为已装");
ok(base.toggleSkill("trader", "peer-scraper", true) === true, "安装后可装配");
base.installSkill("peer-scraper", false);
ok(base.state.skills.byAgent.trader.indexOf("peer-scraper") < 0, "从库移除时应同时撤销所有装配");
ok(base.state.events.some(e => e.type === "skill.installed"), "安装应写进账本");

/* ---------- H. 能力预检 + 申请与审批 ---------- */
const pf = base.state.blocks.filter(b => b.kind === "preflight");
ok(pf.length === 1, "应有 1 次能力预检");
ok(pf[0].plan.need.length === 3 && pf[0].plan.have.length === 2, "预检应算出需 3 项、已有 2 项");
ok(pf[0].plan.missing.join() === "peer-scraper", "缺失项应为 peer-scraper");
ok(base.state.events.some(e => e.type === "capability.plan"), "预检应写进账本");
ok(base.planNeeds("audit", "核验引用").indexOf("citation-check") >= 0, "关键词应能推出能力需求");

const simB = sb.AlphaSim ? null : null;
const s5 = base.state.skills.requests;
ok(s5.length === 1, "剧本里应有一条能力申请");
ok(s5[0].agent === "stock" && s5[0].skillId === "peer-scraper", "申请来自个股研究员且是 peer-scraper");
ok(s5[0].status === "pending", "初始应为待审批");
ok(base.state.events.some(e => e.type === "capability.requested"), "申请应写进账本");

sb2.__sel("stock");
ok(els["timeline"].innerHTML.indexOf("待审批") >= 0, "会话里应出现审批卡");
ok(els["timeline"].innerHTML.indexOf("批准并装配") >= 0, "审批卡应给出批准按钮");
ok(els["capBadge"].textContent.indexOf("待审批") >= 0, "顶栏应显示待审批数量");

const beforeInstall = base.skillById("peer-scraper").installed;
const res5 = base.decideCapability(s5[0].id, true);
ok(res5.ok === true, "批准应成功");
ok(base.skillById("peer-scraper").installed === true, "批准后应安装到库");
ok(base.skillsOf("stock").indexOf("peer-scraper") >= 0, "批准后应装配给该员工");
ok(base.state.events.some(e => e.type === "capability.approved"), "批准应写进账本");
ok(base.state.threads.stock.some(m => /已拿到|不装了/.test(m.text)), "员工应收到结果并回执");
ok(base.decideCapability(s5[0].id, true).ok === false, "重复审批应被拒绝");

console.log("\n通过 " + passes + " 项检查");
if (fails.length) { console.log("失败 " + fails.length + " 项:"); fails.forEach(f => console.log("  ✗ " + f)); process.exit(1); }
console.log("✓ 全部通过：状态机无死锁/无越权；三栏渲染正常；泳道图血缘完整");
