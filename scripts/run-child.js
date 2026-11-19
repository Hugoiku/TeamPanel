#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BROKER = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function arg(n, d) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const CASE = arg("case", "default"), ID = arg("id", "");
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BROKER + p, { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, res => {
      let s = ""; res.on("data", d => s += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
(async () => {
  if (!ID) process.exit(2);
  const w = await api("GET", "/api/work?case=" + encodeURIComponent(CASE));
  const item = (w.body.items || []).find(x => x.id === ID);
  if (!item) { console.error("child not found"); process.exit(3); }
  await api("POST", "/api/work/child/start", { case: CASE, id: ID });
  const workDir = path.join(ROOT, "runtime/work", ID); fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, "result.json");
  const task = "【子任务 " + ID + "｜父任务 " + (item.parentWorkId || "") + "】\n" + item.task +
    "\n输出要求：先写交付物到本任务临时工作区；结束时用 2–3 句话总结结论、证据和仍未完成项。";
  const args = [path.join(ROOT, "runtime/agents/employee.js"), "--agent", item.agent || "macro",
    "--case", CASE, "--stage", "CHILD-" + ID, "--provider", "opencode-go",
    "--model", "deepseek-v4.1-flash", "--effort", "high", "--task", task, "--short-prompt"];
  const child = spawn(process.execPath, args, { cwd: ROOT,
    env: Object.assign({}, process.env, { DESK_WORK_ID: ID }) });
  let out = "", err = "";
  child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
  child.on("close", async code => {
    function extractAnswer(text) {
      const raw = String(text || "").trim();
      if (!raw) return "";
      try { const j = JSON.parse(raw); if (j && j.answer) return String(j.answer); } catch (e) {}
      const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { const j = JSON.parse(raw.slice(start, end + 1)); if (j && j.answer) return String(j.answer); } catch (e) {}
      }
      const lines = raw.split(String.fromCharCode(10));
      for (let i = lines.length - 1; i >= 0; i--) {
        try { const j = JSON.parse(lines[i].trim()); if (j && j.answer) return String(j.answer); } catch (e) {}
      }
      return "";
    }
    let answer = extractAnswer(out);
    fs.writeFileSync(outPath, JSON.stringify({ id: ID, parentWorkId: item.parentWorkId, ok: code === 0, answer: answer.slice(0, 4000), error: String(err).slice(0, 1000) }, null, 2));
    await api("POST", "/api/work/child/finish", { case: CASE, id: ID, ok: code === 0,
      partial: code !== 0, error: code === 0 ? "" : String(err || ("exit " + code)).slice(0, 800) });
    process.exit(code === 0 ? 0 : 1);
  });
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
