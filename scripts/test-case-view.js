#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cv = require("../runtime/domain/case-view");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "case-view-"));
const caseId = "c_test";
const base = path.join(root, "vault", caseId);
fs.mkdirSync(path.join(base, "research"), { recursive: true });
fs.mkdirSync(path.join(base, "evidence"), { recursive: true });
fs.writeFileSync(path.join(base, "research", "validation.json"), JSON.stringify({ ok: true, high: 0, evidence: 2 }));
fs.writeFileSync(path.join(base, "research", "brief-macro.json"), JSON.stringify({ stance: "中性", keyClaims: [{ id: "M1" }], keyAssumptions: ["a"] }));
fs.writeFileSync(path.join(base, "research", "brief-industry.json"), JSON.stringify({ stance: "", keyClaims: [], keyAssumptions: [] }));
fs.writeFileSync(path.join(base, "evidence", "sources.jsonl"), JSON.stringify({ id: "S1", field: "x", raw: "a", fetched_at: new Date().toISOString() }) + "\n");
fs.writeFileSync(path.join(base, "research", "claim-evidence.json"), JSON.stringify({ claimsEvidence: [{ id: "M1", mapped: true, refs: ["S1"] }, { id: "M2", mapped: false, refs: [] }] }));

function view(opts) { return cv.buildCaseView(Object.assign({ caseId, root, revision: 1 }, opts)); }
assert.strictEqual(view({ plans: [] }).phase, "PREPARE");
assert.strictEqual(view({ plans: [{ id: "P1", status: "pending" }] }).phase, "PLAN_PENDING");
assert.strictEqual(view({ plans: [{ id: "P1", status: "approved" }] }).phase, "READY_TO_RUN");
assert.strictEqual(view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "running" }] }).phase, "RUNNING");
assert.strictEqual(view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }] }).phase, "DRAFT_READY");
assert.strictEqual(view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: false }).phase, "DRAFT_READY");
const pending = view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: true,
  reviews: [{ service: "audit", status: "requested", path: "reports/final-report.docx" }] });
assert.strictEqual(pending.phase, "REVIEW_PENDING");
const ready = view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: true,
  reviews: [{ service: "audit", status: "clean", path: "reports/final-report.docx" }, { service: "legal", status: "clean", path: "reports/final-report.docx" }] });
assert.strictEqual(ready.phase, "READY_TO_SIGN");
assert.strictEqual(ready.primaryAction.id, "sign_report");
assert.strictEqual(ready.quality.claims.total, 2);
assert.strictEqual(ready.quality.claims.mapped, 1);
assert.ok(ready.inbox.some(x => x.type === "brief"));

const missingReview = view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: true,
  reviews: [{ service: "audit", status: "clean", path: "reports/final-report.docx" }] });
assert.strictEqual(missingReview.phase, "REVIEW_PENDING");
assert.strictEqual(missingReview.primaryAction.id, "request_review");
assert.deepStrictEqual(missingReview.primaryAction.services, ["legal"]);

const signed = view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: true,
  reviews: [{ service: "audit", status: "clean", path: "reports/final-report.docx" },
    { service: "legal", status: "clean", path: "reports/final-report.docx" }],
  signatures: { "reports/final-report.docx": { by: "you", at: "2026-01-01", version: 1 } } });
assert.strictEqual(signed.phase, "SIGNED");
assert.strictEqual(signed.primaryAction.id, "verify_report");

// 签名文件落盘后，CaseView 不依赖内存 map 也能识别 signed。
fs.mkdirSync(path.join(base, "reports"), { recursive: true });
fs.writeFileSync(path.join(base, "reports", "final-report.docx"), "PK");
fs.writeFileSync(path.join(base, "reports", "final-signature.json"), JSON.stringify({
  path: "reports/final-report.docx", by: "test", at: "2026-01-01", version: 1, manifestVersion: 1, sha: "x"
}));
const signedFromFile = view({ plans: [{ id: "P1", status: "approved" }], works: [{ id: "W1", state: "done" }], finalExists: true,
  reviews: [{ service: "audit", status: "clean", path: "reports/final-report.docx" },
    { service: "legal", status: "clean", path: "reports/final-report.docx" }] });
assert.strictEqual(signedFromFile.phase, "SIGNED");
assert.strictEqual(signedFromFile.primaryAction.id, "verify_report");
fs.rmSync(root, { recursive: true, force: true });
console.log("ALL PASS test-case-view");
