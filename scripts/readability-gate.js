"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const base=path.join(ROOT,"vault",CASE,"research");
let md="";try{md=fs.readFileSync(path.join(ROOT,"vault",CASE,"reports","investor-final.md"),"utf8");}catch(e){}
const bad=[];
[["本轮修订","内部修订记录"],["本版","内部版本说明"],["R1","内部任务编号"],["门禁","内部流程词"],["token","内部计量词"],["manifest","内部文件词"]].forEach(([k,n])=>{if(md.includes(k))bad.push(n);});
if(!/##\s*[一二三四五六七八九十]+、(投资摘要|投资结论)/.test(md))bad.push("缺投资结论");
if((md.match(/!\[/g)||[]).length<1)bad.push("缺图表");
if(md.length<1200)bad.push("正文过短");
if((md.match(/!\[/g)||[]).length<1)bad.push("无图表引用");
const out={ok:bad.length===0,case:CASE,chars:md.length,figures:(md.match(/!\[/g)||[]).length,bad,generatedAt:new Date().toISOString()};
fs.writeFileSync(path.join(base,"readability.json"),JSON.stringify(out,null,2));
console.log(JSON.stringify(out));
