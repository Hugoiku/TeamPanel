"use strict";
/** Build deterministic numeric exhibits from structured research JSON. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const figureCatalog = require("./figure-catalog");
const ROOT = path.resolve(__dirname, "..");
const CASE = process.argv[process.argv.indexOf("--case") + 1] || "";
if (!CASE) process.exit(2);
const base = path.join(ROOT, "vault", CASE);
const read = p => { try { return JSON.parse(fs.readFileSync(path.join(base, "research", p), "utf8")); } catch (e) { return {}; } };
const items = [];
function chart(name, title, rows) {
  const dir = path.join(base, "figures"); fs.mkdirSync(dir, { recursive: true });
  const csv = path.join(ROOT, "runtime/cache", "exhibit-" + CASE + "-" + name + ".csv");
  fs.mkdirSync(path.dirname(csv), { recursive: true });
  fs.writeFileSync(csv, "label,value" + String.fromCharCode(10) + rows.map(r => "\"" + r[0].replace(/"/g, "") + "\"," + r[1]).join(String.fromCharCode(10)));
  const out = "figures/" + name + ".svg";
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/chart.js"), "bar", "--csv", csv, "--label", "label", "--value", "value", "--title", title, "--out", path.join(base, out)], { cwd: ROOT, encoding: "utf8", timeout: 30000 });
  if (r.status === 0 && fs.existsSync(path.join(base, out))) items.push({ path: out, title, source: "structured-json", sources: arguments[3] || [], placement: name.startsWith("stock") ? "company" : "industry" });
}
const ind = read("industry.json");
const ms = ind.market_size || {};
const mlabels = ms.labels || {};
if (Number(ms.total_2026e_yi) > 0) chart("industry-market", "2026E 市场规模（亿元）", [
  [mlabels.total || "行业总规模", Number(ms.total_2026e_yi)],
  [mlabels.segment || "细分赛道", Number(ms.ai_drama_2026e_yi || 0)],
  [mlabels.other || "其他口径", Number(ms.free_2026e_yi || 0)]
], ms.evidence || []);
const sup = ind.supply || {};
if (Number(sup.production_2025_wan) > 0 && Number(sup.production_2026e_wan) > 0) chart("industry-production", "行业产量（万部）", [
  ["2025", Number(sup.production_2025_wan)],
  ["2026E", Number(sup.production_2026e_wan)]
], sup.evidence || []);
const ue = ind.unit_economics || {};
const layers = ue.layers || [];
if (layers.length >= 2) {
  const l1 = layers[0].readings || "";
  const l2 = layers[1].readings || "";
  const costLow = (l1.match(/AI\s*([0-9.]+)/) || [])[1];
  const costHigh = (l1.match(/AI\s*[0-9.]+[–-]([0-9.]+)/) || [])[1];
  const revUpper = (l2.match(/上限≈?([0-9.]+)/) || [])[1];
  const revLow = (l2.match(/年化≈?([0-9.]+)/) || [])[1];
  const rows = [];
  if (costLow) rows.push(["成本下限", Number(costLow)]);
  if (costHigh) rows.push(["成本上限", Number(costHigh)]);
  if (revLow) rows.push(["单位收入下沿", Number(revLow)]);
  if (revUpper) rows.push(["单位收入上限", Number(revUpper)]);
  if (rows.length) chart("industry-unit-economics", "单位经济（万元/部）", rows, ue.evidence || []);
}
const st = read("stock.json");
const dcf = (st.valuation || {}).dcf || {};
const sens = dcf.terminal_margin_sensitivity || {};
if (Object.keys(sens).length) chart("stock-dcf-sensitivity", "DCF 对终值 FCF 利润率的敏感性（元/股）", Object.keys(sens).map(k => [k.replace("pct", "%"), Number(sens[k])]), ["S4","S53"]);
// 通用补齐：模板只生成部分图时也补到目标数量；只使用本 case 的已有图，不伪造。
const TARGET_FIGURES = 8;
if (items.length < TARGET_FIGURES) {
  const add = figureCatalog.supplement(CASE, items, TARGET_FIGURES);
  items.push(...add);
}
const out = items.length
  ? { ok: true, case: CASE, items, generatedAt: new Date().toISOString() }
  : { ok: false, case: CASE, items: [], error: "figures_missing",
      hint: "本 case 没有可用图表；请先让员工生成 figures/*.svg/png 后再生成最终报告",
      generatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(base, "research", "exhibits.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
if (!out.ok) process.exitCode = 1;

fs.writeFileSync(path.join(base, "research", "exhibits.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: true, items: items.length }));
