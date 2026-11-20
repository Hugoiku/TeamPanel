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
assert.strictEqual(ready.quality.claims.total, 2);
assert.strictEqual(ready.quality.claims.mapped, 1);
assert.ok(ready.inbox.some(x => x.type === "brief"));
fs.rmSync(root, { recursive: true, force: true });
console.log("ALL PASS test-case-view");
