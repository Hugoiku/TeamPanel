#!/usr/bin/env node
"use strict";
/**
 * task-estimator — 计划节点的确定性复杂度/预算估算。
 * 只给建议，不替代人工审批；用于提前发现“太大/太小”的节点。
 */
const TIER_BASE = { fast: 10 * 60 * 1000, strong: 45 * 60 * 1000, verify: 45 * 60 * 1000 };
function estimate(step) {
  const s = step || {};
  const text = [s.name, s.task, (s.outputs || []).join(" "), (s.acceptance || []).join(" ")].join(" ");
  const outputs = Array.isArray(s.outputs) ? s.outputs.length : 0;
  const deps = Array.isArray(s.depends) ? s.depends.length : 0;
  const len = String(text || "").length;
  let score = 0;
  score += Math.min(3, Math.floor(len / 500));
  score += Math.min(3, outputs);
  score += Math.min(2, deps);
  if (/(估值|三情景|目标价|DDM|剩余收益|可比|敏感性)/.test(text)) score += 2;
  if (/(引用|数字一致|交叉校验|核验|审计|法务)/.test(text)) score += 1;
  if (/(全量|所有|逐条|逐年|逐季|多源)/.test(text)) score += 1;
  const tier = ["fast", "strong", "verify"].indexOf(s.tier) >= 0 ? s.tier : "strong";
  const base = TIER_BASE[tier] || TIER_BASE.strong;
  const wallMs = Math.min(90 * 60 * 1000, base + score * 6 * 60 * 1000);
  const tokens = Math.min(400000, 40000 + score * 30000);
  const splitSuggested = score >= 7 || outputs >= 4 || (wallMs >= 75 * 60 * 1000);
  const reasons = [];
  if (len > 1200) reasons.push("任务描述较长");
  if (outputs >= 4) reasons.push("产物数量多");
  if (/(估值|三情景|目标价|DDM|剩余收益|可比)/.test(text)) reasons.push("含估值/情景计算");
  if (/(引用|数字一致|交叉校验|核验)/.test(text)) reasons.push("含校验工作");
  if (splitSuggested) reasons.push("建议拆分或提高预算");
  return { complexity: score, tier, wallMs, tokens, splitSuggested,
    reasons: reasons.length ? reasons : ["规模正常"], outputs, deps };
}
module.exports = { estimate, TIER_BASE };
