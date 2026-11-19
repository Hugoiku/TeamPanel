"use strict";
/** Background final synthesis: short model summary, then v2 Word. Never blocks /api/report/final. */
const fs = require("fs"), path = require("path"), http = require("http"), { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const statusDir = path.join(ROOT, "runtime/final-synthesis");
fs.mkdirSync(statusDir, { recursive: true });
const statusPath = path.join(statusDir, CASE + ".json");
function write(status, extra) { fs.writeFileSync(statusPath, JSON.stringify(Object.assign({ case: CASE, status, updatedAt: new Date().toISOString() }, extra || {}), null, 2)); }
function event(type, payload) {
  try {
    const body = JSON.stringify(Object.assign({ case: CASE, type, actor: "system", lane: "lead" }, payload || {}));
    const req = http.request({ hostname: "127.0.0.1", port: 7801, path: "/api/event", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
    req.on("error", () => {}); req.write(body); req.end();
  } catch (e) {}
}
write("running", { startedAt: new Date().toISOString() }); event("final.synthesis.started", {});
const fr = spawnSync(process.execPath, [path.join(ROOT, "scripts/final-report.js"), "--case", CASE, "--out", "reports/final-draft.md"],
  { cwd: ROOT, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
let fj = null; try { fj = JSON.parse(String(fr.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
if (!fj || !fj.ok) {
  const err = String((fj && fj.error) || fr.stderr || "synthesis failed").slice(0, 400);
  write("failed", { error: err, fallback: true }); event("final.synthesis.failed", { error: err }); process.exit(3);
}
const clean = path.join(ROOT, "runtime/cache", "final-synth-" + Date.now() + ".md");
const deskCase = CASE;
const tc = spawnSync(process.execPath, [path.join(ROOT, "scripts/tone-clean.js"), "--md", path.join(ROOT, "vault", CASE, "reports/final-draft.md"), "--out", clean],
  { cwd: ROOT, encoding: "utf8", timeout: 60000 });
let tone = null; try { tone = JSON.parse(String(tc.stdout || "").trim()); } catch (e) {}
const dx = spawnSync(process.env.PYTHON || "python3", [path.join(ROOT, "scripts/md_to_docx.py"), "--md", clean,
  "--out", "reports/final-report.docx", "--case", CASE, "--title", (CASE + "研究报告")],
  { cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { PYTHONPATH: path.join(ROOT, "runtime/py") }) });
let dj = null; try { dj = JSON.parse(String(dx.stdout || "").trim().split(String.fromCharCode(10)).pop()); } catch (e) {}
if (!dj || !dj.ok) {
  const err = String((dj && dj.error) || dx.stderr || "docx failed").slice(0, 400);
  write("failed", { error: err, synthesisOk: true }); event("final.synthesis.failed", { error: err }); process.exit(4);
}
let manifest = null; try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "vault", CASE, "reports/final-manifest.json"), "utf8")); } catch (e) {}
if (manifest) { manifest.synthesis = { ok: true, model: fj.model, citations: fj.citations }; manifest.final = dj.out; manifest.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(path.join(ROOT, "vault", CASE, "reports/final-manifest.json"), JSON.stringify(manifest, null, 2)); } catch (e) {} }
write("done", { out: dj.out, citations: fj.citations, tone: tone || null });
event("final.synthesis.done", { out: dj.out, citations: fj.citations });
