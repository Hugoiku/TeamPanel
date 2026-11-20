"use strict";
/**
 * case-view — 单用户研究台的只读投影。
 * 目标：把 plans/work/needs/reviews/evidence/claims/briefs 收敛成一个
 * "当前阶段 + 下一步 + 阻塞项 + 质量摘要"，Panel 不再自己拼状态。
 * 不写任何状态；所有输入来自账本/内存/研究产物。
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "../..");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}
function readJsonl(file) {
  const out = [];
  try {
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch (e) {}
    });
  } catch (e) {}
  return out;
}
function fmtCount(n) { return Number(n) || 0; }

function evidenceSummary(caseDir) {
  const items = readJsonl(path.join(caseDir, "evidence", "sources.jsonl"));
  const validation = readJson(path.join(caseDir, "research", "validation.json")) || {};
  const duplicates = readJson(path.join(caseDir, "research", "evidence-duplicates.json")) || {};
  const duplicateIds = new Set();
  (duplicates.groups || []).forEach(g => (g.ids || g.items || []).forEach(id => duplicateIds.add(String(id))));
  const now = Date.now();
  const out = { total: items.length, verified: 0, unverified: 0, conflict: 0, stale: 0, superseded: 0, items: [] };
  for (const e of items) {
    const id = String(e.id || "");
    if (!id) continue;
    let status = "unverified";
    const hasSource = !!(e.raw || e.sha256 || e.url);
    const ageDays = e.fetched_at ? (now - Date.parse(e.fetched_at)) / 86400000 : 999;
    if (e.superseded) status = "superseded";
    else if (duplicateIds.has(id)) status = "conflict";
    else if (ageDays > 90) status = "stale";
    else if (hasSource && validation && validation.high === 0) status = "verified";
    out[status] += 1;
    out.items.push({ id, field: e.field || "", status, tier: e.source_tier || e.tier || "",
      fetchedAt: e.fetched_at || "", hasSource });
  }
  return out;
}

function claimSummary(caseDir) {
  const ce = readJson(path.join(caseDir, "research", "claim-evidence.json")) || {};
  const list = ce.claimsEvidence || ce.claims || [];
  const items = list.map(c => {
    const refs = c.refs || [];
    const mapped = c.mapped === true || (c.mapped === undefined && refs.length > 0);
    return { id: c.id || "", text: String(c.text || "").slice(0, 160), mapped, refs };
  });
  const mapped = items.filter(x => x.mapped).length;
  return { total: items.length, mapped, unmapped: items.length - mapped, items };
}

function briefSummary(caseDir) {
  const agents = ["macro", "industry", "stock"];
  const items = agents.map(agent => {
    const b = readJson(path.join(caseDir, "research", "brief-" + agent + ".json"));
    if (!b) return { agent, status: "missing", stance: "", claims: 0, assumptions: 0 };
    const claims = Array.isArray(b.keyClaims) ? b.keyClaims.length : 0;
    const assumptions = Array.isArray(b.keyAssumptions) ? b.keyAssumptions.length : 0;
    const complete = !!String(b.stance || "").trim() && claims > 0;
    return { agent, status: complete ? "complete" : (claims || assumptions ? "partial" : "empty"),
      stance: b.stance || "", claims, assumptions };
  });
  return { total: items.length, complete: items.filter(x => x.status === "complete").length, items };
}

function reportSummary(caseDir, reviews, signatures, finalExists) {
  const manifest = readJson(path.join(caseDir, "reports", "final-manifest.json")) || {};
  const list = Array.isArray(reviews) ? reviews : [];
  const latest = service => list.filter(r => r.service === service && r.path === "reports/final-report.docx")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  let sig = (signatures || {})["reports/final-report.docx"] || null;
  if (!sig) {
    const sf = readJson(path.join(caseDir, "reports", "final-signature.json"));
    if (sf && (!sf.path || sf.path === "reports/final-report.docx")) sig = sf;
  }
  const audit = latest("audit"), legal = latest("legal");
  return { exists: !!finalExists, manifest: manifest.version || 0,
    audit: audit ? audit.status : "missing", legal: legal ? legal.status : "missing",
    stale: false, staleReasons: [],
    signed: !!sig, signature: sig ? { by: sig.by, at: sig.at, version: sig.version } : null };
}

function derivePhase(input) {
  const { plans, works, needs, report } = input;
  const planList = plans || [], workList = works || [], needList = needs || [];
  const running = workList.some(w => w.state === "running" || w.state === "queued" || w.state === "cancelling");
  const failed = workList.some(w => w.state === "failed" || w.state === "cancelled");
  const pendingPlans = planList.filter(p => p.status === "pending");
  const approved = planList.filter(p => p.status === "approved" || p.status === "done");
  const humanNeeds = needList.filter(n => (n.status === "pending" || n.status === "partial") && n.kind !== "auto");
  const allWorkDone = workList.length > 0 && workList.filter(w => w.kind !== "child").every(w => w.state === "done");
  const reviewPending = report.audit === "requested" || report.audit === "running" ||
    report.legal === "requested" || report.legal === "running";
  const reviewFailed = report.audit === "returned" || report.audit === "conditional" ||
    report.legal === "returned" || report.legal === "conditional";

  if (!planList.length) return "PREPARE";
  if (pendingPlans.length) return "PLAN_PENDING";
  if (!running && !failed && approved.length && !workList.length) return "READY_TO_RUN";
  if (running) return "RUNNING";
  if (humanNeeds.length) return "DATA_GAP";
  if (failed) return "RUNNING";
  if (allWorkDone && !report.exists) return "DRAFT_READY";
  if (report.exists && report.stale) return "REPORT_STALE";
  if (report.exists && report.signed) return "SIGNED";
  if (report.exists && reviewPending) return "REVIEW_PENDING";
  if (report.exists && reviewFailed) return "REVIEW_FAILED";
  if (report.exists && (report.audit === "clean" || report.audit === "waived") &&
      (report.legal === "clean" || report.legal === "waived")) return "READY_TO_SIGN";
  if (report.exists) return "REVIEW_PENDING";
  return "RUNNING";
}

const PHASE_LABEL = {
  PREPARE: "准备", PLAN_PENDING: "待批准", READY_TO_RUN: "待启动",
  RUNNING: "执行中", DATA_GAP: "待补数据", DRAFT_READY: "初稿完成",
  REPORT_STALE: "报告过期", REVIEW_PENDING: "待复核", REVIEW_FAILED: "复核未通过",
  READY_TO_SIGN: "待签发", SIGNED: "已签发", VERIFIED: "已完成"
};
// 用户只看到 7 个阶段；内部 phase 仍保留细粒度，避免 UI 状态爆炸。
const USER_STAGE = {
  PREPARE: "准备", PLAN_PENDING: "待批准", READY_TO_RUN: "执行中",
  RUNNING: "执行中", DATA_GAP: "待补数据", DRAFT_READY: "执行中",
  REPORT_STALE: "待更新", REVIEW_PENDING: "待复核", REVIEW_FAILED: "待复核",
  READY_TO_SIGN: "待签发", SIGNED: "完成", VERIFIED: "完成"
};

function nextAction(phase, input) {
  const { plans, works, needs, report } = input;
  const allWorkDone = works.length > 0 && works.filter(w => w.kind !== "child").every(w => w.state === "done");
  if (phase === "PREPARE") return { id: "create_plan", label: "生成研究计划", owner: "human", enabled: true };
  if (phase === "PLAN_PENDING") return { id: "approve_plan", label: "批准计划", owner: "human", enabled: true };
  if (phase === "READY_TO_RUN") return { id: "start_execution", label: "启动执行", owner: "system", enabled: true };
  if (phase === "DATA_GAP") return { id: "fill_data", label: "去补数据", owner: "human", enabled: true };
  if (phase === "DRAFT_READY") return { id: "generate_report", label: "生成最终报告", owner: "system", enabled: true };
  if (phase === "REPORT_STALE") {
    if (input.crossReview && input.crossReview.high > 0 && !input.crossReview.waived)
      return { id: "fix_cross_review", label: "查看交叉复核", owner: "human", enabled: true };
    return { id: "regenerate_report", label: "重新生成报告", owner: "system", enabled: true };
  }
  if (phase === "REVIEW_PENDING") {
    const missing = [report.audit === "missing" ? "audit" : "", report.legal === "missing" ? "legal" : ""].filter(Boolean);
    if (missing.length) return { id: "request_review", label: "发起" + (missing.includes("audit") ? "审计" : "") + (missing.includes("legal") ? "法务" : "") + "复核", owner: "human", enabled: true, services: missing };
    return { id: "wait_review", label: "等待审计/法务复核", owner: "system", enabled: false };
  }
  if (phase === "REVIEW_FAILED") return { id: "fix_review", label: "处理复核意见", owner: "human", enabled: true };
  if (phase === "READY_TO_SIGN") return { id: "sign_report", label: "去签发", owner: "human", enabled: true };
  if (phase === "SIGNED") return { id: "verify_report", label: "校验报告", owner: "human", enabled: true };
  if (allWorkDone) return { id: "generate_report", label: "生成最终报告", owner: "system", enabled: true };
  if (works.some(w => w.state === "failed" || w.state === "cancelled")) return { id: "continue_execution", label: "继续执行", owner: "system", enabled: true };
  return { id: "wait", label: "等待执行", owner: "system", enabled: false };
}

function buildInbox(phase, input) {
  const { plans, works, needs, report, evidence, claims, briefs } = input;
  const inbox = [];
  (needs || []).filter(n => n.status === "pending" || n.status === "partial").forEach(n => {
    inbox.push({ id: "need:" + n.id, type: "data_gap", severity: n.blocking ? "high" : "warn",
      title: (n.title || "待补数据") + (n.status === "partial" ? "（部分补齐）" : ""),
      action: "fill_data", ref: n.id });
  });
  (plans || []).filter(p => p.status === "pending").forEach(p => {
    inbox.push({ id: "plan:" + p.id, type: "plan", severity: "warn",
      title: "计划待批准：" + (p.agent || "") + " · " + (p.goal || "").slice(0, 60), action: "approve_plan", ref: p.id });
  });
  (works || []).filter(w => w.state === "failed" || w.state === "cancelled").forEach(w => {
    inbox.push({ id: "work:" + w.id, type: "work", severity: "high",
      title: "中断节点：" + (w.id || "") + " " + (w.name || w.nodeId || ""), action: "continue_execution", ref: w.id });
  });
  if (phase === "DRAFT_READY") inbox.push({ id: "report:missing", type: "report", severity: "info",
    title: "初稿已完成，待生成最终报告", action: "generate_report" });
  if (report.exists && report.stale) inbox.push({ id: "report:stale", type: "report", severity: "high",
    title: "报告已过期，需要重新生成", action: "regenerate_report",
    detail: (report.staleReasons || []).slice(0, 3).join("；") });
  if (input.crossReview && input.crossReview.high > 0 && !input.crossReview.waived) inbox.push({
    id: "review:cross:high", type: "cross_review", severity: "high",
    title: "交叉复核 high " + input.crossReview.high + " 项", action: "fix_cross_review",
    detail: (input.crossReview.issues || []).slice(0, 3).map(x => x.message || x.type || "").join("；")
  });
  if (report.exists && report.audit === "missing") inbox.push({ id: "review:audit:missing", type: "review", severity: "warn",
    title: "尚未发起审计复核", action: "request_review", ref: "audit" });
  if (report.exists && report.legal === "missing") inbox.push({ id: "review:legal:missing", type: "review", severity: "warn",
    title: "尚未发起法务复核", action: "request_review", ref: "legal" });
  if (report.exists && (report.audit === "returned" || report.audit === "conditional")) inbox.push({ id: "review:audit", type: "review", severity: "high",
    title: "审计复核未通过", action: "fix_review", ref: "audit" });
  if (report.exists && (report.legal === "returned" || report.legal === "conditional")) inbox.push({ id: "review:legal", type: "review", severity: "high",
    title: "法务复核未通过", action: "fix_review", ref: "legal" });
  if (evidence.conflict) inbox.push({ id: "evidence:conflict", type: "evidence", severity: "high",
    title: "证据冲突 " + evidence.conflict + " 条", action: "inspect_evidence" });
  if (claims.unmapped) inbox.push({ id: "claims:unmapped", type: "claim", severity: "warn",
    title: "未映射证据的 claim " + claims.unmapped + " 条", action: "inspect_claims" });
  (briefs.items || []).filter(b => b.status !== "complete").forEach(b => inbox.push({ id: "brief:" + b.agent, type: "brief", severity: "warn",
    title: b.agent + " brief " + (b.status === "missing" ? "缺失" : "不完整"), action: "inspect_brief", ref: b.agent }));
  return inbox.slice(0, 30);
}

function buildCaseView(opts) {
  const caseId = opts.caseId;
  const root = opts.root || ROOT;
  const caseDir = path.join(root, "vault", caseId);
  const evidence = evidenceSummary(caseDir);
  const claims = claimSummary(caseDir);
  const briefs = briefSummary(caseDir);
  const report = reportSummary(caseDir, opts.reviews, opts.signatures, opts.finalExists);
  report.stale = !!opts.reportStale;
  report.staleReasons = opts.staleReasons || [];
  const crossReview = { high: Number(opts.crossReviewHigh) || 0, issues: opts.crossReviewIssues || [],
    waived: !!opts.crossReviewWaived };
  const input = { plans: opts.plans || [], works: opts.works || [], needs: opts.needs || [],
    report, evidence, claims, briefs, crossReview };
  const phase = derivePhase(input);
  const action = nextAction(phase, input);
  const inbox = buildInbox(phase, input);
  const quality = {
    evidence: { total: evidence.total, verified: evidence.verified, unverified: evidence.unverified, conflict: evidence.conflict, stale: evidence.stale },
    claims: { total: claims.total, mapped: claims.mapped, unmapped: claims.unmapped },
    briefs: { total: briefs.total, complete: briefs.complete },
    gaps: {
      open: (opts.needs || []).filter(n => n.status === "pending").length,
      partial: (opts.needs || []).filter(n => n.status === "partial").length,
      waived: (opts.needs || []).filter(n => n.status === "waived").length,
      items: (opts.needs || []).map(n => ({
        id: n.id, title: n.title || "", status: n.status || "",
        kind: n.kind || "", blocking: n.blocking !== false,
        provided: n.providedCount || 0, total: n.totalCount || 0,
        reason: n.waiveReason || n.answer || ""
      })).slice(-50)
    },
    report: { exists: report.exists, audit: report.audit, legal: report.legal, stale: report.stale, signed: report.signed },
    crossReview: { high: (input.crossReview && input.crossReview.high) || 0,
      waived: !!(input.crossReview && input.crossReview.waived),
      issues: (input.crossReview && input.crossReview.issues) || [] }
  };
  return { case: caseId, revision: opts.revision || 0, phase, phaseLabel: PHASE_LABEL[phase] || phase,
    stage: USER_STAGE[phase] || phase, stageLabel: USER_STAGE[phase] || phase,
    primaryAction: action, blocking: inbox.filter(x => x.severity === "high"), inbox, quality,
    updatedAt: new Date().toISOString() };
}

function knowledgeView(caseId, root) {
  const dir = path.join(root || ROOT, "vault", caseId);
  const ev = evidenceSummary(dir);
  const raw = readJsonl(path.join(dir, "evidence", "sources.jsonl"));
  const byId = {};
  raw.forEach(x => { byId[String(x.id || "")] = x; });
  const entries = ev.items.map(x => {
    const r = byId[x.id] || {};
    const verified = x.status === "verified";
    return { id: x.id, type: "evidence", title: x.field || "", value: String(r.value || "").slice(0, 500),
      source: r.url || (r.raw ? "local-cache" : ""), dataAsOf: r.fetched_at || "", status: x.status,
      scope: "case_only", sensitivity: "internal", license: "existing_source",
      allowedUses: verified ? ["analysis", "report_citation"] : ["analysis"],
      evidenceIds: [x.id] };
  });
  const cl = claimSummary(dir);
  cl.items.forEach(x => entries.push({ id: x.id, type: "claim", title: x.text,
    value: x.text, source: (x.refs || []).join(","), dataAsOf: "", status: x.mapped ? "mapped" : "unmapped",
    scope: "case_only", sensitivity: "internal", license: "existing_source",
    allowedUses: x.mapped ? ["analysis", "report_citation"] : ["analysis"], evidenceIds: x.refs || [] }));
  return { ok: true, case: caseId, entries, counts: { total: entries.length,
    verified: entries.filter(x => x.status === "verified").length,
    claimMapped: entries.filter(x => x.type === "claim" && x.status === "mapped").length } };
}
module.exports = { buildCaseView, evidenceSummary, claimSummary, briefSummary, reportSummary, derivePhase, knowledgeView, PHASE_LABEL };
