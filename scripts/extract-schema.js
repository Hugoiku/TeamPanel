"use strict";
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,"..");
const arg=(n,d)=>{const i=process.argv.indexOf("--"+n);return i>=0?process.argv[i+1]:d;};
const url=arg("url",""),field=arg("field",""),id=arg("source","");
if(!/^https?:\/\//.test(url)){console.log(JSON.stringify({ok:false,error:"url required"}));process.exit(2);}
let schema=null;
try{const dir=path.join(ROOT,"config/sources");for(const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json"))){const j=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));if((id&&j.id===id)||(j.url===url)){schema=j.schema||null;break;}}}catch(e){}
const r=spawnSync(process.execPath,[path.join(ROOT,"scripts/url_preview.js"),"--url",url,"--field",field],{cwd:ROOT,encoding:"utf8",timeout:60000,maxBuffer:16*1024*1024});
let pj=null;try{pj=JSON.parse(String(r.stdout||"").trim().split(String.fromCharCode(10)).pop());}catch(e){}
if(!pj||pj.ok===false){console.log(JSON.stringify({ok:false,error:(pj&&pj.error)||String(r.stderr||"").slice(0,300)}));process.exit(3);}
const cand=(pj.candidates||[]).filter(x=>!field||String(x.field||"").toLowerCase().indexOf(field.toLowerCase())>=0);
const hit=cand[0]||(pj.candidates||[])[0]||null;
console.log(JSON.stringify({ok:!!hit,url,field,value:hit?hit.value:null,source:schema?"schema":"preview",schema,candidates:(pj.candidates||[]).slice(0,10)}));
