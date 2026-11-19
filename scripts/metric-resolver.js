#!/usr/bin/env node
"use strict";
/**
 * metric-resolver — 确定性指标匹配（显式 ID / 精确别名 / 受控前缀）
 * 不做无约束模糊打分；语义解析层后续接入。
 */
function norm(s) {
  return String(s || "").toLowerCase()
    .replace(/[（(]/g, "").replace(/[）)]/g, "")
    .replace(/\s+/g, "").replace(/[，。；、：:,.\-_/]/g, "");
}
function unitOf(s) { return String(s || "").trim().toLowerCase(); }
function unitCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  const pct = ["%", "百分比", "percent"];
  const bp = ["bp", "基点"];
  if (pct.indexOf(a) >= 0 && pct.indexOf(b) >= 0) return true;
  if (bp.indexOf(a) >= 0 && bp.indexOf(b) >= 0) return true;
  // 复合单位（如 亿元/%）只要有一个分量兼容即视为可映射；最终口径由定义/存量增量门禁继续校验。
  const as = String(a).split(/[\/|、]/).map(x => x.trim()).filter(Boolean);
  const bs = String(b).split(/[\/|、]/).map(x => x.trim()).filter(Boolean);
  for (const x of as) for (const y of bs) {
    if (x === y) return true;
    if (pct.indexOf(x) >= 0 && pct.indexOf(y) >= 0) return true;
    if (bp.indexOf(x) >= 0 && bp.indexOf(y) >= 0) return true;
  }
  return false;
}
function freqOf(s) {
  const x = String(s || "").toLowerCase();
  if (/日|daily/.test(x)) return "daily";
  if (/月|monthly/.test(x)) return "monthly";
  if (/季|quarter/.test(x)) return "quarterly";
  if (/年|annual|yearly/.test(x)) return "yearly";
  return "";
}
function flowOf(text) {
  const x = String(text || "");
  if (/存量|余额|规模存量/.test(x)) return "stock";
  if (/增量|当月|新增|累计/.test(x)) return "flow";
  return "";
}
function compatibility(metric, item) {
  const reasons = [];
  const mu = unitOf(metric.unit), iu = unitOf(item.unit);
  if (mu && iu && !unitCompatible(mu, iu)) reasons.push("单位不兼容：" + mu + " vs " + iu);
  const mf = freqOf(metric.frequency), iff = freqOf(item.frequency);
  if (mf && iff && mf !== iff) reasons.push("频率不兼容：" + mf + " vs " + iff);
  const mflow = metric.stockFlow || "";
  const iflow = flowOf((item.indicator || "") + " " + (item.definition || ""));
  if (mflow && iflow && mflow !== iflow) reasons.push("存量/增量不兼容：" + mflow + " vs " + iflow);
  return reasons;
}
function resolve(item, metrics) {
  const text = String((item && (item.indicator || item.name)) || "").trim();
  const list = Array.isArray(metrics) ? metrics : [];
  if (item && item.metricId) {
    const m = list.find(x => x.id === item.metricId);
    if (m) {
      if (m.status === "draft") return { state: "draft", metricId: m.id, method: "explicit",
        confidence: 1, reasons: ["metric 仍是 draft，需补定义/来源"], text };
      const reasons = compatibility(m, item);
      return { state: reasons.length ? "candidate_pending" : "confirmed", metricId: m.id,
        method: "explicit", confidence: 1, reasons, text };
    }
  }
  const nt = norm(text);
  if (!nt) return { state: "draft", method: "none", reasons: ["空指标文本"], text };
  let best = null, bestLen = 0;
  for (const m of list) {
    const names = [m.name].concat(m.aliases || []);
    for (const n of names) {
      const nn = norm(n);
      if (!nn) continue;
      if (nt === nn && nn.length > bestLen) { best = m; bestLen = nn.length; }
    }
  }
  if (best) {
    if (best.status === "draft") return { state: "draft", metricId: best.id, method: "alias",
      confidence: 0.8, reasons: ["metric 仍是 draft，需补定义/来源"], text };
    const reasons = compatibility(best, item);
    return { state: reasons.length ? "candidate_pending" : "confirmed", metricId: best.id,
      method: "alias", confidence: 0.95, reasons, text };
  }
  // 受控前缀：仅当别名足够长且文本以别名开头；仍要过兼容门禁。
  for (const m of list) {
    const names = [m.name].concat(m.aliases || []);
    for (const n of names) {
      const nn = norm(n);
      if (nn.length < 4) continue;
      if (nt.indexOf(nn) === 0 && nn.length > bestLen) { best = m; bestLen = nn.length; }
    }
  }
  if (best) {
    if (best.status === "draft") return { state: "draft", metricId: best.id, method: "alias_prefix",
      confidence: 0.7, reasons: ["metric 仍是 draft，需补定义/来源"], text };
    const reasons = compatibility(best, item);
    return { state: reasons.length ? "candidate_pending" : "confirmed", metricId: best.id,
      method: "alias_prefix", confidence: 0.8, reasons, text };
  }
  return { state: "draft", method: "none", reasons: ["无匹配 metric"], text };
}
module.exports = { norm, resolve, compatibility, flowOf, freqOf, unitCompatible };
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.resolve(__dirname, "..");
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "config/data/metrics.json"), "utf8"));
  const item = { indicator: process.argv[2] || "", unit: process.argv[3] || "", frequency: process.argv[4] || "" };
  console.log(JSON.stringify(resolve(item, j.metrics || []), null, 2));
}
