#!/usr/bin/env node
"use strict";
/**
 * intent — 规则意图分类器（零 token）
 *   const { classify } = require("./scripts/intent");
 *   classify("还需要什么数据") -> {kind:"question", ...}
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
let RULES = {};
try { RULES = JSON.parse(fs.readFileSync(path.join(ROOT, "config/intent-rules.json"), "utf8")); } catch (e) {}
function norm(s) {
  return String(s || "").replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[？?]/g, "?").replace(/[，,]/g, "，").trim().toLowerCase();
}
function stripPolite(s) {
  let t = s.trim();
  for (const p of (RULES.politePrefixes || [])) {
    if (t.startsWith(p)) { t = t.slice(p.length).trim(); break; }
  }
  return t;
}
function count(text, words) {
  let n = 0, hit = [];
  (words || []).forEach(w => { if (text.indexOf(w) >= 0) { n += 1; hit.push(w); } });
  return { n, hit };
}
function scoreText(text) {
  const qStrong = count(text, (RULES.question || {}).strong);
  const qWeak = count(text, (RULES.question || {}).weak);
  const suffix = (RULES.question || {}).suffix || [];
  const taskStart = count(stripPolite(text), (RULES.task || {}).strongStart);
  const taskAny = count(text, (RULES.task || {}).strongAny);
  const deliverable = count(text, (RULES.task || {}).deliverable);
  let q = 0, t = 0, reasons = [];
  if (qStrong.n) { q += 3 + Math.min(2, qStrong.n - 1); reasons.push("疑问词:" + qStrong.hit.join("/")); }
  if (qWeak.n) { q += 1; reasons.push("弱疑问:" + qWeak.hit.join("/")); }
  if (suffix.some(x => text.endsWith(x))) { q += 2; reasons.push("问句结尾"); }
  if (text.indexOf("?") >= 0 && !text.endsWith("?")) { q += 1; }
  if (taskStart.n) { t += 3 + Math.min(2, taskStart.n - 1); reasons.push("动作开头:" + taskStart.hit.join("/")); }
  if (taskAny.n) { t += 3; reasons.push("动作短语:" + taskAny.hit.join("/")); }
  // 产物词只在已有动作信号时加分；否则“还需要什么数据”会被误判成任务
  if (deliverable.n && (taskStart.n || taskAny.n)) { t += 1; reasons.push("产物词"); }
  // 特例：把…补一下/改一下
  if (/把.{0,40}(补|改|加|删|更新|重跑)/.test(text)) { t += 3; reasons.push("把字句动作"); }
  return { q, t, reasons };
}
function splitClauses(text) {
  const conjs = (RULES.mixed || {}).conjunctions || [];
  let s = text;
  conjs.forEach(c => { s = s.split(c).join("|"); });
  return s.split(/[，,。；;！!？?|]/).map(x => x.trim()).filter(Boolean);
}
function classify(text) {
  const raw = String(text || "").trim();
  if (!raw) return { kind: "empty", method: "rule", scores: { q: 0, t: 0 }, reasons: [] };
  const n = norm(raw);
  if ((RULES.ack || []).some(a => n === a.toLowerCase() || (n.length <= 6 && n.indexOf(a.toLowerCase()) >= 0)))
    return { kind: "ack", method: "rule", scores: { q: 0, t: 0 }, reasons: ["确认/寒暄"] };
  const clauses = splitClauses(raw);
  if (clauses.length > 1) {
    const kinds = clauses.map(c => { const s = scoreText(c); return s.q >= 3 && s.t === 0 ? "question" : (s.t >= 3 && s.q === 0 ? "task" : null); });
    if (kinds.indexOf("question") >= 0 && kinds.indexOf("task") >= 0)
      return { kind: "mixed", method: "rule", scores: { q: 3, t: 3 }, reasons: ["分句含问题+任务"] };
  }
  const s = scoreText(raw);
  if (s.q >= 3 && s.t === 0) return { kind: "question", method: "rule", scores: s, reasons: s.reasons };
  if (s.t >= 3 && s.q === 0) return { kind: "task", method: "rule", scores: s, reasons: s.reasons };
  if (s.q > 0 && s.t > 0) return { kind: "ambiguous", method: "rule", scores: s, reasons: s.reasons };
  if (s.q >= 2 && s.t === 0) return { kind: "question", method: "rule", scores: s, reasons: s.reasons };
  if (s.t >= 2 && s.q === 0) return { kind: "task", method: "rule", scores: s, reasons: s.reasons };
  return { kind: "ambiguous", method: "rule", scores: s, reasons: s.reasons };
}
module.exports = { classify, scoreText, splitClauses };
if (require.main === module) {
  const args = process.argv.slice(2);
  let text = args.join(" ");
  const i = args.indexOf("--text");
  if (i >= 0) text = args.slice(i + 1).join(" ");
  console.log(JSON.stringify(classify(text), null, 2));
}
