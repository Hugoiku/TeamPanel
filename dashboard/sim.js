/* AlphaDesk v2 — 三栏面板用的确定性模拟状态机（无 DOM，可 node 单测）
 * 真相 = events（账本），其余（泳道图、轨迹、锁队列）都是它的投影。
 * 锁模型：共享读 R（多持有者）/ 独占写 W / 严格 FIFO / 租约 / 写优先 / 重入双车道。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AlphaSim = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var AGENTS = [
    { id: "macro",    name: "宏观研究员", group: "基础", glyph: "宏" },
    { id: "industry", name: "行业研究员", group: "基础", glyph: "行" },
    { id: "stock",    name: "个股研究员", group: "基础", glyph: "股" },
    { id: "audit",    name: "信息审计",   group: "高级", glyph: "审" },
    { id: "legal",    name: "法律顾问",   group: "高级", glyph: "法" },
    { id: "trader",   name: "交易员",     group: "高级", glyph: "交" }
  ];
  var STAGES = [
    { id: "S1", label: "宏观" }, { id: "S2", label: "行业" }, { id: "S3", label: "个股" },
    { id: "S4", label: "评审" }, { id: "S5", label: "交易" }, { id: "S6", label: "汇编" }
  ];
  var TTL = 60;

  function kindOf(type) {
    if (type === "file.written") return "commit";
    if (type === "lock.queued") return "wait";
    if (type === "gate.passed") return "pass";
    if (type === "gate.failed") return "fail";
    if (type === "retry.opened") return "fail";
    if (type === "handoff") return "handoff";
    if (type === "report.assembled") return "merge";
    if (type === "sign.pending") return "sign";
    if (type === "mission.created") return "mission";
    if (type === "context.compacted") return "compact";
    return "handoff";
  }

  function createSim() {
    var state = {
      t: 0, wallStart: 21 * 3600 + 58 * 60, ttl: TTL,
      mission: { caseId: "case-2026-001", ticker: "600519 贵州茅台",
        mandate: "白酒景气与护城河，输出可执行配置建议",
        stage: "S1", doneStages: [], signoff: "pending" },
      agents: {}, files: {}, blocks: [], events: [], alerts: [], gates: [
        { id: "G-DATA",  label: "数据可溯源",   status: "pending", note: "关键财务数字带 [S#]" },
        { id: "G-AUDIT", label: "信息审计通过", status: "pending", note: "覆盖率 ≥ 90%" },
        { id: "G-LEGAL", label: "法律合规通过", status: "pending", note: "无 BLOCK 级表述" },
        { id: "G-SAMPLE", label: "抽样偏差控制", status: "na", note: "仅行业 case：抽样申报 + 反例清单" },
        { id: "G-SIGN",  label: "人类签发",     status: "pending", note: "由你批准发布" }
      ],
      graphEvents: [], // 供泳道图使用（含 parents）
      threads: {}, tasks: {}, unread: {},
      reports: [], // 交付物台账：底稿 / 内部报告 / 对外报告 / 终稿
      skills: {
        // 内容库：工作区里所有"可挑选"的技能与插件
        catalog: [
          { id: "valuation-dcf", name: "valuation-dcf", cat: "research", kind: "skill", ver: "1.4.0",
            author: "research-pack", source: "builtin", installed: true, size: "12 KB",
            desc: "DCF 三表联动估值与敏感性分析",
            doc: "name: valuation-dcf\ndescription: Use when valuing a company with a DCF model, stress-testing WACC or terminal growth, or sanity-checking a target range against comparables.\n\n1. Build the 3-statement model from the last 8 quarters.\n2. Run the 5x5 WACC/terminal-growth sensitivity grid.\n3. Cross-check the implied multiple against the comp set." },
          { id: "office-xlsx", name: "office-xlsx", cat: "office", kind: "skill", ver: "2.1.3",
            author: "deepseek/office", source: "builtin", installed: true, size: "48 KB",
            desc: "Excel 读写、公式重算与校验",
            doc: "name: office-xlsx\ndescription: Use when creating, editing, recalculating or validating .xlsx workbooks.\n\n- Read/write cells and ranges without losing styles.\n- Recalculate formulas and verify cached values." },
          { id: "citation-check", name: "citation-check", cat: "compliance", kind: "skill", ver: "0.9.2",
            author: "audit-pack", source: "workspace", installed: true, size: "8 KB",
            desc: "逐条核验论断来源与覆盖",
            doc: "name: citation-check\ndescription: Use when auditing whether each claim in a report has a traceable source.\n\n1. Extract claims. 2. Resolve [S#] to sources.jsonl. 3. Flag unsupported claims." },
          { id: "compliance-cn", name: "compliance-cn", cat: "compliance", kind: "skill", ver: "3.0.0",
            author: "legal-team", source: "workspace", installed: true, size: "156 KB",
            desc: "境内披露与合规规则库", perms: { sensitive: true },
            doc: "name: compliance-cn\ndescription: Use when reviewing research text that may be published to clients in mainland China.\n\n- Banned: absolute claims, unpublished material information.\n- Required: disclaimer block." },
          { id: "chart-render", name: "chart-render", cat: "viz", kind: "skill", ver: "1.1.0",
            author: "deepseek/charts", source: "builtin", installed: true, size: "22 KB",
            desc: "图表渲染为 SVG/PNG",
            doc: "name: chart-render\ndescription: Use when a report needs charts.\n\nRenders series to SVG or PNG with consistent styling." },
          { id: "industry-db", name: "industry-db", cat: "data", kind: "plugin", ver: "0.6.1",
            author: "data-platform", source: "remote", installed: true, size: "1.2 MB",
            desc: "行业库查询（需放行外网）", perms: { net: ["api.industrydb.com"] },
            doc: "name: industry-db\ndescription: Use when you need industry shipment, inventory or price data.\n\nRegisters tool: query_industry(metric, region, period).\nRequires network allowlist: api.industrydb.com" },
          { id: "peer-scraper", name: "peer-scraper", cat: "data", kind: "plugin", ver: "0.2.0",
            author: "community", source: "remote", installed: false, size: "340 KB",
            desc: "抓取可比公司披露（第三方，未审计）", perms: { net: ["*"], unvetted: true },
            doc: "name: peer-scraper\ndescription: Scrape peer filings from public sources.\n\nWARNING: unvetted community plugin, requests unrestricted network." },
          { id: "sample-audit", name: "sample-audit", cat: "compliance", kind: "skill", ver: "1.0.0",
            author: "audit-pack", source: "workspace", installed: true, size: "6 KB",
            desc: "G-SAMPLE 抽样偏差核验清单",
            doc: "name: sample-audit\ndescription: Use when an industry case samples individual companies as evidence.\n\n1. Read sampling.json. 2. Verify coverage of extreme strata. 3. Require counter-cases." }
        ],
        byAgent: {
          macro: ["chart-render"],
          industry: ["industry-db", "office-xlsx"],
          stock: ["valuation-dcf", "office-xlsx"],
          audit: ["citation-check", "sample-audit"],
          legal: ["compliance-cn"],
          trader: ["office-xlsx"]
        },
        loaded: [],
        requests: [] // 员工发起的"申请使用某能力"，必须由你批准
      },
      models: {
        default: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
        byAgent: {}, // 员工级覆盖；未设置则跟随默认
        catalog: [
          { id: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", model: "deepseek-v4.1-flash",
            label: "DeepSeek V4.1 Flash", ctx: 128000, tools: true, tag: "默认 · 快", builtin: true },
          { id: "opencode-go/deepseek-v4.1", provider: "opencode-go", model: "deepseek-v4.1",
            label: "DeepSeek V4.1", ctx: 128000, tools: true, tag: "强推理", builtin: true },
          { id: "opencode-go/deepseek-v3.2", provider: "opencode-go", model: "deepseek-v3.2",
            label: "DeepSeek V3.2", ctx: 64000, tools: true, tag: "上一代", builtin: true },
          { id: "deepseek/deepseek-v4.1-flash", provider: "deepseek", model: "deepseek-v4.1-flash",
            label: "DeepSeek V4.1 Flash（直连）", ctx: 128000, tools: true, tag: "直连", builtin: true }
        ]
      }
    };
    AGENTS.forEach(function (a) {
      state.agents[a.id] = { id: a.id, name: a.name, group: a.group, glyph: a.glyph,
        status: "idle", activity: "待命", file: null, since: 0 };
      state.threads[a.id] = [];
      state.tasks[a.id] = [];
      state.unread[a.id] = 0;
    });

    var seq = 0, lastByLane = {}, blockSeq = 0;

    /* ---------- 事件与区块 ---------- */
    function emit(type, actor, lane, label, opts) {
      opts = opts || {};
      var parents = opts.parents;
      if (parents === undefined) parents = lastByLane[lane] ? [lastByLane[lane]] : [];
      seq += 1;
      var e = { seq: seq, t: state.t, type: type, actor: actor, lane: lane, label: label,
        parents: parents, path: opts.path || null, v: opts.v || 0,
        kind: opts.kind || kindOf(type), short: opts.short || null };
      state.events.push(e);
      lastByLane[lane] = seq;
      return e;
    }
    var msgSeq = 0, taskSeq = 0, pendingReplies = [];
    function pushMsg(agentId, from, text, kind) {
      msgSeq += 1;
      var m = { id: msgSeq, from: from, t: state.t, text: text, kind: kind || "chat", taskId: null };
      state.threads[agentId].push(m);
      if (from !== "you") state.unread[agentId] = (state.unread[agentId] || 0) + 1;
      return m;
    }
    function noteSay(agentId, text) { return pushMsg(agentId, agentId, text, "reply"); }

    // 应答：先按关键词路由，再按角色兜底。原型里是剧本，真实系统里这里是 Agent 的模型输出。
    var REPLY_RULES = {
      macro: [
        { re: /汇率/, t: "汇率是这轮最大的变量：人民币若破 7.4，出口链受益，但外资流出压力会同步放大。我把它标成核心风险。" },
        { re: /依据|为什么|凭什么|来源/, t: "依据是三家券商的中央经济工作会议解读 + 央行三季度货币政策执行报告，条目都在证据台账 S03-S07。" },
        { re: /假设|重算|口径/, t: "好，我把政策利率假设从 2.0% 调到 1.8% 重算，方向不变、斜率更陡，结论不用改。" },
        { re: /降准|宽松|四季度/, t: "四季度我判断还有一次降准，幅度 25bp，时点大概率在 11 月中。触发条件是社融增速掉到 8% 以下。" }
      ],
      industry: [
        { re: /库存|渠道/, t: "渠道库存 1.5 个月，比去年同期少 0.4 个月；但次高端动销同比 -8%，压力集中在那里。" },
        { re: /竞争|份额|格局/, t: "高端三家的市占率 62%/18%/9%，第二家今年在江苏被抢了 2 个点，我补一版份额拆解。" },
        { re: /依据|来源|数/, t: "渠道数据来自 6 个经销商的抽样访谈 + 两家咨询公司的月度跟踪，抽样口径我写在附录。" }
      ],
      stock: [
        { re: /估值|区间|DCF|贵|便宜/, t: "估值给两条线：可比公司法 1650-1780，DCF 1720-1820。收窄的关键是永续增长率，我现在用 2.5%；调到 2.0% 下限就是 1650。你要我按哪版定稿？" },
        { re: /毛利|产能|财务/, t: "近 8 季毛利率 91.2%→91.6%，产能利用率 87%，经营现金流/净利润 1.03，质量没问题。" },
        { re: /依据|来源|为什么/, t: "产能数据来自 [S14] 年报附注，吨价来自 [S15] 渠道调研，这两条正是审计上次打回的地方，已经补了。" },
        { re: /假设|乐观|保守/, t: "乐观版假设吨价年增 6%、产能利用率 92%；保守版 3% 和 85%。两版区间差 170 元，我把两版都放附录。" }
      ],
      audit: [
        { re: /来源|依据|核/, t: "我复核了：这 3 条里 2 条能追到一手数据，1 条只有二手转述，已标 unsupported。" },
        { re: /覆盖|通过/, t: "当前覆盖率 94%，高于 90% 的门槛；剩下 6% 是行业规模这类软数据，我标了置信度。" },
        { re: /放|通融|算了/, t: "不能放。缺来源的论断一旦进报告，责任会落在这份报告上，我建议作者补证。" }
      ],
      legal: [
        { re: /风险|违规|内幕/, t: "两处风险：一是「必涨」这类绝对化用语，二是引用了未公开的渠道数据。前者改表述，后者建议删。" },
        { re: /免责|声明|合规/, t: "免责声明已加，附录会列全部数据来源。结论可以保留，但必须写明「不构成投资建议」。" },
        { re: /放|通融|算了/, t: "可以放行，前提是把那两处改掉。改了我就出法律意见通过。" }
      ],
      trader: [
        { re: /仓位|买|建仓/, t: "仓位 5%，分两档：1680 一半、1620 一半。单日成交额能容纳，冲击成本约 8bp。" },
        { re: /止损|风险/, t: "止损 1580/1520，跌破第二档直接清。最大回撤控制在 4.2%。" },
        { re: /依据|为什么/, t: "依据是审计通过的底稿 + 过去 20 日 ATR，波动率允许这个仓位。" }
      ]
    };
    var REPLY_DEFAULT = ["收到，我这就处理。", "明白，我补完之后同步给你。", "记下了，我按这个口径重做一版。"];
    function pickReply(agentId, text, taskId) {
      var rules = REPLY_RULES[agentId] || [];
      for (var i = 0; i < rules.length; i++) if (rules[i].re.test(text)) return rules[i].t;
      return REPLY_DEFAULT[taskId % REPLY_DEFAULT.length];
    }

    function assignTask(agentId, text, silent) {
      taskSeq += 1;
      var task = { id: taskSeq, t: state.t, text: text, status: "queued" };
      state.tasks[agentId].push(task);
      var m = pushMsg(agentId, "you", text, "task");
      m.taskId = task.id;
      emit("task.assigned", "you", agentId, "任务 → " + state.agents[agentId].name, { kind: "task" });
      if (!silent) pendingReplies.push({ at: state.t + 2.5, agentId: agentId, task: task });
      return m;
    }
    function deliverReply(p) {
      var text = pickReply(p.agentId, p.task.text, p.task.id);
      p.task.status = "answered";
      var b = { id: ++blockSeq, agent: p.agentId, title: "回应你的追问", kind: "work",
        t0: state.t - 3, t1: state.t, steps: [
          { label: "读取当前底稿与上下文", dur: 1, kind: "read" },
          { label: "整理答复", dur: 2, kind: "think" }],
        text: "", artifact: null, status: "done" };
      state.blocks.push(b);
      noteSay(p.agentId, text);
    }

    function startBlock(agent, title, file) {
      blockSeq += 1;
      var b = { id: blockSeq, agent: agent, title: title, file: file || null,
        t0: state.t, t1: null, steps: [], text: "", artifact: null, status: "running" };
      state.blocks.push(b);
      return b;
    }
    function addStep(b, label, dur, kind) {
      if (!b) return;
      b.steps.push({ label: label, dur: dur, kind: kind || "tool" });
    }
    function endBlock(b, text, artifact) {
      if (!b) return;
      b.t1 = state.t; b.text = text || ""; b.status = "done";
      if (artifact) b.artifact = artifact;
    }
    function currentBlock(agentId) {
      for (var i = state.blocks.length - 1; i >= 0; i--) {
        if (state.blocks[i].agent === agentId && state.blocks[i].status === "running") return state.blocks[i];
      }
      return null;
    }
    var reportSeq = 0;
    function openReport(agentId, type, title, external, file) {
      reportSeq += 1;
      var r = { id: reportSeq, type: type, title: title, external: !!external, file: file,
        v: 0, status: "draft", author: agentId, t0: state.t, t1: null };
      state.reports.push(r);
      var b = startBlock(agentId, title, file);
      b.kind = "report";
      b.report = r;
      emit("report.draft", agentId, agentId, title + " · 起草", { kind: "report", short: "月报" });
      return r;
    }
    function agentModel(id) { return state.models.byAgent[id] || state.models.default; }
    function skillById(sid) {
      return state.skills.catalog.filter(function (s) { return s.id === sid; })[0] || null;
    }
    function skillsOf(id) {
      return (state.skills.byAgent[id] || []).filter(function (sid) {
        var s = skillById(sid);
        return s && s.installed;
      });
    }
    function installSkill(sid, on) {
      var s = skillById(sid);
      if (!s) return { ok: false, error: "技能不存在" };
      if (s.installed === on) return { ok: true };
      s.installed = on;
      if (!on) {
        Object.keys(state.skills.byAgent).forEach(function (a) {
          state.skills.byAgent[a] = state.skills.byAgent[a].filter(function (x) { return x !== sid; });
        });
      }
      emit(on ? "skill.installed" : "skill.uninstalled", "lead", "lead",
        (on ? "安装到库：" : "从库移除：") + s.name, { kind: "handoff", short: on ? "装库" : "卸库" });
      return { ok: true };
    }
    function toggleSkill(agentId, skillId, on) {
      var target = skillById(skillId);
      if (!target) return false;
      if (target.installed === false) return false; // 未安装不能装配
      var list = state.skills.byAgent[agentId] = state.skills.byAgent[agentId] || [];
      var has = list.indexOf(skillId) >= 0;
      if (on === undefined) on = !has;
      if (on && !has) list.push(skillId);
      if (!on && has) state.skills.byAgent[agentId] = list.filter(function (x) { return x !== skillId; });
      var sk = state.skills.catalog.filter(function (s) { return s.id === skillId; })[0] || { name: skillId };
      emit(on ? "skill.granted" : "skill.revoked", agentId, agentId,
        (on ? "授予技能：" : "收回技能：") + sk.name, { kind: "handoff", short: on ? "授技能" : "收技能" });
      return on;
    }
    var capSeq = 0;
    // 任务 → 能力需求（关键词 + 角色默认）。真实系统里由任务的 capability contract 声明。
    var NEED_RULES = [
      { re: /估值|DCF|区间|贵|便宜|可比|同行/, ids: ["valuation-dcf", "peer-scraper"] },
      { re: /财务|数据|表|Excel|重算/, ids: ["office-xlsx"] },
      { re: /图|可视化|chart/i, ids: ["chart-render"] },
      { re: /来源|核验|证据|引用/, ids: ["citation-check"] },
      { re: /合规|披露|免责|审查/, ids: ["compliance-cn"] },
      { re: /行业|供需|库存|景气/, ids: ["industry-db"] },
      { re: /抽样|偏差|反例/, ids: ["sample-audit"] }
    ];
    var ROLE_DEFAULTS = {
      macro: ["chart-render"], industry: ["industry-db", "office-xlsx"],
      stock: ["valuation-dcf", "office-xlsx"], audit: ["citation-check"],
      legal: ["compliance-cn"], trader: ["office-xlsx"]
    };
    function planNeeds(agentId, text) {
      var ids = (ROLE_DEFAULTS[agentId] || []).slice();
      NEED_RULES.forEach(function (r) {
        if (r.re.test(text || "")) r.ids.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
      });
      return ids;
    }
    function preflight(agentId, text) {
      var need = planNeeds(agentId, text);
      var have = skillsOf(agentId);
      var missing = need.filter(function (id) { return have.indexOf(id) < 0; });
      var b = startBlock(agentId, "能力预检", null);
      b.kind = "preflight";
      b.plan = { need: need, have: have, missing: missing };
      addStep(b, "拆解任务所需能力", 1, "think");
      addStep(b, "比对当前装配", 1, "tool");
      endBlock(b, missing.length
        ? "缺 " + missing.length + " 项：" + missing.join(", ")
        : "所需能力齐全，可以开工。", null);
      emit("capability.plan", agentId, agentId,
        "能力预检：需 " + need.length + " 项 / 缺 " + missing.length + " 项",
        { kind: "handoff", short: "预检" });
      missing.forEach(function (id) {
        var sk = skillById(id);
        requestCapability(agentId, id, "任务需要" + (sk ? "「" + sk.desc + "」" : "") + "，当前装配里没有。", "case");
      });
      return { need: need, have: have, missing: missing };
    }
    function requestCapability(agentId, skillId, reason, scope) {
      var sk = skillById(skillId);
      if (!sk) return null;
      capSeq += 1;
      var req = { id: capSeq, agent: agentId, skillId: skillId, reason: reason || "",
        scope: scope || "case", status: "pending", t: state.t, decidedAt: null };
      state.skills.requests.push(req);
      emit("capability.requested", agentId, agentId, "申请使用：" + sk.name, { kind: "handoff", short: "申请" });
      pushMsg(agentId, agentId, "我需要用 " + sk.name + "（" + sk.desc + "）。" +
        (reason ? reason + " " : "") + "这是能力申请，得你批准我才能用。", "request");
      return req;
    }
    function decideCapability(reqId, approved) {
      var req = state.skills.requests.filter(function (r) { return r.id === reqId; })[0];
      if (!req || req.status !== "pending") return { ok: false, error: "该申请已处理" };
      var sk = skillById(req.skillId) || { name: req.skillId };
      req.status = approved ? "approved" : "denied";
      req.decidedAt = state.t;
      if (approved) {
        installSkill(req.skillId, true);
        toggleSkill(req.agent, req.skillId, true);
      }
      emit(approved ? "capability.approved" : "capability.denied", "you", req.agent,
        (approved ? "批准：" : "拒绝：") + sk.name + " → " + state.agents[req.agent].name,
        { kind: "handoff", short: approved ? "批准" : "拒绝" });
      pushMsg(req.agent, req.agent, ap_after(approved, sk), "reply");
      return { ok: true, status: req.status };
    }
    function ap_after(approved, sk) {
      return approved ? "已拿到 " + sk.name + "，我把可比公司那段补上。"
                      : "明白，不装了。我用现有数据凑合，并在结论里标注证据强度。";
    }
    function loadSkill(agentId, skillId) {
      var sk = state.skills.catalog.filter(function (s) { return s.id === skillId; })[0];
      if (!sk) return null;
      state.skills.loaded.push({ agent: agentId, id: skillId, t: state.t });
      emit("skill.loaded", agentId, agentId, "加载技能：" + sk.name, { kind: "handoff", short: "加载" });
      addStep(currentBlock(agentId), "加载技能 " + sk.name, 1, "sys");
      return sk;
    }
    function findModel(provider, model) {
      return state.models.catalog.filter(function (m) { return m.provider === provider && m.model === model; })[0] || null;
    }
    function addModel(cfg) {
      // 校验在面板侧；这里兜底
      if (!cfg.provider || !cfg.model) return { ok: false, error: "provider 与模型 ID 必填" };
      if (findModel(cfg.provider, cfg.model)) return { ok: false, error: "该 provider 下已存在同名模型" };
      var entry = {
        id: cfg.provider + "/" + cfg.model, provider: cfg.provider, model: cfg.model,
        label: cfg.label || cfg.model, ctx: cfg.ctx || 128000, tools: true,
        tag: "自建", builtin: false, base_url: cfg.base_url || "", key_ref: cfg.key_ref || ""
      };
      state.models.catalog.push(entry);
      emit("model.added", "lead", "lead", "新增模型配置：" + entry.provider + " / " + entry.model,
        { kind: "model", short: "新模型" });
      return { ok: true, entry: entry };
    }
    function removeModel(id) {
      var m = findModel(id.split("/")[0], id.slice(id.indexOf("/") + 1));
      if (!m || m.builtin) return { ok: false, error: "内置模型不可删除" };
      state.models.catalog = state.models.catalog.filter(function (x) { return x.id !== m.id; });
      return { ok: true };
    }
    function setModel(agentId, provider, model) {
      if (agentId) state.models.byAgent[agentId] = { provider: provider, model: model };
      else state.models.default = { provider: provider, model: model };
      var who = agentId ? state.agents[agentId].name : "全体员工";
      emit("model.changed", agentId || "lead", agentId || "lead", who + " → " + model,
        { kind: "model", short: "切模型" });
      noteSay(agentId || "macro", "已切到 " + model + "，我继续。");
    }
    function publishReport(r) {
      r.status = "published"; r.t1 = state.t;
      emit("report.published", r.author, "lead", "发布：" + r.title, { kind: "publish", short: "已发布" });
      noteSay(r.author, "「" + r.title + "」已发布，证据附录和法律意见都挂上了。");
    }
    function note(agentId, text) {
      state.blocks.push({ id: ++blockSeq, agent: agentId, title: "说明", kind: "note",
        t0: state.t, t1: state.t, steps: [], text: text, artifact: null, status: "done" });
    }
    function gateSet(id, status, note) {
      state.gates.forEach(function (g) { if (g.id === id) { g.status = status; if (note) g.note = note; } });
      if (status === "pass") {
        state.alerts.forEach(function (a) {
          if (a.level === "danger" && a.text.indexOf(id) >= 0) a.resolved = true;
        });
      }
    }
    function alert(level, text, agentId) {
      state.alerts.unshift({ t: state.t, level: level, text: text, agent: agentId || null });
      if (state.alerts.length > 8) state.alerts.pop();
    }
    function setStatus(id, status, activity, path) {
      var a = state.agents[id];
      if (a.status !== status) a.since = state.t;
      a.status = status; a.activity = activity; a.file = path || null;
    }

    /* ---------- 文件与锁 ---------- */
    function file(path) {
      if (!state.files[path]) state.files[path] = { path: path, version: 0, mode: null, holders: [], queue: [], history: [] };
      return state.files[path];
    }
    function holder(id, f) {
      for (var i = 0; i < f.holders.length; i++) if (f.holders[i].agent === id) return f.holders[i];
      return null;
    }
    function grant(f, entry) {
      if (entry.mode === "W") f.mode = "W"; else if (f.mode === null) f.mode = "R";
      f.holders.push({ agent: entry.agent, mode: entry.mode, until: state.t + state.ttl, note: entry.note });
      setStatus(entry.agent, "working", entry.mode === "W" ? entry.note : "读取 " + f.path, f.path);
    }
    function pump(f) {
      if (f.mode === "W") return;
      while (f.queue.length) {
        var head = f.queue[0];
        if (head.mode === "W") {
          if (f.holders.length > 0) return;
          f.queue.shift(); grant(f, head); return;
        }
        var hasWriter = false;
        for (var i = 0; i < f.queue.length; i++) if (f.queue[i].mode === "W") hasWriter = true;
        if (hasWriter) { f.queue.shift(); grant(f, head); return; }
        while (f.queue.length && f.queue[0].mode === "R") grant(f, f.queue.shift());
        return;
      }
    }
    function acquire(id, path, mode, stepLabel) {
      var f = file(path);
      if ((f.queue.length === 0 && f.mode === null) || (mode === "R" && f.mode === "R" && f.queue.length === 0)) {
        grant(f, { agent: id, mode: mode, note: stepLabel });
        return true;
      }
      f.queue.push({ agent: id, mode: mode, note: stepLabel, enqueuedAt: state.t });
      setStatus(id, "waiting", "排队 #" + f.queue.length + " · " + path, path);
      addStep(currentBlock(id), "阻塞：排队等 " + path + "（第 " + f.queue.length + " 位）", 0, "wait");
      return false;
    }
    function release(id, path) {
      var f = file(path), h = holder(id, f);
      if (!h) return;
      f.holders = f.holders.filter(function (x) { return x.agent !== id; });
      if (f.holders.length === 0) f.mode = null;
      pump(f);
    }
    function renew(id, path) {
      var f = file(path), h = holder(id, f);
      if (h) h.until = state.t + state.ttl;
    }
    function write(id, path, noteText) {
      var f = file(path), h = holder(id, f);
      if (!h || h.mode !== "W") { alert("danger", "越权写入被拒绝：" + path, id); return false; }
      f.version += 1;
      f.history.push({ v: f.version, by: id, t: state.t, note: noteText });
      release(id, path);
      return true;
    }

    /* ---------- 剧本（130 秒） ---------- */
    var script = [
      { at: 0, run: function () {
        emit("mission.created", "lead", "lead", "立项 · " + state.mission.ticker, { parents: [] });
        assignTask("macro", "先给我一版政策周期判断，重点是四季度会不会转向。", true);
        var b = startBlock("macro", "撰写宏观底稿", "research/macro.md");
        addStep(b, "读取 mission.md 与上一轮结论", 1, "read");
        acquire("macro", "research/macro.md", "W", "撰写宏观底稿");
        setStatus("macro", "working", "拆解货币政策与流动性周期", "research/macro.md");
        addStep(b, "拆解利率 / 政策 / 汇率三因子", 8, "think");
      }},
      { at: 2, run: function () {
        assignTask("industry", "白酒产业链梳理一下，我要看渠道库存和次高端动销。", true);
        var b = startBlock("industry", "梳理白酒产业链", "research/industry.md");
        acquire("industry", "research/industry.md", "W", "撰写行业底稿");
        setStatus("industry", "working", "梳理产能与渠道结构", "research/industry.md");
        addStep(b, "梳理产业链与渠道结构", 10, "tool");
        acquire("industry", "research/macro.md", "R", "对齐宏观景气");
        emit("lock.queued", "industry", "industry", "排队 等 macro.md · 12s", { path: "research/macro.md" });
      }},
      { at: 12, run: function () {
        renew("macro", "research/macro.md");
        addStep(currentBlock("macro"), "核对三家券商政策口径", 6, "tool");
      }},
      { at: 18, run: function () {
        var m = emit("file.written", "macro", "macro", "宏观底稿 v1", { path: "research/macro.md", v: 1 });
        write("macro", "research/macro.md", "v1");
        endBlock(currentBlock("macro"), "政策周期判断：宽松延续至明年二季度。关键分歧在汇率。",
          { path: "research/macro.md", v: 1, sections: ["政策三因子", "流动性", "汇率与出口"] });
        setStatus("macro", "done", "已交付宏观底稿");
        noteSay("macro", "政策周期判断：宽松延续至明年二季度。关键分歧在汇率。");
        finish("S1"); enter("S2");
        emit("handoff", "macro", "macro", "交接 → 行业研究", { parents: [m.seq] });
      }},
      { at: 19.5, run: function () {
        release("industry", "research/macro.md");
        assignTask("stock", "把个股底稿做出来，估值给区间，别给单点。", true);
        var b = startBlock("stock", "撰写个股底稿", "research/stock.md");
        acquire("stock", "research/stock.md", "W", "撰写个股底稿");
        setStatus("stock", "working", "抓取近 8 季财务与产能数据", "research/stock.md");
        addStep(b, "抓取近 8 季收入 / 毛利 / 现金流", 12, "tool");
        addStep(currentBlock("industry"), "对照宏观做景气映射", 12, "think");
      }},
      { at: 22, run: function () {
        acquire("stock", "research/industry.md", "R", "需要行业格局作为前提");
        emit("lock.queued", "stock", "stock", "排队 等 industry.md · 18s", { path: "research/industry.md" });
      }},
      { at: 24, run: function () {
        assignTask("macro", "基于底稿出一份对外宏观月报，800 字以内，给渠道客户看", true);
        openReport("macro", "macro", "宏观月报 · 流动性拐点", true, "reports/macro-2026-11.md");
        acquire("macro", "reports/macro-2026-11.md", "W", "起草宏观月报");
        setStatus("macro", "working", "起草对外宏观月报", "reports/macro-2026-11.md");
        addStep(currentBlock("macro"), "从底稿提炼三条结论", 5, "think");
        addStep(currentBlock("macro"), "压到 800 字，重写标题与摘要", 6, "write");
      }},
      { at: 34, run: function () {
        emit("file.written", "macro", "macro", "宏观月报 v1", { path: "reports/macro-2026-11.md", v: 1 });
        write("macro", "reports/macro-2026-11.md", "v1");
        gateSet("G-DATA", "pass", "月报数据均带来源");
        var r = state.reports[state.reports.length - 1];
        if (r) { r.v = 1; r.status = "review"; }
        endBlock(currentBlock("macro"), "对外版收掉了两处口径假设，补了免责段落。",
          { path: "reports/macro-2026-11.md", v: 1, sections: ["摘要", "流动性", "汇率", "免责"] });
        setStatus("macro", "waiting", "等待法务审阅");
      }},
      { at: 36, run: function () {
        acquire("legal", "reports/macro-2026-11.md", "R", "审阅对外月报");
      }},
      { at: 38, run: function () {
        release("legal", "reports/macro-2026-11.md");
        gateSet("G-LEGAL", "pass", "对外月报无绝对化表述");
        emit("gate.passed", "broker", "macro", "G-LEGAL 通过 · 月报", {});
      }},
      { at: 40, run: function () {
        var r = state.reports[state.reports.length - 1];
        if (r && r.status === "review") publishReport(r);
        setStatus("macro", "done", "已交付宏观月报");
      }},
      { at: 30, run: function () {
        assignTask("legal", "审查一批底稿的表述风险，重点是内幕信息和绝对化用语。", true);
        var bl = startBlock("legal", "梳理合规边界", "review/legal.md");
        acquire("legal", "review/legal.md", "W", "法律意见底稿");
        setStatus("legal", "working", "梳理合规边界与免责条款", "review/legal.md");
        addStep(bl, "梳理内幕信息与未公开重大信息边界", 9, "think");
        assignTask("audit", "建立证据台账，逐条标来源，缺来源的直接打回。", true);
        var ba = startBlock("audit", "建立证据台账", "review/audit.md");
        acquire("audit", "review/audit.md", "W", "审计底稿");
        setStatus("audit", "working", "建立证据台账", "review/audit.md");
        addStep(ba, "建立 sources 台账与编号规则", 8, "tool");
        loadSkill("audit", "citation-check");
      }},
      { at: 33, run: function () {
        acquire("audit", "research/macro.md", "R", "核验宏观引用");
        acquire("audit", "research/industry.md", "R", "核验行业数据");
        emit("lock.queued", "audit", "audit", "排队 等 industry.md", { path: "research/industry.md" });
      }},
      { at: 40, run: function () {
        var e = emit("file.written", "industry", "industry", "行业底稿 v1", { path: "research/industry.md", v: 1 });
        write("industry", "research/industry.md", "v1");
        endBlock(currentBlock("industry"), "景气度：高端稳、次高端承压。渠道库存去化到 1.5 个月。",
          { path: "research/industry.md", v: 1, sections: ["供需格局", "竞争结构", "渠道库存"] });
        setStatus("industry", "done", "已交付行业底稿");
        noteSay("industry", "景气度：高端稳、次高端承压。渠道库存去化到 1.5 个月。");
        finish("S2"); enter("S3");
        emit("handoff", "industry", "industry", "交接 → 个股研究", { parents: [e.seq] });
      }},
      { at: 41, run: function () {
        release("stock", "research/industry.md");
        release("audit", "research/industry.md");
        release("audit", "research/macro.md");
        setStatus("stock", "working", "拆护城河与定价权", "research/stock.md");
        setStatus("audit", "working", "逐条核对论断来源", "review/audit.md");
        addStep(currentBlock("stock"), "拆护城河与定价权", 18, "think");
      }},
      { at: 44, run: function () {
        acquire("legal", "research/stock.md", "R", "审查表述与内幕信息风险");
        emit("lock.queued", "legal", "legal", "排队 等 stock.md · 25s", { path: "research/stock.md" });
      }},
      { at: 52, run: function () {
        preflight("stock", "补齐可比公司季度产能数据，估值要用");
      }},
      { at: 56, run: function () { alert("warn", "research/stock.md 租约剩余 4s，个股研究员未续约", "stock"); }},
      { at: 58, run: function () { renew("stock", "research/stock.md"); addStep(currentBlock("stock"), "租约续约（长任务）", 1, "sys"); }},
      { at: 62, run: function () { alert("warn", "法律顾问已等待 research/stock.md 17s（队位 1）", "legal"); }},
      { at: 70, run: function () {
        var e = emit("file.written", "stock", "stock", "个股底稿 v1", { path: "research/stock.md", v: 1 });
        write("stock", "research/stock.md", "v1");
        loadSkill("stock", "valuation-dcf");
        addStep(currentBlock("stock"), "试算三版 DCF 假设", 20, "tool");
        addStep(currentBlock("stock"), "写入 v1", 2, "write");
        endBlock(currentBlock("stock"), "护城河在品牌与产能稀缺性；估值中枢 1650-1820。",
          { path: "research/stock.md", v: 1, sections: ["护城河", "财务质量", "估值"] });
        setStatus("stock", "waiting", "等待评审意见");
        noteSay("stock", "第 1 版好了：护城河在品牌与产能稀缺性，估值中枢 1650-1820。等审计意见。");
        finish("S3"); enter("S4");
        gateSet("G-DATA", "pass", "关键财务数字均带来源标记");
        var g = emit("gate.passed", "broker", "stock", "G-DATA 通过", { parents: [e.seq] });
        emit("handoff", "stock", "stock", "交接 → 评审", { parents: [g.seq] });
      }},
      { at: 72, run: function () {
        release("legal", "research/stock.md");
        setStatus("legal", "working", "出具合规意见", "review/legal.md");
        acquire("audit", "research/stock.md", "R", "逐条核验论断来源");
        addStep(currentBlock("legal"), "审查表述与免责条款", 16, "think");
      }},
      { at: 80, run: function () {
        gateSet("G-AUDIT", "fail", "覆盖率 78% < 90%，2 条缺来源");
        var fail = emit("gate.failed", "audit", "audit", "审计 v1 · 覆盖率 78%", { path: "review/audit.md", v: 1 });
        write("audit", "review/audit.md", "v1");
        release("audit", "research/stock.md");
        endBlock(currentBlock("audit"), "2 条论断缺来源（产能、吨价），覆盖率 78%。",
          { path: "review/audit.md", v: 1, sections: ["覆盖率", "缺来源清单"] });
        var r = emit("retry.opened", "stock", "stock", "退回：补 2 处来源", { parents: [fail.seq] });
        setStatus("stock", "blocked", "被 G-AUDIT 退回，需补证", "research/stock.md");
        alert("danger", "G-AUDIT 未通过：覆盖率 78% < 90%，退回个股研究员", "audit");
      }},
      { at: 84, run: function () {
        var b = startBlock("stock", "修订 v2：补证", "research/stock.md");
        acquire("stock", "research/stock.md", "W", "修订：补 2 处来源");
        setStatus("stock", "working", "补产能与吨价两处来源", "research/stock.md");
        addStep(b, "补产能来源 [S14]", 6, "tool");
        addStep(b, "补吨价来源 [S15]，修正假设", 8, "tool");
      }},
      { at: 88, run: function () {
        var e = emit("file.written", "legal", "legal", "法律意见 v1 · 无 BLOCK", { path: "review/legal.md", v: 1 });
        write("legal", "review/legal.md", "v1");
        endBlock(currentBlock("legal"), "无内幕信息与绝对化表述，免责声明已加。",
          { path: "review/legal.md", v: 1, sections: ["合规结论", "修改建议"] });
        setStatus("legal", "done", "已交付法律意见");
        noteSay("legal", "无内幕信息与绝对化表述，免责声明已加。");
        gateSet("G-LEGAL", "pass", "无内幕信息与绝对化表述");
        emit("gate.passed", "broker", "legal", "G-LEGAL 通过", { parents: [e.seq] });
      }},
      { at: 104, run: function () {
        emit("context.compacted", "audit", "audit", "上下文压缩 68K→12K", {});
        alert("info", "审计上下文已压缩，长文细节可能丢失，已要求重读关键段", "audit");
      }},
      { at: 106, run: function () {
        var e = emit("file.written", "stock", "stock", "个股底稿 v2", { path: "research/stock.md", v: 2 });
        write("stock", "research/stock.md", "v2");
        addStep(currentBlock("stock"), "写入 v2", 2, "write");
        endBlock(currentBlock("stock"), "补齐来源，修正吨价假设；估值区间不变。",
          { path: "research/stock.md", v: 2, sections: ["护城河", "财务质量", "估值", "待验证"] });
        setStatus("stock", "waiting", "等待复审");
        noteSay("stock", "补齐了产能和吨价两处来源，假设修正，估值区间不变。请复审。");
        acquire("audit", "research/stock.md", "R", "复审");
        acquire("audit", "review/audit.md", "W", "撰写审计报告 v2");
        var ab = startBlock("audit", "复审 v2", "review/audit.md");
        addStep(ab, "重读 stock.md v2 的 4 处新增引用", 5, "read");
        acquire("trader", "trade/plan.md", "W", "制定交易计划");
        assignTask("trader", "按审计通过的底稿出交易计划，给仓位、入场、止损。", true);
        var tb = startBlock("trader", "测算交易计划", "trade/plan.md");
        setStatus("trader", "working", "测算仓位 / 入场 / 止损", "trade/plan.md");
        addStep(tb, "读取 stock.md 与审计结论", 2, "read");
      }},
      { at: 112, run: function () {
        var e = emit("file.written", "audit", "audit", "审计 v2 · 覆盖率 94%", { path: "review/audit.md", v: 2 });
        write("audit", "review/audit.md", "v2");
        addStep(currentBlock("audit"), "比对新增引用与台账编号", 6, "tool");
        endBlock(currentBlock("audit"), "覆盖率 94%，0 条缺来源；建议保留 [S12] 的敏感性说明。",
          { path: "review/audit.md", v: 2, sections: ["覆盖率", "复审结论"] });
        setStatus("audit", "done", "已交付审计报告");
        noteSay("audit", "覆盖率 94%，0 条缺来源；建议保留 [S12] 的敏感性说明。");
        setStatus("stock", "done", "已交付个股底稿");
        finish("S4"); enter("S5");
        gateSet("G-AUDIT", "pass", "覆盖率 94%，全部论断可溯源");
        var g = emit("gate.passed", "broker", "audit", "G-AUDIT 通过", { parents: [e.seq] });
        emit("handoff", "audit", "audit", "交接 → 交易员", { parents: [g.seq] });
        acquire("trader", "research/stock.md", "R", "读取最终底稿");
        addStep(currentBlock("trader"), "读最终底稿（共享读锁，与审计并发）", 3, "read");
      }},
      { at: 114, run: function () { release("audit", "research/stock.md"); }},
      { at: 120, run: function () {
        var e = emit("file.written", "trader", "trader", "交易计划 v1", { path: "trade/plan.md", v: 1 });
        write("trader", "trade/plan.md", "v1");
        release("trader", "research/stock.md");
        addStep(currentBlock("trader"), "测算仓位 5%、两档止损", 10, "think");
        addStep(currentBlock("trader"), "写入 plan.md", 2, "write");
        endBlock(currentBlock("trader"), "目标仓位 5%，止损 1580 / 1520，分两档建仓。",
          { path: "trade/plan.md", v: 1, sections: ["仓位", "入场", "止损", "情景"] });
        setStatus("trader", "done", "已交付交易计划");
        noteSay("trader", "目标仓位 5%，止损 1580 / 1520，分两档建仓。");
        finish("S5"); enter("S6");
        emit("handoff", "trader", "trader", "交接 → Lead 汇编", { parents: [e.seq] });
      }},
      { at: 122, run: function () {
        var legalSeq = 0, tradeSeq = 0;
        for (var i = 0; i < state.events.length; i++) {
          var ev = state.events[i];
          if (ev.type === "file.written" && ev.path === "review/legal.md") legalSeq = ev.seq;
          if (ev.type === "file.written" && ev.path === "trade/plan.md") tradeSeq = ev.seq;
        }
        state.reports.push({ id: ++reportSeq, type: "final", title: "最终研究报告", external: true,
          file: "final_report.md", v: 1, status: "draft", author: "lead", t0: state.t, t1: null });
        var m = emit("report.assembled", "lead", "lead", "汇编 final_report", { parents: [legalSeq, tradeSeq] });
        state.blocks.push({ id: ++blockSeq, agent: "lead", title: "汇编最终报告", kind: "work",
          t0: state.t, t1: state.t + 1, steps: [
            { label: "合并 3 份研究底稿", dur: 2, kind: "tool" },
            { label: "并入法律意见与审计结论", dur: 1, kind: "tool" },
            { label: "生成免责声明与证据附录", dur: 1, kind: "write" }],
          text: "final_report.md v1：6 章 + 证据附录，待你签发。", status: "done",
          artifact: { path: "final_report.md", v: 1, sections: ["结论摘要", "宏观", "行业", "个股", "风险", "附录"] } });
        emit("sign.pending", "lead", "lead", "等待你签发", { parents: [m.seq] });
        state.mission.signoff = "awaiting";
        state.gates.forEach(function (g) { if (g.id === "G-SIGN") { g.status = "waiting"; g.note = "等待你签发"; } });
        // 签发包本身已说明，不再重复发告警
      }}
    ];

    function finish(stageId) {
      if (state.mission.doneStages.indexOf(stageId) < 0) state.mission.doneStages.push(stageId);
    }
    function enter(stageId) { state.mission.stage = stageId; }

    var cursor = 0;
    function step(dt) {
      state.t += dt;
      while (cursor < script.length && script[cursor].at <= state.t) { script[cursor].run(); cursor++; }
      for (var pi = pendingReplies.length - 1; pi >= 0; pi--) {
        if (pendingReplies[pi].at <= state.t) { deliverReply(pendingReplies[pi]); pendingReplies.splice(pi, 1); }
      }
      Object.keys(state.files).forEach(function (k) {
        var f = state.files[k];
        var expired = f.holders.filter(function (h) { return state.t >= h.until; });
        if (!expired.length) return;
        expired.forEach(function (h) {
          f.holders = f.holders.filter(function (x) { return x !== h; });
          alert("danger", "租约到期自动释放：" + k + "（持有者 " + state.agents[h.agent].name + "）", h.agent);
        });
        if (f.holders.length === 0) f.mode = null;
        pump(f);
      });
      return state;
    }
    function clock() {
      var s = Math.floor(state.wallStart + state.t);
      var hh = Math.floor(s / 3600) % 24, mm = Math.floor(s / 60) % 60, ss = s % 60;
      function p(n) { return (n < 10 ? "0" : "") + n; }
      return p(hh) + ":" + p(mm) + ":" + p(ss);
    }
    function sign() {
      if (state.mission.signoff !== "awaiting") return false;
      state.mission.signoff = "signed";
      state.reports.forEach(function (r) { if (r.type === "final") r.status = "published"; });
      state.gates.forEach(function (g) { if (g.id === "G-SIGN") { g.status = "pass"; g.note = "已由你签发"; } });
      if (state.mission.doneStages.indexOf("S6") < 0) state.mission.doneStages.push("S6");
      var last = state.events.filter(function (e) { return e.type === "sign.pending"; }).pop();
      emit("report.published", "lead", "lead", "已签发 · 报告发布", { parents: last ? [last.seq] : [] });
      return true;
    }
    return { state: state, step: step, clock: clock, sign: sign, assignTask: assignTask,
      agentModel: agentModel, setModel: setModel, addModel: addModel, removeModel: removeModel, findModel: findModel,
      skillsOf: skillsOf, toggleSkill: toggleSkill, loadSkill: loadSkill,
      skillById: skillById, installSkill: installSkill,
      requestCapability: requestCapability, decideCapability: decideCapability, preflight: preflight, planNeeds: planNeeds,
      AGENTS: AGENTS, STAGES: STAGES, totalSeconds: 124 };
  }

  return { createSim: createSim, AGENTS: AGENTS, STAGES: STAGES };
});
