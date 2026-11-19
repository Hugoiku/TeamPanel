"use strict";
const https=require("https"),fs=require("fs"),path=require("path");
const ROOT=path.resolve(__dirname,".."),CASE=process.argv[process.argv.indexOf("--case")+1]||"";
if(!CASE)process.exit(2);
const vault=path.join(ROOT,"vault",CASE);
function token(){try{return JSON.parse(fs.readFileSync(path.join(ROOT,"runtime/secrets/tushare.json"),"utf8")).token;}catch(e){return "";}}
function post(body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=https.request({hostname:"api.tushare.pro",path:"/",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(data)}},x=>{let s="";x.on("data",d=>s+=d);x.on("end",()=>{try{res(JSON.parse(s))}catch(e){rej(e)}})});r.on("error",rej);r.write(data);r.end();});}
async function fetchClass(level){const j=await post({api_name:"index_classify",token:token(),params:{level,src:"SW2021"},fields:"index_code,industry_name,level,industry_code,is_pub,parent_code"});if(j.code!==0)throw new Error(j.msg||"index_classify failed");const f=(j.data&&j.data.fields)||[],it=(j.data&&j.data.items)||[];return it.map(row=>{const o={};f.forEach((k,i)=>o[k]=row[i]);return o;});}
async function fetchMembers(code,key){const j=await post({api_name:"index_member_all",token:token(),params:{[key]:code},fields:"l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,ts_code,name,in_date,out_date,is_new"});if(j.code!==0)return [];const f=(j.data&&j.data.fields)||[],it=(j.data&&j.data.items)||[];return it.map(row=>{const o={};f.forEach((k,i)=>o[k]=row[i]);return o;});}
(async()=>{
  let pack={};try{pack=JSON.parse(fs.readFileSync(path.join(vault,"research/sector-pack.json"),"utf8"));}catch(e){}
  const l1=await fetchClass("L1"),l2=await fetchClass("L2"),l3=await fetchClass("L3");
  const tree={source:"tushare",src:"SW2021",fetchedAt:new Date().toISOString(),l1,l2,l3};
  const l1Names=new Set(pack.tushareL1||[]); const l2Names=new Set(pack.tushareL2||[]); const l3Names=new Set(pack.tushareL3||[]);
  const l1Rows=l1.filter(x=>l1Names.has(x.industry_name));
  const l2Rows=l2.filter(x=>l1Rows.some(a=>a.industry_code===x.parent_code) && (!l2Names.size||l2Names.has(x.industry_name)));
  const l3Rows=l3.filter(x=>l2Rows.some(a=>a.industry_code===x.parent_code) && (!l3Names.size||l3Names.has(x.industry_name)));
  let peers=[]; const seen=new Set();
  const targetCodes = l3Rows.length?l3Rows.map(x=>[x.index_code,"l3_code"]):(l2Rows.length?l2Rows.map(x=>[x.index_code,"l2_code"]):l1Rows.map(x=>[x.index_code,"l1_code"]));
  for(const [code,key] of targetCodes){const rows=await fetchMembers(code,key);rows.forEach(r=>{if(seen.has(r.ts_code))return;seen.add(r.ts_code);peers.push(r);});}
  const out={case:CASE,sectorPack:pack.id,label:pack.label,l1:l1Rows.map(x=>({code:x.index_code,name:x.industry_name})),l2:l2Rows.map(x=>({code:x.index_code,name:x.industry_name})),l3:l3Rows.map(x=>({code:x.index_code,name:x.industry_name})),peers:peers.slice(0,300),counts:{l1:l1Rows.length,l2:l2Rows.length,l3:l3Rows.length,peers:peers.length},fetchedAt:new Date().toISOString()};
  fs.mkdirSync(path.join(vault,"research"),{recursive:true});fs.writeFileSync(path.join(vault,"research","industry-tree.json"),JSON.stringify(tree,null,2));fs.writeFileSync(path.join(vault,"research","peer-universe.json"),JSON.stringify(out,null,2));
  const cache=path.join(ROOT,"runtime/cache/tushare");fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,"industry-tree-SW2021.json"),JSON.stringify(tree,null,2));
  console.log(JSON.stringify({ok:true,l1:out.l1,l2:out.l2,l3:out.l3,counts:out.counts,peers:out.peers.slice(0,12)}));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(1)});
