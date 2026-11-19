"use strict";
const https=require("https"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,"..");
const arg=(n,d)=>{const i=process.argv.indexOf("--"+n);return i>=0?process.argv[i+1]:d;};
function token(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/secrets/tushare.json"),"utf8")).token;}catch(e){return "";}}
function post(body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=https.request({hostname:"api.tushare.pro",path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},x=>{let s="";x.on("data",d=>s+=d);x.on("end",()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})});r.on("error",rej);r.write(data);r.end();});}
(async()=>{
  const src=arg("src","SW2021"), level=arg("level","L1");
  const j=await post({api_name:"index_classify",token:token(),params:{level,src},fields:"index_code,industry_name,level,industry_code,is_pub,parent_code"});
  if(j.code!==0){console.log(JSON.stringify({ok:false,api:"index_classify",code:j.code,error:j.msg}));process.exit(3);}
  const fields=(j.data&&j.data.fields)||[], items=(j.data&&j.data.items)||[];
  const rows=items.map(it=>{const o={};fields.forEach((f,i)=>o[f]=it[i]);return o;});
  const dir=path.join(ROOT,"runtime/cache/tushare");fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"index-classify-"+src+"-"+level+".json"),JSON.stringify({src,level,fetchedAt:new Date().toISOString(),fields,rows},null,2));
  console.log(JSON.stringify({ok:true,src,level,count:rows.length,industries:rows.slice(0,60)}));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(1)});
