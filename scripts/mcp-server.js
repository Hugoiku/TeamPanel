#!/usr/bin/env node
"use strict";
/**
 * mcp-server — 把 Tool Gateway 暴露为 MCP stdio server。
 *
 *   node scripts/mcp-server.js
 *
 * 任何支持 MCP 的 Agent runtime 都可以通过 tools/list / tools/call 调用
 * AlphaDesk 的领域工具；工具执行仍走 Tool Gateway（权限/幂等/审计）。
 *
 * 协议：JSON-RPC 2.0，一行一个 JSON（stdout）；日志只写 stderr。
 */
const readline = require("readline");
const gateway = require("./tool-gateway");

const PROTOCOL = "2024-11-05";
function safeName(n) { return String(n).replace(/\./g, "__"); }
function realName(n) { return String(n).replace(/__/g, "."); }
function catalog() {
  return gateway.catalog().map(t => ({ name: safeName(t.name), description: t.description, inputSchema: t.inputSchema }));
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + String.fromCharCode(10)); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === "initialize") {
    return reply(id, { protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "alphadesk-tool-gateway", version: "0.1.0" } });
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: catalog() });
  if (method === "tools/call") {
    const p = msg.params || {};
    const name = realName(p.name || "");
    try {
      const r = await gateway.invoke(name, p.arguments || {}, { actor: "mcp", case: (p.arguments || {}).case || "default", traceId: "mcp" });
      return reply(id, { content: [{ type: "text", text: JSON.stringify(r).slice(0, 12000) }], isError: !r.ok });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true });
    }
  }
  return error(id, -32601, "method not found: " + method);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async line => {
  const s = String(line || "").trim();
  if (!s) return;
  let msg = null;
  try { msg = JSON.parse(s); } catch (e) { return error(null, -32700, "parse error"); }
  try { await handle(msg); } catch (e) { error(msg && msg.id, -32603, String((e && e.message) || e)); }
});
rl.on("close", () => process.exit(0));
