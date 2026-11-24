import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AnalysisGate, createWorker, model, validateReport } from "./worker.mjs";
import { excerptDigest, selectApprovedExcerpts } from "../site/ai-approval.js";

const origin = "https://dryangban.github.io";
const code = "testing-access-000";
const notice = "RTEST00001:000";
const alternate = "RTEST00002:000";
const texts = ["제안서는 2027년 1월 11일 10시까지 제출해야 합니다."];
const sha256 = await excerptDigest(texts);
const source = {
  id:"d1", filename:"가상 공고문.pdf", sourceUrl:"https://www.g2b.go.kr/test-only.pdf", format:"pdf",
  sha256, segments:[{location:{page:2}, start:0, end:texts[0].length}],
};
const registry = Object.fromEntries([notice, alternate].map((key) => [key, { documents:[source], permission:"fixture" }]));
const payload = key => ({ notice:key, documents:[{id:"d1", texts}] });
const fakeResult = {
  sections:[
    {id:"schedule",items:[{type:"required",summary:"제안서는 1월 11일 오전 10시까지 제출합니다.",basis:[{id:"d1-1",quote:texts[0]}]}]},
    {id:"budget",items:[{type:"required",summary:"근거 없는 금액",basis:[{id:"d1-1",quote:"예산은 100억 원이다"}]}]},
  ],
};
const upstream = () => Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(fakeResult)}]}}]});

function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {exec(query,...args) {
    const statement = db.prepare(query);
    if (!/^SELECT/i.test(query)) {
      statement.run(...args);
      return {toArray:()=>[]};
    }
    return {toArray:()=>statement.all(...args)};
  }};
}

function setup(mock = upstream, expectedExcerpts = [{id:"d1-1",text:texts[0]}]) {
  const sql = sqlite();
  let calls = 0;
  const env = { GEMINI_API_KEY:" fixture-only\r\n", DEMO_ACCESS_CODE:code, AI_FREE_TIER_CONFIRMED:"true" };
  const gate = new AnalysisGate({storage:{sql}}, env, (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(init.headers["x-goog-api-key"], "fixture-only");
    const transmitted = JSON.parse(init.body);
    assert(!Object.hasOwn(transmitted,"tools"));
    assert(!Object.hasOwn(transmitted.generationConfig,"temperature"));
    assert.deepEqual(transmitted.generationConfig.thinkingConfig, {thinkingLevel:"low"});
    assert.equal(transmitted.generationConfig.responseMimeType,"application/json");
    assert.deepEqual(transmitted.generationConfig.responseJsonSchema.required,["sections"]);
    const input = JSON.parse(transmitted.contents[0].parts[0].text);
    assert.deepEqual(input.excerpts, expectedExcerpts);
    return mock();
  });
  env.ANALYSIS_GATE = { idFromName: name => name, get: () => ({
    fetch: (url, options) => gate.fetch(new Request(url,options)),
  }) };
  const worker = createWorker(registry);
  async function post(value, options = {}) {
    return worker.fetch(new Request("https://worker/v1/analyze",{
      method:"POST",headers:{Origin:options.origin??origin,"Content-Type":"application/json",
        Authorization:options.authorization??"Bearer "+code},
      body:JSON.stringify(value),
    }), env);
  }
  return {env, worker, sql, post, calls: () => calls};
}

test("external origins, missing authentication, and unreviewed document content are rejected", async () => {
  const {post,calls} = setup();
  assert.equal((await post(payload(notice),{origin:"https://example.org"})).status,403);
  assert.equal((await post(payload(notice),{authorization:"Bearer wrong-code-00000"})).status,401);
  assert.equal((await post(payload("RTEST00003:000"))).status,404);
  assert.equal((await post({...payload(notice),companyProfile:"private data"})).status,400);
  assert.equal((await post({notice,documents:[{id:"d1",texts:["바뀐 문장입니다."]}]})).status,403);
  assert.equal((await post({notice,documents:[{id:"d1",texts:["가".repeat(25_000)]}]})).status,413);
  assert.equal(calls(),0);
});

test("valid analysis checks quotations, includes locations and reuses the result", async () => {
  const {post,calls} = setup();
  const response = await post(payload(notice));
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),origin);
  const report = await response.json();
  assert.equal(report.mode,"live");
  assert.equal(report.model,model);
  assert.equal(report.partial,true);
  assert.equal(Object.keys(report.sections).length,14);
  assert.equal(report.discarded,1);
  assert.deepEqual(report.sections.budget,[]);
  assert.deepEqual(report.sections.schedule[0].basis[0].location,{page:2});
  const later = await post(payload(notice));
  assert.equal((await later.json()).mode,"reused");
  assert.equal(calls(),1);
});

test("the Worker adds CORS without modifying immutable proxy response headers", async () => {
  const {env,post} = setup();
  env.ANALYSIS_GATE.get = () => ({fetch: async () => Response.redirect("https://example.org/")});
  const response = await post(payload(notice));
  assert.equal(response.status,302);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"),origin);
  assert.equal(response.headers.get("Location"),"https://example.org/");
});

test("free-tier flag and global per-day, per-minute and concurrent quotas", async () => {
  let start;
  let finish;
  const begun = new Promise(resolve => { start = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const {post,sql,env} = setup(() => { start(); return pending; });
  env.AI_FREE_TIER_CONFIRMED = "false";
  assert.equal((await post(payload(notice))).status,503);
  env.AI_FREE_TIER_CONFIRMED = "true";
  const first = post(payload(notice));
  await begun;
  assert.equal((await (await post(payload(alternate))).json()).error,"busy");
  finish(upstream());
  await first;
  assert.equal((await (await post(payload(alternate))).json()).error,"minute_limit");
  const oldRequest = Date.now() - 300_000;
  for(let i=0;i<5;i++) sql.exec("INSERT INTO requests VALUES (?)",oldRequest-i);
  assert.equal((await (await post(payload(alternate))).json()).error,"daily_limit");
});

test("provider limit is surfaced and no fallback model is called", async () => {
  const {post,calls} = setup(() => new Response("upstream hidden",{status:429}));
  const response = await post(payload(notice));
  assert.equal(response.status,429);
  assert.deepEqual(await response.json(),{error:"gemini_limit"});
  assert.equal(calls(),1);
});

test("authenticated model check sends only fictional Korean data and verifies the schedule quote", async () => {
  const quote = "제안서는 2027년 1월 11일 오전 10시까지 제출해야 합니다.";
  const excerpts = [{id:"model-check-1",text:"이 문서는 연결 확인용 가상 공고입니다. " + quote}];
  const result = {sections:[{id:"schedule",items:[{
    type:"required", summary:"제안서 제출은 1월 11일 오전 10시까지입니다.",
    basis:[{id:excerpts[0].id, quote}],
  }]}]};
  const reply = () => Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify(result)}]}}]});
  const {env,worker,post,calls} = setup(reply, excerpts);
  const check = (authorization, body) => worker.fetch(new Request("https://worker/v1/model-check", {
    method:"POST", headers:{Origin:origin, Authorization:authorization}, body,
  }), env);
  const bearer = "Bearer " + code;
  assert.equal((await check("")).status,401);
  assert.equal((await check(bearer,"아무 내용")).status,400);
  assert.equal(calls(),0);
  // Workers can expose a zero-length POST body as a readable stream.
  const response = await check(bearer, "");
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), {
    model:"gemini-3.8-flash", structuredJson:true, evidenceVerified:true, synthetic:true, mode:"live",
  });
  assert.equal((await (await check(bearer)).json()).mode,"reused");
  assert.equal((await (await post(payload(notice))).json()).error,"minute_limit");
  assert.equal(calls(),1);
});

test("browser uses the approved normalized text range and invalid evidence is removed", () => {
  assert.deepEqual(selectApprovedExcerpts([{page:2,text:"  "+texts[0]}],source.segments),texts);
  assert.throws(() => selectApprovedExcerpts([{page:3,text:texts[0]}],source.segments),/version_mismatch/);
  assert.deepEqual(validateReport(fakeResult,[]).sections.schedule,[]);
});
