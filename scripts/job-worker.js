"use strict";
/** Generic async job worker (semantic review etc). */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.DESK_BROKER || "http://127.0.0.1:7801";
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
function apiOnce(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, res => {
      let s = ""; res.on("data", d => s += d); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
async function api(method, p, body) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await apiOnce(method, p, body); }
    catch (e) {
      last = e;
      if (!/ECONNRESET|EPIPE|ECONNREFUSED|socket hang up/i.test(String((e && e.message) || e))) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}
const CASE = arg("case", "");
if (!CASE) { console.error("--case required"); process.exit(2); }
async function handle(job) {
  if (job.type === "semantic_review") {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/semantic-review.js"), "--case", CASE],
      { cwd: ROOT, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (e) {}
    if (r.status !== 0 || !j || j.ok === false) return { status: "failed", error: String((j && j.error) || r.stderr || ("exit " + r.status)).slice(0, 800) };
    return { status: "done", output: j.out || "", result: { issues: j.issues || 0, high: j.high || 0 } };
  }
  if (job.type === "case_brief_model") {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/case-brief-model.js"), "--case", CASE], { cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
    if (r.status !== 0 || !j || j.ok === false) return { status: "failed", error: String((j && j.error) || r.stderr || ("exit " + r.status)).slice(0, 800) };
    return { status: "done", result: j };
  }
  if (job.type === "figure_plan") {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/figure-plan.js"), "--case", CASE], { cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
    if (r.status !== 0 || !j || j.ok === false) return { status: "failed", error: String((j && j.error) || r.stderr || ("exit " + r.status)).slice(0, 800) };
    return { status: "done", result: j };
  }
  if (job.type === "figure_generate") {
    const items = (job.payload && job.payload.items) || [];
    const out = [];
    for (const it of items) {
      const rel = "figures/ai-" + String(it.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, "") + ".png";
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/gen-image.js"),
        "--prompt", String(it.prompt || it.title || ""), "--out", path.join(ROOT, "vault", CASE, rel),
        "--upload", CASE, "--path", rel], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
      out.push({ id: it.id, title: it.title, ok: r.status === 0, rel, error: r.status === 0 ? "" : String(r.stderr || r.stdout || "").slice(0, 300) });
    }
    const ok = out.some(x => x.ok);
    return { status: ok ? "done" : "failed", result: out, error: ok ? "" : "all image generations failed" };
  }
  if (job.type === "conflict_resolve") {
    const args = [path.join(ROOT, "scripts/conflict-resolve.js"), "--case", CASE];
    if (job.payload && job.payload.force) args.push("--force");
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    let j = null; try { j = JSON.parse(String(r.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
    if (r.status !== 0 || !j || j.ok === false) return { status: "failed", error: String((j && j.error) || r.stderr || ("exit " + r.status)).slice(0, 800) };
    return { status: "done", result: j };
  }
  if (job.type === "brief_build") {
    const agents = (job.payload && job.payload.agents) || ["macro", "industry", "stock"];
    const out = [];
    for (const a of agents) {
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/brief.js"), "--case", CASE, "--agent", a], { cwd: ROOT, encoding: "utf8" });
      out.push({ agent: a, ok: r.status === 0 });
    }
    return { status: "done", result: out };
  }
  return { status: "failed", error: "unknown job type: " + job.type };
}
async function tick() {
  const q = await api("GET", "/api/jobs?case=" + encodeURIComponent(CASE) + "&status=queued");
  const job = (q.body.jobs || [])[0];
  if (!job) return false;
  const cl = await api("POST", "/api/job/claim", { case: CASE, id: job.id, owner: "job-worker", pid: process.pid });
  if (cl.status !== 200) return false;
  const cur = cl.body.job;
  let res;
  try { res = await handle(cur); } catch (e) { res = { status: "failed", error: String(e && e.message || e).slice(0, 800) }; }
  await api("POST", "/api/job/update", Object.assign({ case: CASE, id: cur.id, by: "job-worker" }, res));
  if (cur.type === "semantic_review" && res.status === "done") {
    // 语义结果已变化，旧冲突方案失效；重新生成，避免用户只能看到已 applied 的旧项。
    try {
      const cf = path.join(ROOT, "vault", CASE, "research", "conflicts.json");
      if (fs.existsSync(cf)) {
        fs.mkdirSync(path.join(ROOT, "runtime/backups"), { recursive: true });
        fs.copyFileSync(cf, path.join(ROOT, "runtime/backups", CASE + "-conflicts-" + Date.now() + ".json"));
        fs.unlinkSync(cf);
      }
    } catch (e) {}
    try { await api("POST", "/api/conflict/resolve", { case: CASE, by: "job-worker" }); } catch (e) {}
  }
  return true;
}
(async () => {
  if (flag("once")) { console.log(JSON.stringify({ ok: true, processed: await tick() })); process.exit(0); }
  while (true) { const did = await tick(); if (!did) await new Promise(r => setTimeout(r, 3000)); }
})().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
