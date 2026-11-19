#!/usr/bin/env node
"use strict";
// 共享总报告：章节文件 reports/sections/<role>.md -> reports/master.md
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,"..");
const CASE=process.env.DESK_CASE||"";
const ROLES=[["macro","宏观研究"],["industry","行业研究"],["stock","个股研究"]];
function desk(args){const r=spawnSync(process.execPath,[path.join(ROOT,"scripts/desk")].concat(args),{cwd:ROOT,encoding:"utf8",env:Object.assign({},process.env,{DESK_CASE:CASE})});const lines=String(r.stdout||"").trim().split(String.fromCharCode(10)).filter(Boolean);for(let i=lines.length-1;i>=0;i--){try{return JSON.parse(lines[i])}catch(e){}}return{ok:false,error:String(r.stderr||"").slice(0,300)};}
function read(p){try{return fs.readFileSync(p,"utf8")}catch(e){return""}}
function body(md){const nl=String.fromCharCode(10);const lines=String(md||"").split(nl);if(lines[0]&&lines[0][0]==="#")lines.shift();if(lines[0]&&lines[0][0]===">")lines.shift();return lines.join(nl).trim();}
function initSections(){
  const dir=path.join(ROOT,"vault",CASE,"reports","sections");fs.mkdirSync(dir,{recursive:true});
  const nl=String.fromCharCode(10);
  const force=process.argv.indexOf("--refresh")>=0;
  for(const [role,label] of ROLES){
    const dst=path.join(dir,role+".md");if(fs.existsSync(dst)&&!force)continue;
    const src=path.join(ROOT,"vault",CASE,"research",role+".md");
    const txt=fs.existsSync(src)?body(read(src)):"（"+label+"章节待补）";
    fs.writeFileSync(dst,"# "+label+nl+nl+txt+nl);
    console.log("init",path.relative(ROOT,dst));
  }
}
function assemble(){
  const parts=["# 共享研究报告","","> 本文件由 reports/sections/*.md 装配生成，不要直接编辑；各角色编辑自己的章节文件。","","> 生成时间："+new Date().toISOString(),""];
  for(const [role,label] of ROLES){
    const p=path.join(ROOT,"vault",CASE,"reports","sections",role+".md");
    parts.push("## "+label, "", body(read(p))||"（待补）", "");
  }
  parts.push("## 装配说明","","- 章节文件：reports/sections/macro.md / industry.md / stock.md","- 总报告：只读汇总；跨章节修改需申请 master 写锁","- 每次装配使用最新版本，冲突由 desk expected-version 拦截");
  const rel="reports/master.md", acq=desk(["acquire","--case",CASE,"--path",rel,"--mode","write","--wait","20"]);
  if(!acq.ok){console.error(JSON.stringify({ok:false,error:acq.error||"lock failed"}));process.exit(3)}
  const lock=acq.lock&&acq.lock.id, tmp=path.join(ROOT,"runtime/cache/master-report-"+Date.now()+".md");
  fs.writeFileSync(tmp,parts.join(String.fromCharCode(10))+String.fromCharCode(10));
  // master.md 只由本脚本在持锁期间写；不再用可能读空的 peek 版本做 CAS，避免 expected 0/actual 1。
  const wr=desk(["write","--case",CASE,"--path",rel,"--lock",lock,"--file",tmp]);
  desk(["release","--lock",lock]);
  console.log(JSON.stringify({ok:wr.ok,out:rel,version:wr.version||ver+1,error:wr.error||""}));
}
if(process.argv.indexOf("--init")>=0) initSections();
assemble();
