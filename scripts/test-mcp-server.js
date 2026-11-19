#!/usr/bin/env node
"use strict";
/** test-mcp-server — MCP stdio server 冒烟：initialize / tools/list / tools/call。 */
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const ROOT = path.resolve(__dirname, "..");

function waitFor(rl, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting id " + id)), timeoutMs || 15000);
    const onLine = line => {
      let j = null; try { j = JSON.parse(line); } catch (e) { return; }
      if (j.id === id) { clearTimeout(timer); rl.off("line", onLine); resolve(j); }
    };
    rl.on("line", onLine);
  });
}
(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts/mcp-server.js")], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout });
  const send = o => child.stdin.write(JSON.stringify(o) + String.fromCharCode(10));
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await waitFor(rl, 1);
    if (!init.result || init.result.serverInfo.name !== "alphadesk-tool-gateway") throw new Error("initialize failed");
    console.log("  PASS initialize");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await waitFor(rl, 2);
    const names = (list.result.tools || []).map(t => t.name);
    if (names.indexOf("case__snapshot") < 0) throw new Error("tools/list missing case__snapshot");
    console.log("  PASS tools/list · " + names.length + " tools");
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "case__snapshot", arguments: { case: "default" } } });
    const call = await waitFor(rl, 3);
    if (!call.result || call.result.isError) throw new Error("tools/call failed: " + JSON.stringify(call.result || call.error));
    const text = (call.result.content || [])[0] && call.result.content[0].text || "";
    if (text.indexOf('"ok":true') < 0) throw new Error("tools/call result not ok");
    console.log("  PASS tools/call case.snapshot");
    console.log(JSON.stringify({ ok: true, tools: names.length }));
  } catch (e) {
    console.error("  FAIL " + String((e && e.message) || e));
    process.exitCode = 1;
  } finally {
    try { child.kill("SIGKILL"); } catch (e) {}
  }
})();
