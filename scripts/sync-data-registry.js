"use strict";
const fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,"..");
const srcDir=path.join(ROOT,"config/sources"), regPath=path.join(ROOT,"config/data/sources.json"), metPath=path.join(ROOT,"config/data/metrics.json");
let reg={version:1,sources:[]};try{reg=JSON.parse(fs.readFileSync(regPath,"utf8"));}catch(e){}
let met={version:1,metrics:[]};try{met=JSON.parse(fs.readFileSync(metPath,"utf8"));}catch(e){}
const configs=[];
try{fs.readdirSync(srcDir).filter(f=>f.endsWith(".json")).forEach(f=>{try{const j=JSON.parse(fs.readFileSync(path.join(srcDir,f),"utf8"));if(j&&j.id)configs.push(j);}catch(e){}});}catch(e){}
const byId=new Map((reg.sources||[]).map(x=>[x.id,x]));const added=[];
configs.forEach(c=>{if(!byId.has(c.id)){byId.set(c.id,{id:c.id,name:c.name||c.id,configSource:c.id,capabilities:["custom"],formats:[c.kind||"html"],auth:"none",priority:3,status:c.status||"active"});added.push(c.id);}else{const x=byId.get(c.id);x.name=x.name||c.name;x.configSource=c.id;x.formats=[c.kind||x.formats&&x.formats[0]||"html"];}});
reg.sources=Array.from(byId.values());
const known=new Set(reg.sources.map(x=>x.id));const invalid=[];
(met.metrics||[]).forEach(m=>{m.sources=(m.sources||[]).filter(s=>known.has(s));if(!m.sources.length)invalid.push(m.id);});
fs.writeFileSync(regPath,JSON.stringify(reg,null,2)+String.fromCharCode(10));fs.writeFileSync(metPath,JSON.stringify(met,null,2)+String.fromCharCode(10));
console.log(JSON.stringify({ok:true,configs:configs.length,sources:reg.sources.length,added,metricsWithoutSource:invalid}));
