#!/usr/bin/env node
"use strict";
// macro_report — 把 research/macro.md 装配成 reports/macro-report.md
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,"..");
const CASE=process.env.DESK_CASE||require("path").basename(process.cwd());
function desk(args){const r=spawnSync(process.execPath,[path.join(ROOT,"scripts/desk")].concat(args),{cwd:ROOT,encoding:"utf8",env:process.env});const lines=String(r.stdout||"").trim().split("\n").filter(Boolean);for(let i=lines.length-1;i>=0;i--){try{return JSON.parse(lines[i])}catch(e){}}return{ok:false,error:String(r.stderr||"").slice(0,300)};}
const src=path.join(ROOT,"vault",CASE,"research/macro.md");
if(!fs.existsSync(src)){console.log(JSON.stringify({ok:false,error:"macro.md 不存在"}));process.exit(2)}
let md=fs.readFileSync(src,"utf8");
const evPath=path.join(ROOT,"vault",CASE,"evidence/sources.jsonl");
let evs=[];
try{evs=fs.readFileSync(evPath,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse)}catch(e){}
const titleMatch=md.match(/^#\s+(.+)$/m); const title=titleMatch?titleMatch[1]:"宏观底稿";
let partials=[];
try {
  const lines=fs.readFileSync(path.join(ROOT,"runtime/ledger/events.jsonl"),"utf8").split(String.fromCharCode(10)).filter(Boolean);
  const seen={};
  lines.forEach(line=>{ try { const e=JSON.parse(line); if(e.case===CASE && e.type==="work.finished" && e.partial) seen[e.workId]=e; } catch(x){} });
  partials=Object.keys(seen).map(k=>seen[k]);
} catch(e) {}
const out=["# "+title.replace(/^.*?v\d+\s*/,"").trim()+" · 宏观研究分析报告","",
  "- 装配来源：research/macro.md","- 证据池：evidence/sources.jsonl（"+evs.length+" 条）","- 说明：本报告仅覆盖宏观视角，不含行业供需、个股估值与目标价。","",md.trim(),""];
let childSummaries=[];
try {
  const wroot=path.join(ROOT,"runtime/work");
  fs.readdirSync(wroot).forEach(id=>{
    const cj=path.join(wroot,id,"case.json");
    if(!fs.existsSync(cj))return;
    try { if(JSON.parse(fs.readFileSync(cj,"utf8")).case!==CASE)return; } catch(e){return}
    const sp=path.join(wroot,id,"children.summary.md");
    if(fs.existsSync(sp)) childSummaries.push({id,text:fs.readFileSync(sp,"utf8").trim()});
  });
} catch(e) {}
if (partials.length) {
  out.push("## 附录：部分完成说明","");
  partials.forEach(p=>out.push("- "+(p.nodeId||p.workId)+"：部分完成；"+(p.error||"该节点未完全达到要求，相关结论置信度下降。")));
  out.push("");
}
let fanoutReports=[];
try {
  const rd=fs.readdirSync(path.join(ROOT,"vault",CASE,"reports"));
  const chosen={};
  rd.filter(n=>/^fanout-.*\.md$/.test(n)).forEach(n=>{
    const isLead=/-lead\.md$/.test(n);
    const id=n.replace(/^fanout-/,"").replace(/-lead\.md$/,"").replace(/\.md$/,"");
    if (!chosen[id] || isLead) chosen[id]={id,lead:isLead,name:n,
      text:fs.readFileSync(path.join(ROOT,"vault",CASE,"reports",n),"utf8").trim()};
  });
  fanoutReports=Object.keys(chosen).map(k=>chosen[k]);
} catch(e) {}
if (fanoutReports.length) {
  out.push("## 附录：并行研究汇总","");
  fanoutReports.forEach(x=>out.push(x.text,""));
}
if (childSummaries.length) {
  out.push("## 附录：并行子任务汇总","");
  childSummaries.forEach(x=>out.push("### "+x.id,"",x.text,""));
}
out.push("## 附录：证据索引","");
evs.forEach(e=>out.push("- "+e.id+"｜"+String(e.field||"").slice(0,80)+"｜"+String(e.url||"").slice(0,120)));
const body=out.join("\n")+"\n";
const rel="reports/macro-report.md";
const acq=desk(["acquire","--case",CASE,"--path",rel,"--mode","write","--wait","20"]);
if(!acq.ok){console.log(JSON.stringify({ok:false,error:acq.error||"取锁失败"}));process.exit(3)}
const lock=acq.lock&&acq.lock.id;
const pk=desk(["peek","--case",CASE,"--path",rel]);
const ver=(pk&&pk.version)||0;
const tmp=path.join(ROOT,"runtime/cache/collect/macro-report-"+Date.now()+".md");fs.writeFileSync(tmp,body);
const wr=desk(["write","--case",CASE,"--path",rel,"--lock",lock,"--expected-version",String(ver),"--file",tmp]);
desk(["release","--lock",lock]);
let docx="";
try{
  const py=spawnSync(process.env.PYTHON||"python3",[path.join(ROOT,"scripts/build_macro_report.py")],
    {cwd:ROOT,encoding:"utf8",env:Object.assign({},process.env,{PYTHONPATH:path.join(ROOT,"runtime/py"),DESK_CASE:CASE})});
  const lines=String(py.stdout||"").trim().split("\n").filter(Boolean);
  const j=JSON.parse(lines[lines.length-1]||"{}");
  if(j.ok) docx=j.out;
}catch(e){}
console.log(JSON.stringify({ok:wr.ok,out:rel,docx,version:wr.version||ver+1,error:wr.error||""}));
