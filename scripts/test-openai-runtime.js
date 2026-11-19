#!/usr/bin/env node
"use strict";
/**
 * test-openai-runtime — 用本地 mock OpenAI-compatible 网关验证 function calling 路径。
 *   node scripts/test-openai-runtime.js
 */
const http = require("http");
const assert = require("assert");
const { run } = require("./agent-runtime");

(async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      calls += 1;
      res.setHeader("content-type", "application/json");
      if (calls === 1) {
        res.end(JSON.stringify({
          id: "mock-1", object: "chat.completion",
          choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "case__snapshot", arguments: JSON.stringify({ case: "default" }) } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }));
      } else {
        res.end(JSON.stringify({
          id: "mock-2", object: "chat.completion",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
            content: JSON.stringify({ status: "done", summary: "mock openai runtime", artifacts: [],
              evidenceIds: [], openQuestions: [], needs: [], confidence: 0.9 }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }
        }));
      }
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  process.env.AGENT_OPENAI_BASE_URL = "http://127.0.0.1:" + port + "/v1";
  process.env.AGENT_OPENAI_MODEL = "mock-model";
  process.env.AGENT_OPENAI_KEY = "mock-key";
  try {
    const r = await run("openai", "industry", "default", "mock task", "test-stage");
    assert.strictEqual(r.ok, true, "runtime should be ok");
    assert.ok(r.employee && r.employee.answer && /"status":"done"/.test(r.employee.answer), "final answer contract");
    const tc = (r.employee.toolCalls || []).find(x => x.name === "case.snapshot");
    assert.ok(tc, "tool call recorded");
    assert(tc.input && tc.input.case === "default", "tool args recorded");
    assert(tc.result && /"case"/.test(tc.result), "tool result recorded");
    assert.ok(r.employee.usage && r.employee.usage.total >= 43, "usage accumulated");
    console.log("  PASS openai runtime function calling + Tool Gateway");
    console.log(JSON.stringify({ ok: true, calls, toolCalls: r.employee.toolCalls, usage: r.employee.usage }));
  } catch (e) {
    console.error("  FAIL " + String((e && e.message) || e));
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
