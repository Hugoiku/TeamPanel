"use strict";
const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");
const ROOT=path.resolve(__dirname,"..");
const arg=(n,d)=>{const i=process.argv.indexOf("--"+n);return i>=0?process.argv[i+1]:d;};
const CASE=arg("case",""); const NEED=arg("need",""); const TEXT=arg("text","");
if(!CASE)process.exit(2);
const CFG=(()=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,"config/desk.json"),"utf8"));}catch(e){return{};}})();
const cfg=((CFG.models||{}).planner||{}).default||{provider:"opencode-go",model:"deepseek-v4.1-flash"};
let mission="";try{mission=fs.readFileSync(path.join(ROOT,"vault",CASE,"mission.md"),"utf8").slice(0,3000);}catch(e){}
let need="";try{const n=JSON.parse(fs.readFileSync(path.join(ROOT,"vault",CASE,"research","needs-snapshot.json"),"utf8"));}catch(e){}
const prompt=["你是投研数据源规划器。根据 mission 和待补指标，推荐可公开访问的数据源。","只输出 JSON：{\"sources\":[{\"name\":\"\",\"url\":\"https://\",\"kind\":\"html|pdf|json\",\"frequency\":\"monthly|quarterly|annual|daily\",\"fields\":[\"\"],\"reason\":\"\",\"confidence\":0.0}]}","最多 4 个；优先官方/公司IR/交易所；不要编造不存在的 URL；不确定就少给。","mission：",mission,"待补：",TEXT||NEED].join("\n");
const patch=path.join(ROOT,"runtime/profiles/source-propose.yml");
fs.mkdirSync(path.dirname(patch),{recursive:true});
fs.writeFileSync(patch,["- id: agent-default-model",'  name: "@deepseek-ai/dsh-agent-default-model"',"  config:","    provider: "+cfg.provider,"    model: "+cfg.model,"    reasoningEffort: high","- id: llm-pi-ai",'  name: "@deepseek-ai/dsh-llm-pi-ai"',"  config:","    providers:","      "+cfg.provider+":","        apiKeyEnv: OPENCODE_GO_API_KEY",""].join("\n"));
let key=process.env.OPENCODE_GO_API_KEY||"";try{const m=fs.readFileSync(path.join(process.env.HOME||"",".dsh/.credentials.yaml"),"utf8").match(/OPENCODE_GO_API_KEY:\s*(\S+)/);if(m)key=m[1];}catch(e){}
const dsh=process.env.DSH_BIN||"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const home=path.join(ROOT,"runtime/dsh-home","source-propose");fs.mkdirSync(home,{recursive:true});
const r=spawnSync(dsh,["--patch",patch,"--profile","headless","--json",prompt],{cwd:ROOT,encoding:"utf8",timeout:120000,maxBuffer:16*1024*1024,env:Object.assign({},process.env,{OPENCODE_GO_API_KEY:key,DSH_HOME:home})});
let text="";String(r.stdout||"").split("\n").forEach(l=>{try{const j=JSON.parse(l);if(j.type==="final"&&typeof j.text==="string")text=j.text;}catch(e){}});
const m=text.match(/\{[\s\S]*\}/);let out={ok:false,sources:[]};
try{if(m){const j=JSON.parse(m[0]);out={ok:true,sources:(j.sources||[]).slice(0,4)}}}catch(e){}
console.log(JSON.stringify(out));
