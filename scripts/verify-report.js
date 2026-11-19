#!/usr/bin/env node
"use strict";
/**
 * verify-report — 校验报告可复现性：报告 sha、manifest、签名、证据、快照。
 *   node scripts/verify-report.js --case c_xxx [--path reports/final-report.docx]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const CASE = arg("case", "");
if (!CASE) { console.error("--case required"); process.exit(2); }
const REL = arg("path", "reports/final-report.docx");
const VAULT = path.join(ROOT, "vault", CASE);
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } }
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
const checks = [];
const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail || "") });
const abs = path.join(VAULT, REL);
add("report_exists", fs.existsSync(abs), abs);
const manifest = readJson(path.join(VAULT, "reports/final-manifest.json"), null);
add("manifest_exists", !!manifest, "reports/final-manifest.json");
const sig = readJson(path.join(VAULT, "reports/final-signature.json"), null);
add("signature_exists", !!sig, "reports/final-signature.json");
let reportSha = "";
if (fs.existsSync(abs)) reportSha = sha(abs);
if (manifest && manifest.inputs && manifest.inputs[REL]) add("manifest_report_sha", reportSha === manifest.inputs[REL].sha,
  reportSha + " vs " + manifest.inputs[REL].sha);
else add("manifest_report_sha", false, "manifest 未记录报告 sha");
if (sig && sig.sha) add("signature_sha", reportSha === sig.sha, reportSha + " vs " + sig.sha);
else add("signature_sha", false, "签名无 sha");
if (manifest && sig) add("manifest_version", Number(manifest.version) === Number(sig.manifestVersion),
  "manifest=" + manifest.version + " sig=" + sig.manifestVersion);
else add("manifest_version", false, "缺少 manifest/签名版本");
const evFile = path.join(VAULT, "evidence/sources.jsonl");
const evs = {};
try {
  fs.readFileSync(evFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).forEach(line => {
    try { const e = JSON.parse(line); if (e.id) evs[e.id] = e; } catch (e) {}
  });
  add("evidence_file", true, Object.keys(evs).length + " 条");
} catch (e) { add("evidence_file", false, "evidence/sources.jsonl 不可读"); }
const fresh = (manifest && manifest.dataFreshness && manifest.dataFreshness.items) || [];
const missingEv = fresh.filter(x => x.evidenceId && !evs[x.evidenceId]);
add("evidence_ids", missingEv.length === 0, missingEv.map(x => x.evidenceId).slice(0, 5).join(","));
const missingSnap = [];
fresh.forEach(x => {
  const e = x.evidenceId && evs[x.evidenceId];
  const sid = e && e.snapshot && e.snapshot.id;
  if (sid && !fs.existsSync(path.join(ROOT, "runtime/data/gateway", sid + ".json"))) missingSnap.push(sid);
});
add("evidence_snapshots", missingSnap.length === 0, missingSnap.slice(0, 5).join(","));
add("data_as_of", !!manifest && !!manifest.dataAsOf, manifest && manifest.dataAsOf || "manifest 无 dataAsOf");
const ok = checks.every(c => c.ok);
console.log(JSON.stringify({ ok, case: CASE, path: REL, reportSha,
  manifestVersion: manifest && manifest.version || null, checks }, null, 2));
process.exit(ok ? 0 : 1);
