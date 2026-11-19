#!/usr/bin/env node
/* 构建脚本：把 sim.js 内联进 template.html，产出单文件 mockup.html（双击即可打开，无需服务器） */
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const sim = fs.readFileSync(path.join(dir, 'sim.js'), 'utf8');
const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
if (!tpl.includes('/*__SIM__*/')) throw new Error('template.html 缺少 /*__SIM__*/ 占位符');
if (sim.includes('</scr' + 'ipt')) throw new Error('sim.js 中不能出现 script 结束标签');
const out = tpl.replace('/*__SIM__*/', sim);
fs.writeFileSync(path.join(dir, 'mockup.html'), out, 'utf8');
console.log('mockup.html 已生成 ·', out.length, 'bytes');
