#!/usr/bin/env node
"use strict";
/**
 * test-openai-opencode — 用真实 opencode-go 网关验证 openai runtime + function calling。
 *   node scripts/test-openai-opencode.js
 *
 * 从 ~/.dsh/.credentials.yaml 读取 OPENCODE_GO_API_KEY，不打印 key。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run } = require("./agent-runtime");

function readOpenCodeKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  try {
    const s = fs.readFileSync(path.join(os.homedir(), ".dsh/.credentials.yaml"), "utf8");
    const m = s.match(/OPENCODE_GO_API_KEY:\s*([^\s]+)/);
    return m ? m[1] : "";
  } catch (e) { return ""; }
}
(async () => {
  const key = readOpenCodeKey();
  if (!key) { console.log("SKIP 未找到 OPENCODE_GO_API_KEY"); return; }
  process.env.AGENT_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
  process.env.AGENT_OPENAI_MODEL = "deepseek-v4.1-flash";
  process.env.AGENT_OPENAI_KEY = key;
  process.env.AGENT_OPENAI_HEADERS = JSON.stringify({ "x-opencode-session": "alphadesk-agent-loop-test" });
  try {
    const r = await run("openai", "industry", "default",
      "先调用 case.snapshot 工具查看 default case，然后只返回一个 JSON 结果契约：" +
      "{\"status\":\"done\",\"summary\":\"opencode-go test\",\"artifacts\":[],\"evidenceIds\":[],\"openQuestions\":[],\"needs\":[],\"confidence\":0.9}",
      "opencode-go-test");
    if (!r.ok) throw new Error(r.error || "runtime failed");
    const emp = r.employee || {};
    if (!(emp.toolCalls || []).some(x => x.name === "case.snapshot")) throw new Error("未记录 case.snapshot 工具调用");
    if (!/\"status\"\s*:\s*\"done\"/.test(emp.answer || "")) throw new Error("最终回答缺少 done 契约");
    console.log("  PASS opencode-go / openai runtime function calling");
    console.log(JSON.stringify({ ok: true, toolCalls: emp.toolCalls, usage: emp.usage,
      answer: String(emp.answer || "").slice(0, 300) }));
  } catch (e) {
    console.error("  FAIL " + String((e && e.message) || e));
    process.exitCode = 1;
  }
})();
