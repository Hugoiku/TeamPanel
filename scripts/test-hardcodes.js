#!/usr/bin/env node
"use strict";
/** 防止把案例/旧 artifact 写回 live Panel。 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "dashboard/template.html"), "utf8");
const broker = fs.readFileSync(path.join(ROOT, "runtime/server/broker.js"), "utf8");
assert(!html.includes("AI短剧"), "template 不应包含旧案例 AI短剧");
assert(!html.includes("case-2026-001"), "template 不应回退到固定 demo case");
assert(!html.includes("MODEL_OPTS"), "模板不应写死模型目录");
assert(!broker.includes('"reports/final-report.docx"'), "broker 应使用 FINAL_REPORT 常量");
const legacy = (html.match(/final_report\.md/g) || []).length;
assert(legacy <= 2, "final_report.md 只应保留 legacy 常量/注释，当前 " + legacy);
console.log("ALL PASS test-hardcodes");
