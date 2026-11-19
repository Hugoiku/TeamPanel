#!/usr/bin/env node
"use strict";
/** agent-loop-lib — 双层 Agent Loop 的共享状态/事件/契约工具。 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BROKER = process.env.DESK_BROKER || "http://127.0.0.1:7801";
const LOOP_DIR = path.join(ROOT, "runtime/agent-loops");

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BROKER + p);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      agent: false,
      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { let j = {}; try { j = data ? JSON.parse(data) : {}; } catch (e) { j = { raw: data }; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function emit(type, actor, payload) {
  try { await api("POST", "/api/event", Object.assign({ type, actor, case: payload.case || "default" }, payload)); } catch (e) {}
}
function loopId(kind) { return "AL" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function statePath(id) { return path.join(LOOP_DIR, id + ".json"); }
function readState(id) { try { return JSON.parse(fs.readFileSync(statePath(id), "utf8")); } catch (e) { return null; } }
function writeState(state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(LOOP_DIR, { recursive: true });
  fs.writeFileSync(statePath(state.id), JSON.stringify(state, null, 2));
}
function appendTrace(state, type, detail) {
  state.trace = Array.isArray(state.trace) ? state.trace : [];
  state.trace.push({ at: new Date().toISOString(), type, detail: String(detail || "").slice(0, 800) });
  if (state.trace.length > 120) state.trace = state.trace.slice(-120);
}
function stopRequested(id) { return fs.existsSync(path.join(LOOP_DIR, id + ".stop")); }
async function caseBudget(caseId) {
  try { const r = await api("GET", "/api/budget?case=" + encodeURIComponent(caseId)); return r.body || {}; }
  catch (e) { return { tokens: 0, limit: 0, remaining: null, exceeded: false }; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseContract(answer) {
  const text = String(answer || "");
  const blocks = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[1]);
  const candidates = blocks.concat([text]);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const s = String(candidates[i] || "").trim();
    if (!s) continue;
    try { const j = JSON.parse(s); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch (e) {}
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) { try { const j = JSON.parse(s.slice(a, b + 1)); if (j && typeof j === "object") return j; } catch (e) {} }
  }
  return null;
}
function runEmployee(agent, caseId, task, stage, opts) {
  const o = opts || {};
  const args = [path.join(ROOT, "runtime/agents/employee.js"), "--agent", agent, "--case", caseId,
    "--task", task, "--stage", stage || ""];
  if (o.provider) args.push("--provider", String(o.provider));
  if (o.model) args.push("--model", String(o.model));
  if (o.effort) args.push("--effort", String(o.effort));
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 20 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024, env: process.env });
  let j = null;
  try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {
    try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e2) {}
  }
  return { ok: !!(j && j.ok), employee: j, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}
module.exports = { ROOT, BROKER, LOOP_DIR, api, emit, loopId, readState, writeState, appendTrace,
  stopRequested, caseBudget, sleep, parseContract, runEmployee };
