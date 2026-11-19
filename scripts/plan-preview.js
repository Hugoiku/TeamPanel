#!/usr/bin/env node
"use strict";
/**
 * plan-preview — 打印「同一 DSH 会话、按步骤切模型」的调用流程（不真的调模型）
 *
 *   node scripts/plan-preview.js --plan docs/examples/macro-plan.json
 *   node scripts/plan-preview.js --plan <plan.json> --session-id session-xxx
 *
 * 输出：步骤表、每步 profile patch、dsh 命令、会写进账本的事件、面板卡片预览。
 */
const fs = require("fs");
const path = require("path");
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const file = arg("plan", "docs/examples/macro-plan.json");
const plan = JSON.parse(fs.readFileSync(file, "utf8"));
const SID = arg("session-id", "session-7034d717-d915-46d0-94ef-24392f07a684");
const base = plan.routes || {};
function patchOf(step) {
  const r = base[step.tier] || base.fast || { provider: "opencode-go", model: "deepseek-v4.1-flash" };
  return [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    provider: " + r.provider,
    "    model: " + r.model,
    "    reasoningEffort: " + (step.tier === "fast" ? "low" : "high"),
    "- id: llm-pi-ai",
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    "  config:",
    "    providers:",
    "      " + r.provider + ":",
    "        apiKeyEnv: OPENCODE_GO_API_KEY",
    ""
  ].join("\n");
}
console.log("# " + plan.agent + " / " + plan.case + " · " + plan.goal);
console.log("# planner: " + plan.planner.provider + "/" + plan.planner.model + "（先默认模型；可换强推理）");
console.log("# routes: " + Object.keys(base).map(k => k + "=" + base[k].model).join("  "));
console.log("");
console.log("## 1. 步骤表（规划产物 research/plan/" + plan.agent + ".json）");
console.log("| 步 | 环节 | 档位 | 依赖 | 产出 |");
console.log("|---|---|---|---|---|");
plan.steps.forEach(s => console.log("| " + s.id + " | " + s.name + " | " + s.tier + " | " + ((s.depends || []).join(",") || "—") + " | " + (s.outputs || []).join(" / ") + " |"));
console.log("");
console.log("## 2. 执行链（同一个 session，逐步换 patch）");
let first = true;
plan.steps.forEach((s, i) => {
  const r = base[s.tier] || base.fast;
  const patchPath = "runtime/profiles/" + plan.agent + "." + s.id.toLowerCase() + ".yml";
  console.log("");
  console.log("### " + s.id + " " + s.name + "（" + r.provider + "/" + r.model + "）");
  console.log("patch " + patchPath + ":");
  process.stdout.write(patchOf(s));
  console.log("command:");
  console.log("  dsh --patch " + patchPath + " --profile headless" + (first ? "" : " --session-id " + SID) + " --json " + JSON.stringify("【" + s.id + " " + s.name + "】" + s.task));
  console.log("prompt（增量，不重复整份 ROLE）：" + s.task);
  first = false;
});
console.log("");
console.log("## 3. 账本事件（每步 1 started + 1 finished + 1 usage）");
console.log(JSON.stringify({ type: "plan.created", actor: "lead", case: plan.case, agent: plan.agent, steps: plan.steps.length }, null, 0));
plan.steps.slice(0, 3).forEach(s => {
  const r = base[s.tier] || base.fast;
  console.log(JSON.stringify({ type: "agent.step.started", actor: plan.agent, case: plan.case, stage: s.id, model: r.model, sessionId: SID }, null, 0));
  console.log(JSON.stringify({ type: "agent.step.finished", actor: plan.agent, case: plan.case, stage: s.id, model: r.model, ms: 60000, tokens: { input: 18000, output: 2600, cacheRead: 7000 } }, null, 0));
  console.log(JSON.stringify({ type: "agent.usage", actor: plan.agent, case: plan.case, stage: s.id, model: r.model, totalTokens: 27600 }, null, 0));
});
console.log("（S3–S7 同构，省略）");
console.log("");
console.log("## 4. 面板预览（宏观列）");
console.log("宏观  ● 运行中  8 步   模型 deepseek-v4.1-flash");
plan.steps.forEach((s, i) => {
  const r = base[s.tier] || base.fast;
  console.log("  " + (i === plan.steps.length - 1 ? "└" : "├") + " " + s.id + " " + s.name.padEnd(8, " ") + " · " + r.model + " · " + s.tier);
});
console.log("");
console.log("## 5. 重试 / 重新规划约定");
console.log("- 单步失败：同 session 重跑该步（同 patch），账本 agent.step.failed → 面板卡片标红");
console.log("- 连续失败：切 fallback 模型重跑该步（同 session），面板显示「重试·换模型」");
console.log("- 发现新情况：执行器请求 Lead replan → plan.updated，面板出现「计划变更·待确认」");
console.log("- 规划器不可用：回退静态步骤表（同一份 plan 模板），记 plan.fallback");
