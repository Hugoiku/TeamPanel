#!/usr/bin/env node
"use strict";
const { classify } = require("./intent");
const cases = [
  ["怎么还没完成", "question"],
  ["还需要什么数据", "question"],
  ["请帮我看看还需要什么数据", "question"],
  ["缺什么数据", "question"],
  ["这个数据和底稿冲突吗", "question"],
  ["研究国际流动性是否紧张", "question"],
  ["请补充出口数据", "task"],
  ["把锗出口数据补一下", "task"],
  ["更新任务，把模型换成 flash", "task"],
  ["帮我写一份300字摘要", "task"],
  ["请重跑S5", "task"],
  ["好的，继续", "ack"],
  ["为什么出口下滑，顺便补充数据", "mixed"]
];
let pass = 0, fail = 0;
for (const [text, want] of cases) {
  const got = classify(text).kind;
  if (got === want) { pass++; console.log("  ✓", text, "→", got); }
  else { fail++; console.log("  ✗", text, "→", got, "期望", want); }
}
console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
