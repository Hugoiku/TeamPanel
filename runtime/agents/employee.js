#!/usr/bin/env node
/**
 * employee.js — 每名员工一个独立 DSH 会话进程（独立模型，走 opencode-go）
 *
 * 用法：
 *   node runtime/agents/employee.js --agent macro --case case-2026-002 --task "写宏观底稿"
 *   node runtime/agents/employee.js --agent macro --case c --task "..." --dry-run   # 只打印提示词与模型配置
 *
 * 做三件事：
 *   1. 从 Broker 读这位员工配置的模型（/api/models 的 byAgent，缺省用 default）；
 *   2. 生成只属于他的 profile patch（provider=opencode-go + 该模型），用 dsh headless 跑这一轮；
 *   3. 把实际运行的模型回报给 Broker（desk model），并写 agent.run.* 事件。
 *
 * 环境：OPENCODE_GO_API_KEY（没设时从 ~/.dsh/.credentials.yaml 的 refs 读）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const BROKER = process.env.DESK_BROKER || "http://127.0.0.1:7801";
// 角色名单来自 config/desk.json（开源用户可加/删角色），缺配置时回落到六角色
const CFG = (function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config/desk.json"), "utf8")); }
  catch (_) { return {}; }
})();
const AGENT_DEFS = (CFG.agents || []).filter(a => a.role);
// dsh 是员工运行本体：优先 CFG.dsh.bin / DSH_BIN，其次 PATH，最后回落 macOS App 自带路径（换机器一般要设 DSH_BIN）
function findDsh() {
  const ok = p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } };
  const cands = [process.env.DSH_BIN, CFG.dsh && CFG.dsh.bin,
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"];
  const names = process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"];
  (process.env.PATH || "").split(path.delimiter).forEach(d => {
    if (d) names.forEach(nm => cands.push(path.join(d, nm)));
  });
  for (const c of cands) { if (c && ok(c)) return c; }
  return "";
}
const DSH = findDsh();
const AGENTS = AGENT_DEFS.length ? AGENT_DEFS.map(a => a.id)
  : ["macro", "industry", "stock", "audit", "legal", "trader"];
const ROLE_FILE = {};
AGENT_DEFS.forEach(a => { ROLE_FILE[a.id] = a.role; });
["macro", "industry", "stock", "audit", "legal", "trader"].forEach(id => {
  if (!ROLE_FILE[id]) ROLE_FILE[id] = "agents/" + id + "/ROLE.md";
});

function arg(k, d) {
  const i = process.argv.indexOf("--" + k);
  return i >= 0 ? process.argv[i + 1] : d;
}
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BROKER + p);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      agent: false, method, headers: payload ? { "content-type": "application/json",
        "content-length": Buffer.byteLength(payload) } : {} }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 目录里的 key_ref 是我们面板的写法（env:XXX / keychain:XXX），dsh 的 apiKeyEnv 只认
// POSIX 标识符（值是进程环境变量，或 ~/.dsh 凭据库里的同名 key）
function credNameFrom(ref, provider) {
  if (ref) {
    const m = String(ref).match(/^(?:env|keychain):(.+)$/);
    const name = (m ? m[1] : String(ref)).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
    return "";
  }
  return String(provider || "provider").toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}
function readKey(name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];
  const f = path.join(process.env.HOME || "", ".dsh/.credentials.yaml");
  if (!fs.existsSync(f)) return "";
  const src = fs.readFileSync(f, "utf8");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp("(?:^|\\n)\\s*" + esc + ":\\s*(\\S+)"));
  return m ? m[1] : "";
}

// 自建网关用 pi-ai 的手写路由字段（api / baseURL / models），字段名见 dsh-llm-pi-ai README
function patchFor(provider, model, opts) {
  const o = opts || {};
  const lines = [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    provider: " + provider,
    "    model: " + model
  ];
  // 自建网关不声明推理档位：未在 models.reasoningEfforts 里声明就发 high，dsh 会直接回
  // UNSUPPORTED_REASONING_EFFORT（已在实测里踩到）。内置路由没有这个限制，保持 high。
  if (!o.baseURL) lines.push("    reasoningEffort: " + (o.effort || "high"));
  lines.push(
    "- id: llm-pi-ai",
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    "  config:",
    "    providers:",
    "      " + provider + ":",
    "        apiKeyEnv: " + o.apiKeyEnv
  );
  if (o.baseURL) {
    lines.push("        api: " + (o.api || "openai-completions"));
    lines.push("        baseURL: " + JSON.stringify(o.baseURL));
    lines.push("        displayName: " + JSON.stringify(o.displayName || provider));
    lines.push("        models:");
    lines.push("          - id: " + JSON.stringify(model));
    lines.push("            name: " + JSON.stringify(o.label || model));
    lines.push("            contextWindow: " + (o.ctx || 128000));
  }
  return lines.join("\n") + "\n";
}

function readIf(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function brief(agent, caseId, taskText, answers, skills, kb, uploads) {
  const common = fs.readFileSync(path.join(ROOT, "agents/_COMMON.md"), "utf8");
  const role = fs.readFileSync(path.join(ROOT, ROLE_FILE[agent]), "utf8");
  return [
    "你是 AlphaDesk 投研流水线的一名员工，工牌：" + agent + "。",
    "工作目录就是项目根目录（当前目录）。vault/ 只能通过 ./scripts/desk 读写，不要直接改文件。",
    "本轮 case：" + caseId + "。环境变量 DESK_CASE 和 DESK_ACTOR 已经为你设好，desk 会自动带上。",
    "",
    "## 你的角色说明",
    role,
    "",
    "## 共享协议（必须遵守）",
    common,
    "",
    "## 行为准则（AGENTS.md，必须遵守）",
    readIf("agents/" + agent + "/AGENTS.md"),
    "",
    (kb && kb.length ? [
      "## 你的知识库（你自己的 Wiki，以前积累的）",
      kb.map(s => "- " + s.title + "（#" + s.slug + (s.tags && s.tags.length ? " · " + s.tags.join("/") : "") +
        "）：" + (s.snippet || "")).join("\n"),
      "先查库再用：需要全文用 ./scripts/desk kb --get --slug <slug>；库为空就直接开工，不要为了填库而写没验证的内容。",
      "",
    ].join("\n") : ""),
    (uploads && uploads.length ? [
      "## 本轮可用附件（监督者通过面板上传的本地资料）",
      uploads.map(u => "- " + u.path + "（v" + u.version + (u.bytes ? "，" + u.bytes + "B" : "") + "）").join("\n"),
      "读取：文本/CSV/JSON/MD 用 ./scripts/desk cat --path <路径>；xlsx/xls/pdf 先用 node scripts/extract.js --case <case> --path <路径> 转成文本再读；图片只能看元数据，要数字请监督者补 CSV。",
      "这些资料优先于记忆和推测：能引用就写进 evidence/sources.jsonl 并在正文标 [S#]。",
      ""
    ].join("\n") : ""),
    "## 把学到的东西存进你自己的库（每轮都做）",
    "- 可复用的事实/口径/结论/来源，写到 ./scripts/desk kb --put --title \"标题\" --file 草稿.md --tags 标签1,标签2 --source \"来源\"；",
    "- 不要把你没验证的猜测写进库；库里的页面会带 tags/sources，下次自己和同事都能查。",
    "",
    (skills && skills.length ? [
      "## 你被装配的技能 / 插件（由监督者在面板里单独配给你的）",
      skills.map(s => {
        // doc 里若混进 SKILL.md 的 frontmatter（name:/description:），去掉，只留真正的用法正文
        const docText = String(s.doc || "").replace(/^---[\s\S]*?---/m, "")
          .split("\n").filter(l => !/^(name|description|version|tags)\s*:/.test(l.trim()))
          .join("\n").trim();
        return "- " + s.name + "（" + (s.kind === "plugin" ? "插件" : "技能") + "，" + (s.ver || "") +
          "）：" + (s.desc || "") + (docText ? "；用法要点：" + docText.slice(0, 900) : "");
      }).join("\n"),
      "用得上就按它的口径做；用不上也要在交付里说明为什么没用。",
      ""
    ].join("\n") : ""),
    (answers && answers.length ? [
      "## 你已经拿到的答复（监督者对你上几轮提问的回答）",
      answers.map(a => "- [" + (a.kind || "other") + "] " + a.title + " → " +
        (a.answer || a.partialAnswer || "") + (a.status === "partial" ? "（部分答复，仍缺数据）" : ""))
        .join("\n"),
      ""
    ].join("\n") : ""),
    "## 缺东西怎么办（重要）",
    "- 遇到缺数据、缺来源、缺技能、缺插件、缺权限、缺口径，**不要编造、不要拿「待补」糊过去**；",
    "- 用 ./scripts/desk need --kind data|skill|info|plugin|permission --title 「一句话说清缺什么」 --detail 「要什么、用来干什么」 上报；",
    "- 上报后正常交付你能做的部分，然后结束本轮；监督者答复后，下一轮提示词里会出现「你已经拿到的答复」。",
    "",
    (() => {
      try {
        let txt = "";
        const p = path.join(ROOT, "vault", caseId, "research", "case-brief.md");
        if (fs.existsSync(p)) txt += fs.readFileSync(p, "utf8").trim();
        const pm = path.join(ROOT, "vault", caseId, "research", "case-brief-model.md");
        if (fs.existsSync(pm)) txt += String.fromCharCode(10) + fs.readFileSync(pm, "utf8").trim();
        if (!txt) return "";
        return "## 共享 Case Brief（三个角色共用，必须对齐）" + String.fromCharCode(10) +
          txt.slice(0, 9000) + String.fromCharCode(10);
      } catch (e) { return ""; }
    })(),
    (() => {
      try {
        const dir = path.join(ROOT, "vault", caseId, "research");
        const files = fs.readdirSync(dir).filter(f => /^upstream-.*\.md$/.test(f) && f !== "upstream-" + agent + ".md");
        if (!files.length) return "";
        const nl = String.fromCharCode(10);
        return "## 上游角色已完成结论（下游必须对齐口径，不直接复制结论）" + nl +
          files.map(f => "### " + f.replace(/^upstream-/, "").replace(/\.md$/, "") + nl +
            fs.readFileSync(path.join(dir, f), "utf8").slice(0, 5000)).join(nl + nl) + nl;
      } catch (e) { return ""; }
    })(),
    "## 本轮任务",
    taskText,
    "",
    "## 交付要求",
    "- 用 ./scripts/desk acquire / write / release 落盘，写完用 ./scripts/desk gate 报门禁；",
    "- 最后用两三句话说明：写了哪些文件、版本号、哪些内容仍缺证据、下一步建议（一条具体动作）；",
    "- 不要动别人的文件，不要跳过锁。",
    ""
  ].join("\n");
}

async function main() {
  const agent = arg("agent");
  const caseId = arg("case", "default");
  const taskText = arg("task");
  if (!agent || AGENTS.indexOf(agent) < 0) {
    console.error("用法: employee.js --agent <" + AGENTS.join("|") + "> --case <case> --task \"...\" [--dry-run]");
    process.exit(2);
  }
  if (!taskText) { console.error("缺少 --task"); process.exit(2); }
  // 让 broker 记住本轮员工进程 pid：心跳超时重派时先杀掉旧进程，避免两份模型调用并行。
  const workId = process.env.DESK_WORK_ID || "";
  if (workId) {
    try { await api("POST", "/api/work/worker", { case: caseId, id: workId, pid: process.pid }); } catch (_) {}
  }

  const models = await api("GET", "/api/models?case=" + encodeURIComponent(caseId));
  if (models.status !== 200) { console.error("读模型配置失败:", JSON.stringify(models.body)); process.exit(3); }
  const ms = models.body || {};
  const cfg = (ms.byAgent && ms.byAgent[agent]) || ms.default || null;
  const provider = arg("provider", cfg ? cfg.provider : "");
  const model = arg("model", cfg ? cfg.model : "");
  // 开源默认不预置模型：没配置时明确告诉用户去哪配，而不是拿一个永远失败的默认值硬跑
  if (!provider || !model) {
    const msg = "还没有配置模型：在面板左下角「模型配置」里加一个 OpenAI 兼容网关" +
      "（写 Base URL + API Key 引用 + 协议），或在 config/desk.json 的 models.default 里指定";
    await api("POST", "/api/event", { case: caseId, type: "agent.run.failed", actor: agent,
      agent, error: msg, ms: 0 });
    console.error(msg);
    process.exit(6);
  }

  // 能跑的条件：目录里 verified（实测过）或者带 base_url（自建网关，按手写路由写进 patch）。
  // 两者都没有就别白等一轮——dsh 会拿 UNKNOWN_MODEL 报错。
  const cat = (ms.catalog || []).filter(m => m.provider === provider && m.model === model)[0];
  const verified = !!(cat && cat.verified === true);
  const wired = !!(cat && cat.base_url);
  if (!verified && !wired) {
    const msg = cat
      ? "模型未接入运行时：" + provider + "/" + model + "（自建 provider 需要填 Base URL 才会写进 profile patch；内置模型只有 opencode-go/deepseek-v4.1-flash 实测可用）"
      : "模型不在目录里：" + provider + "/" + model;
    await api("POST", "/api/event", { case: caseId, type: "agent.run.failed", actor: agent,
      agent, provider, model, error: msg, ms: 0 });
    console.error(msg);
    process.exit(6);
  }

  // 凭据名：目录里的 key_ref（env:FOO / keychain:FOO）→ POSIX 名；没填就按 provider 推一个
  const apiKeyEnv = (cat && cat.key_ref) ? credNameFrom(cat.key_ref, provider) : credNameFrom("", provider);
  if (!apiKeyEnv) {
    const msg = "key_ref 不合法：" + (cat && cat.key_ref) + "（dsh 的 apiKeyEnv 只认 POSIX 标识符，请写 env:MY_KEY）";
    await api("POST", "/api/event", { case: caseId, type: "agent.run.failed", actor: agent,
      agent, provider, model, error: msg, ms: 0 });
    console.error(msg);
    process.exit(6);
  }

  const profileDir = path.join(ROOT, "runtime/profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  const patchPath = path.join(profileDir, agent + ".yml");
  const effort = arg("effort", "");
  fs.writeFileSync(patchPath, patchFor(provider, model, {
    effort: effort || "high",
    apiKeyEnv,
    baseURL: (cat && cat.base_url) || "",
    api: (cat && cat.api) || "",
    displayName: (cat && cat.label) || provider,
    label: (cat && cat.label) || model,
    ctx: (cat && cat.ctx) || 128000
  }));

  let answers = [];
  try {
    const nr = await api("GET", "/api/needs?case=" + encodeURIComponent(caseId));
    answers = ((nr.body && nr.body.needs) || [])
      .filter(n => n.agent === agent && (n.status === "answered" || n.status === "waived" || n.status === "partial") && (n.answer || n.partialAnswer))
      .slice(-5);
  } catch (_) {}
  let skills = [];
  try {
    const sk = await api("GET", "/api/skills?case=" + encodeURIComponent(caseId));
    const st = sk.body || {};
    const mine = (st.byAgent && st.byAgent[agent]) || [];
    skills = (st.catalog || []).filter(s => mine.indexOf(s.id) >= 0 && s.installed);
  } catch (_) {}
  let kb = [];
  try {
    // 先用任务里的中文关键词查自己的库，命不中再退回到最近 3 页（避免无条件注入一堆页浪费 token）
    const kws = (taskText.match(/[\u4e00-\u9fa5]{2,6}/g) || []).slice(0, 2);
    let hits = [];
    for (const kw of kws) {
      const kr = await api("GET", "/api/kb/search?agent=" + encodeURIComponent(agent) + "&q=" + encodeURIComponent(kw));
      hits = hits.concat((kr.body && kr.body.hits) || []);
      if (hits.length >= 3) break;
    }
    if (!hits.length) {
      const kr = await api("GET", "/api/kb/search?agent=" + encodeURIComponent(agent) + "&q=");
      hits = ((kr.body && kr.body.hits) || []).slice(0, 3);
    }
    const seen = {};
    kb = hits.filter(h => (seen[h.slug] ? false : (seen[h.slug] = true))).slice(0, 3);
  } catch (_) {}
  let uploads = [];
  try {
    const sn = await api("GET", "/api/snapshot?case=" + encodeURIComponent(caseId));
    uploads = ((sn.body && sn.body.files) || [])
      .filter(f => String(f.path || "").indexOf("uploads/") === 0 && f.version > 0)
      .map(f => ({ path: f.path, version: f.version, bytes: f.bytes || 0 }));
  } catch (_) {}
  const prompt = flag("short-prompt")
    ? "【继续本轮计划】" + taskText + "\n只做这一步：用 ./scripts/desk 读写，数字标 [S#]；结束时用一两句话说明写到哪个文件、版本号、还缺什么。"
    : brief(agent, caseId, taskText, answers, skills, kb, uploads);
  if (flag("print-prompt")) {
    const dir = path.join(ROOT, "runtime/prompts");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, agent + ".md");
    fs.writeFileSync(out, prompt);
    const parts = prompt.split(/\n(?=## )/).map(s => {
      const m = s.match(/^## (.+)$/m);
      return { section: m ? m[1] : (s.split("\n")[0] || "").slice(0, 30), chars: s.length };
    });
    console.log(JSON.stringify({ agent, case: caseId, provider, model, bytes: Buffer.byteLength(prompt),
      file: path.relative(ROOT, out), sections: parts }, null, 2));
    return;
  }
  if (flag("dry-run")) {
    console.log(JSON.stringify({ agent, case: caseId, provider, model,
      verified, wired, apiKeyEnv, baseURL: (cat && cat.base_url) || null,
      api: (cat && cat.api) || (wired ? "openai-completions" : null),
      patch: patchPath, promptBytes: Buffer.byteLength(prompt),
      prompt: prompt.slice(0, 200) + "…" }, null, 2));
    return;
  }

  if (!DSH) {
    const msg = "找不到 dsh 可执行文件：装 DeepSeek Harness，或 DSH_BIN=/path/to/dsh（dry-run 不受影响）";
    await api("POST", "/api/event", { case: caseId, type: "agent.run.failed", actor: agent,
      agent, provider, model, error: msg, ms: 0 });
    console.error(msg);
    process.exit(5);
  }
  // per-case session 隔离：runtime/dsh-home/<case>/<agent>/
  // case 名可能含中文/空格/斜杠，做目录安全化，避免跨 case 共用同一会话文件。
  const caseDir = String(caseId || "default").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "default";
  const home = path.join(ROOT, "runtime/dsh-home", caseDir, agent);
  fs.mkdirSync(home, { recursive: true });
  const key = readKey(apiKeyEnv);
  // 自建网关可能不需要 Key（本机 Ollama/vLLM），所以有 base_url 时不因为缺凭据就拦下
  if (!key && !wired) {
    console.error("找不到 " + apiKeyEnv + "（环境变量，或 ~/.dsh/.credentials.yaml 里的同名 key）");
    process.exit(4);
  }

  const stage = arg("stage", "");
  const sessionArg = arg("session-id", "");
  if (stage) {
    await api("POST", "/api/event", { case: caseId, type: "agent.step.started", actor: agent,
      agent, stage, provider, model, sessionId: sessionArg || null });
  }
  await api("POST", "/api/event", { case: caseId, type: "agent.run.started", actor: agent,
    agent, provider, model, stage: stage || null });

  const started = Date.now();
  const childEnv = Object.assign({}, process.env, {
    DSH_HOME: home, DESK_CASE: caseId, DESK_ACTOR: agent
  });
  if (key) childEnv[apiKeyEnv] = key;
  const dshArgs = ["--patch", patchPath, "--profile", "headless", "--json"];
  if (sessionArg) dshArgs.push("--session-id", sessionArg);
  dshArgs.push(prompt);
  const res = spawnSync(DSH, dshArgs, {
    cwd: ROOT, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
    env: childEnv, shell: process.platform === "win32"
  });

  // 解析 --json 事件流：拿最终答复 + token 用量（step_end 里的 usage 累加）
  let answer = "", sessionId = "", usage = { input: 0, output: 0, cacheRead: 0, total: 0, steps: 0 };
  const toolCalls = [];
  const evLines = String(res.stdout || "").split("\n").filter(Boolean);
  for (const line of evLines) {
    let ev = null;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    if (ev.type === "session" && ev.sessionId) sessionId = ev.sessionId;
    if (ev.type === "final" && typeof ev.text === "string") answer = ev.text;
    if (ev.type === "tool_call" && toolCalls.length < 80) {
      toolCalls.push({ name: String(ev.tool || "tool"), callId: String(ev.callId || ""),
        input: ev.input || null, status: "called" });
    }
    if (ev.type === "tool_result") {
      const tc = toolCalls.find(x => x.callId === String(ev.callId || ""));
      if (tc) { tc.status = String(ev.status || "done"); tc.result = String(ev.result || "").slice(0, 1200); }
    }
    if (ev.type === "status" && ev.phase === "step_end" && ev.usage) {
      usage.steps += 1;
      usage.input += ev.usage.inputTokens || 0;
      usage.output += ev.usage.outputTokens || 0;
      usage.cacheRead += ev.usage.cacheReadTokens || 0;
      usage.total += ev.usage.totalTokens || 0;
    }
  }
  // 没有 JSON 事件时退回原始 stdout（兼容旧行为）
  if (!answer) answer = String(res.stdout || "").trim();
  res.stdout = answer;

  const ms2 = Date.now() - started;
  fs.mkdirSync(path.join(ROOT, "runtime/agent-runs"), { recursive: true });
  const logPath = path.join(ROOT, "runtime/agent-runs", agent + "-" + Date.now() + ".log");
  fs.writeFileSync(logPath, "## stdout\n" + (res.stdout || "") + "\n## stderr\n" + (res.stderr || ""));

  const ok = res.status === 0;
  const failReason = ok ? "" : (String(res.stderr || "").split("\n").filter(Boolean).pop() ||
    String(answer || "").slice(0, 300) || (res.signal ? "signal " + res.signal : "exit " + res.status));
  await api("POST", "/api/event", { case: caseId, type: ok ? "agent.run.finished" : "agent.run.failed",
    actor: agent, agent, provider, model, ms: ms2, error: failReason,
    log: path.relative(ROOT, logPath) });

  if (ok && String(answer || "").trim()) {
    await api("POST", "/api/event", { case: caseId, type: "agent.reply", actor: agent,
      agent, stage: stage || null, kind: "result", by: "model", ms: ms2,
      text: String(answer).slice(0, 4000), log: path.relative(ROOT, logPath) });
  }
  await api("POST", "/api/event", { case: caseId, type: "agent.usage", actor: agent,
    agent, provider, model, workId: process.env.DESK_WORK_ID || "", stage: stage || null,
    ms: ms2, steps: usage.steps, inputTokens: usage.input,
    outputTokens: usage.output, cacheReadTokens: usage.cacheRead, totalTokens: usage.total });
  if (flag("save-session") && sessionId) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "alphadesk-session.json"),
      JSON.stringify({ case: caseId, sessionId, updatedAt: new Date().toISOString() }, null, 2));
  }
  if (stage) {
    await api("POST", "/api/event", { case: caseId, type: ok ? "agent.step.finished" : "agent.step.failed",
      actor: agent, agent, stage, provider, model, sessionId: sessionId || sessionArg || null,
      ms: ms2, tokens: usage, error: failReason, log: path.relative(ROOT, logPath) });
  }
  // 员工自报实际运行模型（这一轮就是他自己的进程，模型由 patch 决定）
  await api("POST", "/api/agent/model", { case: caseId, agent, model, provider });

  // 自建网关跑通一轮 → 回报"实测可用"，面板上的「可试跑」就会变成「已实测」
  if (ok && wired && !verified) {
    try { await api("POST", "/api/model/verified", { case: caseId, provider, model, by: agent }); } catch (_) {}
  }

  console.log(JSON.stringify({ ok, agent, provider, model, stage: stage || null,
    sessionId: sessionId || sessionArg || null, usage, toolCalls: toolCalls.slice(0, 80), wired, apiKeyEnv, ms: ms2,
    log: path.relative(ROOT, logPath), answer: (res.stdout || "").trim().slice(0, 1200) }, null, 2));
  process.exit(ok ? 0 : 5);
}

main().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
