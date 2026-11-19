"use strict";
const https=require("https"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE);
function token(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/secrets/tushare.json"),"utf8")).token;}catch(e){return "";}}
function post(body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=https.request({hostname:"api.tushare.pro",path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},x=>{let s="";x.on("data",d=>s+=d);x.on("end",()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})});r.on("error",rej);r.write(data);r.end();});}
(async()=>{
  const uni=JSON.parse(fs.readFileSync(path.join(vault,"research","peer-universe.json"),"utf8"));
  const peers=(uni.peers||[]).slice(0,40),out=[];
  for(const p of peers){try{const j=await post({api_name:"daily_basic",token:token(),params:{ts_code:p.ts_code},fields:"ts_code,trade_date,close,ps_ttm,pe_ttm,total_mv"});if(j.code!==0)continue;const rows=(j.data&&j.data.items)||[];if(!rows.length)continue;const f=j.data.fields,r=rows[0];const o={};f.forEach((k,i)=>o[k]=r[i]);o.name=p.name;o.l3=p.l3_name;out.push(o);}catch(e){}}
  const ps=out.map(x=>Number(x.ps_ttm)).filter(x=>isFinite(x)&&x>0).sort((a,b)=>a-b);
  const median=ps.length?(ps[Math.floor((ps.length-1)/2)]+ps[Math.ceil((ps.length-1)/2)])/2:null;
  const result={case:CASE,count:out.length,medianPs:median,peers:out,fetchedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(vault,"research","peer-multiples.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,count:out.length,medianPs:median,peers:out.slice(0,12)}));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(1)});
