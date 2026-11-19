#!/usr/bin/env node
"use strict";
/** formalize-report: 生成正式报告底稿；不展示缺失/待补清单。 */
const fs = require("fs");
const path = require("path");
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 ? process.argv[i + 1] : d; }
function flag(k) { return process.argv.indexOf("--" + k) >= 0; }
const src = arg("md", ""), dst = arg("out", "");
if (!src || !dst) { console.error("--md --out required"); process.exit(2); }
let text = "";
try { text = fs.readFileSync(src, "utf8"); } catch (e) { console.error("md not found"); process.exit(2); }
const gapWord = /(待补|缺失|未取得|无数据|无可用|未找到|数据不足|待验证|未披露|没有数据)/;
const gapHeading = /(数据缺口|缺口与|缺口清单|待补|待验证|本稿边界|数据边界|局限与边界)/;
const lines = text.split(String.fromCharCode(10));
const out = [];
let skipping = false, skipLevel = 0;
for (const line of lines) {
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h[1].length;
    if (skipping) {
      if (level <= skipLevel) skipping = false;
      else continue;
    }
    if (gapHeading.test(h[2])) { skipping = true; skipLevel = level; continue; }
    out.push(line); continue;
  }
  if (skipping) continue;
  if (gapWord.test(line)) {
    // 表格行/列表项直接丢弃；段落中的缺失句剥离
    if (/^\s*[|\-*]/.test(line)) continue;
    const cleaned = line
      .replace(/[^。；\n]*(待补|缺失|未取得|无数据|无可用|未找到|数据不足|待验证|未披露)[^。；\n]*[。；]?/g, "")
      .replace(/\s{2,}/g, " ").trim();
    if (cleaned && cleaned.length > 8) out.push(cleaned);
    continue;
  }
  out.push(line);
}
let result = out.join(String.fromCharCode(10)).replace(/\n{3,}/g, String.fromCharCode(10) + String.fromCharCode(10));
// 正式稿末尾只保留一句边界说明，不列缺口
result += String.fromCharCode(10) + String.fromCharCode(10) + "> 说明：部分指标受公开数据可得性限制，本报告仅纳入可验证判断。" + String.fromCharCode(10);
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, result);
console.log(JSON.stringify({ ok: true, out: dst, chars: result.length, removed: text.length - result.length }));
