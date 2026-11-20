#!/usr/bin/env node
"use strict";
/**
 * test-report-verify — 已签发报告的可复现性校验端到端。
 * 覆盖：manifest sha、signature sha、manifest version、证据文件、dataAsOf。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require("./agent-loop-lib");
const ROOT = lib.ROOT;
const TAG = Date.now().toString(36);
const CASE = "verify-test-" + TAG;
const base = path.join(ROOT, "vault", CASE);
const reportRel = "reports/final-report.docx";
const reportAbs = path.join(base, reportRel);
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
fs.mkdirSync(path.join(base, "reports"), { recursive: true });
fs.mkdirSync(path.join(base, "evidence"), { recursive: true });
fs.writeFileSync(reportAbs, Buffer.from("PK\x05\x06" + TAG));
const reportSha = sha(reportAbs);
fs.writeFileSync(path.join(base, "reports", "final-manifest.json"), JSON.stringify({
  version: 1, dataAsOf: "2026-11-20", inputs: { [reportRel]: { sha: reportSha } },
  dataFreshness: { items: [] }
}, null, 2));
fs.writeFileSync(path.join(base, "reports", "final-signature.json"), JSON.stringify({
  path: reportRel, by: "test", at: new Date().toISOString(), version: 1,
  manifestVersion: 1, sha: reportSha
}, null, 2));
fs.writeFileSync(path.join(base, "evidence", "sources.jsonl"), "");
(async () => {
  const ok = await lib.api("GET", "/api/report/verify?case=" + encodeURIComponent(CASE));
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.ok, true, JSON.stringify(ok.body));
  assert(ok.body.checks.every(c => c.ok), JSON.stringify(ok.body.checks));
  console.log("PASS 1 signed report verify ok");

  fs.appendFileSync(reportAbs, Buffer.from("tampered"));
  const bad = await lib.api("GET", "/api/report/verify?case=" + encodeURIComponent(CASE));
  assert.strictEqual(bad.status, 409, JSON.stringify(bad.body));
  assert.strictEqual(bad.body.ok, false);
  assert(bad.body.checks.some(c => c.id === "manifest_report_sha" && !c.ok));
  console.log("PASS 2 tampered report verify fails");
  fs.rmSync(base, { recursive: true, force: true });
  console.log("ALL PASS test-report-verify");
})().catch(e => { console.error("FAIL test-report-verify:", e && e.message || e); try { fs.rmSync(base, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
