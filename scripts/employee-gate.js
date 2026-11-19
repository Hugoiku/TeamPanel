#!/usr/bin/env node
"use strict";
/**
 * employee-gate — Employee Loop 结果契约的确定性验收。
 * 模型可以“说完成”，但只有 artifact / evidence / needs / schema 都过关，才算 done。
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

function vaultPath(caseId, rel) {
  const safe = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!safe || safe.startsWith("/") || safe.split("/").indexOf("..") >= 0) return "";
  return path.join(ROOT, "vault", caseId, safe);
}
// 产物声明可能是 "research/x.md §章节" 或对象；与 broker 的 outputRel 保持一致的解析。
function relOf(o) {
  if (o && typeof o === "object") o = o.path || o.file || o.name || "";
  const raw = String(o || "").trim();
  if (!raw) return "";
  const first = raw.split(/\s+§|#/)[0].trim();
  return first || raw.split(/\s+/)[0];
}
function outputRel(caseId, o) {
  const raw = String(o || "").trim();
  if (!raw) return "";
  const candidates = [raw.split(/\s+§|#/)[0].trim(), raw.split(/\s+/)[0], relOf(o)];
  for (const c of candidates) { const p = vaultPath(caseId, c); if (p && fs.existsSync(p)) return c; }
  return candidates[0] || "";
}
function evidenceIds(caseId) {
  const out = new Set();
  try {
    const f = path.join(ROOT, "vault", caseId, "evidence/sources.jsonl");
    for (const line of fs.readFileSync(f, "utf8").split(String.fromCharCode(10))) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.id) out.add(String(e.id)); } catch (e) {}
    }
  } catch (e) {}
  return out;
}
function check(caseId, contract, opts) {
  const c = contract || {};
  const work = (opts && opts.work) || {};
  const checks = [], issues = [];
  const add = (id, label, ok, detail) => {
    checks.push({ id, label, ok: !!ok, detail: detail || "" });
    if (!ok) issues.push(detail || label);
  };
  add("schema", "结果契约是对象", c && typeof c === "object" && !Array.isArray(c), "");
  add("status", "status 合法", ["continue", "done", "blocked"].indexOf(String(c.status || "")) >= 0,
    "status=" + String(c.status || ""));
  add("artifacts_array", "artifacts 是数组", Array.isArray(c.artifacts), "");
  add("evidence_array", "evidenceIds 是数组", Array.isArray(c.evidenceIds), "");
  add("needs_array", "needs 是数组", Array.isArray(c.needs), "");
  add("open_questions_array", "openQuestions 是数组", Array.isArray(c.openQuestions), "");
  if (c.confidence !== undefined && c.confidence !== null) {
    const n = Number(c.confidence);
    add("confidence", "confidence 在 0-1", Number.isFinite(n) && n >= 0 && n <= 1, "confidence=" + c.confidence);
  }

  const isDone = String(c.status) === "done";
  if (isDone) {
    const arts = Array.isArray(c.artifacts) ? c.artifacts : [];
    const missingArt = [];
    for (const a of arts) {
      const rel = outputRel(caseId, a);
      const p = rel ? vaultPath(caseId, rel) : "";
      if (!p || !fs.existsSync(p)) missingArt.push(a);
    }
    add("artifacts_exist", "artifact 文件真实存在", missingArt.length === 0,
      missingArt.length ? "缺失：" + missingArt.slice(0, 5).join(", ") : arts.length + " 个 artifact");

    const outputs = Array.isArray(work.outputs) ? work.outputs : [];
    const missingOut = [];
    for (const o of outputs) {
      const rel = outputRel(caseId, o);
      const p = rel ? vaultPath(caseId, rel) : "";
      if (!p || !fs.existsSync(p)) missingOut.push(o);
    }
    add("work_outputs", "WorkItem 声明产物存在", missingOut.length === 0,
      missingOut.length ? "缺失：" + missingOut.slice(0, 5).join(", ") : outputs.length + " 个声明产物");

    const known = evidenceIds(caseId);
    const evs = Array.isArray(c.evidenceIds) ? c.evidenceIds : [];
    const missingEv = evs.filter(x => !known.has(String(x)));
    add("evidence_exists", "evidenceIds 在 sources.jsonl 中存在", missingEv.length === 0,
      missingEv.length ? "缺失：" + missingEv.slice(0, 5).join(", ") : evs.length + " 条证据");
  }

  if (isDone) {
    add("done_no_needs", "done 时 needs 为空", (c.needs || []).length === 0,
      (c.needs || []).length ? "仍有 " + c.needs.length + " 个 need" : "");
    add("done_no_open", "done 时 openQuestions 为空", (c.openQuestions || []).length === 0,
      (c.openQuestions || []).length ? "仍有 " + c.openQuestions.length + " 个未决问题" : "");
  }
  return { ok: issues.length === 0, checks, issues, status: c.status || "" };
}
module.exports = { check, vaultPath, outputRel, evidenceIds };
