#!/usr/bin/env node
"use strict";
/**
 * agent-runtime — 员工 Agent 运行时适配层。
 *
 *   dsh    — 当前默认：runtime/agents/employee.js（DSH headless 会话）
 *   openai — OpenAI-compatible /chat/completions + function calling，工具走 Tool Gateway
 *   fake   — 离线测试
 *
 * Loop/契约/账本/Tool Gateway 与 runtime 解耦；以后加 MCP 或别的 harness 只加 adapter。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const lib = require("./agent-loop-lib");
const toolGateway = require("./tool-gateway");

function credName(ref, provider) {
  if (ref) {
    const m = String(ref).match(/^(?:env|keychain):(.+)$/);
    const name = (m ? m[1] : String(ref)).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  }
  return String(provider || "provider").toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
}
function readKey(name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];
  const f = path.join(os.homedir(), ".dsh/.credentials.yaml");
  if (!fs.existsSync(f)) return "";
  const src = fs.readFileSync(f, "utf8");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp("(?:^|\\n)\\s*" + esc + ":\\s*(\\S+)"));
  return m ? m[1] : "";
}
async function resolveModel(caseId, agent) {
  // 显式 env override：方便本地网关 / CI mock / 不开面板时跑 openai runtime。
  if (process.env.AGENT_OPENAI_BASE_URL) {
    let headers = {};
    try { headers = process.env.AGENT_OPENAI_HEADERS ? JSON.parse(process.env.AGENT_OPENAI_HEADERS) : {}; } catch (e) {}
    return { provider: process.env.AGENT_OPENAI_PROVIDER || "env-openai",
      model: process.env.AGENT_OPENAI_MODEL || "mock-model",
      baseURL: process.env.AGENT_OPENAI_BASE_URL,
      api: "openai-completions",
      apiKey: process.env.AGENT_OPENAI_KEY || process.env.OPENCODE_GO_API_KEY || "",
      apiKeyEnv: "AGENT_OPENAI_KEY", headers };
  }
  const r = await lib.api("GET", "/api/models?case=" + encodeURIComponent(caseId));
  const ms = r.body || {};
  const cfg = (ms.byAgent && ms.byAgent[agent]) || ms.default || {};
  const cat = (ms.catalog || []).find(x => x.provider === cfg.provider && x.model === cfg.model) || {};
  if (!cfg.provider || !cfg.model) throw new Error("没有配置模型");
  if (!cat.base_url) throw new Error("openai runtime 需要模型目录里配置 Base URL（OpenAI 兼容网关）");
  const apiKeyEnv = credName(cat.key_ref || "", cfg.provider);
  return { provider: cfg.provider, model: cfg.model, baseURL: cat.base_url,
    api: cat.api || "openai-completions", apiKey: readKey(apiKeyEnv), apiKeyEnv,
    headers: (cat.headers && typeof cat.headers === "object") ? cat.headers : {} };
}
function normContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => (x && (x.text || x.content)) || "").join("");
  return "";
}
async function runOpenAI(agent, caseId, task, stage) {
  let model;
  try { model = await resolveModel(caseId, agent); }
  catch (e) { return { ok: false, error: String((e && e.message) || e), employee: { ok: false } }; }
  const base = String(model.baseURL).replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
  const catalog = toolGateway.catalog();
  const nameMap = {};
  const tools = catalog.map(t => {
    const fn = String(t.name).replace(/\./g, "__");
    nameMap[fn] = t.name;
    return { type: "function", function: { name: fn, description: t.description, parameters: t.inputSchema } };
  });
  const messages = [
    { role: "system", content: "你是 AlphaDesk 的研究员工 " + agent + "。可以用工具取证；数字必须来自工具结果或文件；" +
      "缺数据时不要编造。最终回答必须包含一个 JSON 结果契约（status/artifacts/evidenceIds/openQuestions/needs/subagents/confidence）。" },
    { role: "user", content: task }
  ];
  const toolCalls = [];
  let total = 0, input = 0, output = 0, steps = 0, answer = "";
  try {
    for (let step = 0; step < 8; step++) {
      steps += 1;
      const body = { model: model.model, messages, tools, tool_choice: "auto", temperature: 0.2 };
      const res = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" },
        model.apiKey ? { authorization: "Bearer " + model.apiKey } : {}, model.headers || {}), body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000) });
      let j = null; try { j = await res.json(); } catch (e) {}
      if (!res.ok || !j || j.error) {
        return { ok: false, error: "OpenAI runtime HTTP " + res.status + "：" + JSON.stringify(j || {}).slice(0, 300), employee: { ok: false } };
      }
      const u = j.usage || {};
      total += Number(u.total_tokens || 0); input += Number(u.prompt_tokens || 0); output += Number(u.completion_tokens || 0);
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) { answer = normContent(msg.content); break; }
      messages.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
      for (const tc of calls) {
        const fn = (tc.function && tc.function.name) || "";
        const realName = nameMap[fn] || fn;
        let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) {}
        const r = await lib.api("POST", "/api/tools/" + encodeURIComponent(realName),
          { case: caseId, args, by: agent, traceId: stage || "", approved: false });
        toolCalls.push({ name: realName, callId: tc.id || "", input: args,
          status: r.status >= 200 && r.status < 300 ? "done" : "failed",
          result: String(JSON.stringify(r.body || {})).slice(0, 1200) });
        messages.push({ role: "tool", tool_call_id: tc.id || "", content: JSON.stringify(r.body || {}).slice(0, 6000) });
      }
    }
  } catch (e) {
    return { ok: false, error: "OpenAI runtime 失败：" + String((e && e.message) || e).slice(0, 300), employee: { ok: false } };
  }
  // 工具步数用完后，强制一次“不再调工具”的收口请求，避免模型因一直调工具而拿不到最终契约。
  if (!String(answer || "").trim()) {
    try {
      messages.push({ role: "system", content: "工具调用步数已用完。请只基于已有工具结果直接给出最终回答，并在最后放一个 JSON 结果契约；不要再调用工具。" });
      const body = { model: model.model, messages, temperature: 0.2 };
      const res = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" },
        model.apiKey ? { authorization: "Bearer " + model.apiKey } : {}, model.headers || {}), body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000) });
      let j = null; try { j = await res.json(); } catch (e) {}
      if (res.ok && j && !j.error) {
        const u = j.usage || {};
        total += Number(u.total_tokens || 0); input += Number(u.prompt_tokens || 0); output += Number(u.completion_tokens || 0);
        const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
        answer = normContent(msg.content);
        steps += 1;
      }
    } catch (e) {}
  }
  if (!String(answer || "").trim()) {
    return { ok: false, error: "OpenAI runtime 在 8 步工具调用后仍未给出最终回答",
      employee: { ok: false, usage: { input, output, total, steps }, toolCalls } };
  }
  return { ok: true, employee: { ok: true, agent, provider: model.provider, model: model.model,
    answer, usage: { input, output, total, steps }, toolCalls } };
}

const RUNTIMES = {
  dsh: {
    name: "dsh",
    description: "DeepSeek Harness headless employee session",
    async run(agent, caseId, task, stage, opts) { return lib.runEmployee(agent, caseId, task, stage, opts); }
  },
  openai: {
    name: "openai",
    description: "OpenAI-compatible chat/completions + function calling + Tool Gateway",
    async run(agent, caseId, task, stage, opts) { return runOpenAI(agent, caseId, task, stage, opts); }
  },
  fake: {
    name: "fake",
    description: "offline fake runtime",
    async run(agent) {
      return { ok: true, employee: { ok: true, agent, usage: { input: 0, output: 0, total: 0, steps: 0 },
        toolCalls: [], answer: '{"status":"done","summary":"fake runtime","openQuestions":[],"needs":[],"confidence":1}' },
        stdout: "", stderr: "" };
    }
  }
};
function list() { return Object.keys(RUNTIMES).map(k => ({ name: k, description: RUNTIMES[k].description })); }
async function run(runtime, agent, caseId, task, stage, opts) {
  const r = RUNTIMES[runtime] || RUNTIMES.dsh;
  return r.run(agent, caseId, task, stage, opts);
}
module.exports = { list, run, RUNTIMES, resolveModel };
