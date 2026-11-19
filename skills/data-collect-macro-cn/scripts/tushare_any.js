#!/usr/bin/env node
"use strict";
// tushare_any — 通用 Tushare 查询：--api cn_cpi --params '{"start_date":"20260101"}'
const https=require("https"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,"..");
function arg(n,d){const i=process.argv.indexOf("--"+n);return i>=0?process.argv[i+1]:d;}
function token(){return JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/secrets/tushare.json"),"utf8")).token;}
function post(body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=https.request({hostname:"api.tushare.pro",path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},x=>{let s="";x.on("data",d=>s+=d);x.on("end",()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})});r.on("error",rej);r.write(data);r.end();});}
(async()=>{const api=arg("api","cn_cpi");let params={};try{params=JSON.parse(arg("params","{}"))}catch(e){console.log(JSON.stringify({ok:false,error:"params JSON 解析失败"}));process.exit(2)}const fields=arg("fields","");const j=await post({api_name:api,token:token(),params,fields});if(j.code!==0){console.log(JSON.stringify({ok:false,api,error:j.msg,code:j.code}));process.exit(3)}console.log(JSON.stringify({ok:true,api,fields:(j.data&&j.data.fields)||[],items:(j.data&&j.data.items)||[]},null,2));})().catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(1)});
