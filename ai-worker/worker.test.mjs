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

function setup(mock = upstream, expectedExcerpts = [{id:"d1-1",text:texts[0]}], testRegistry = registry) {
  const sql = sqlite();
  let calls = 0;
  const env = { GEMINI_API_KEY:" fixture-only\r\n", DEMO_ACCESS_CODE:code, AI_FREE_TIER_CONFIRMED:"true" };
  const gate = new AnalysisGate({storage:{sql}}, env, (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    assert.equal(init.headers["x-goog-api-key"], "fixture-only");
    const transmitted = JSON.parse(init.body);
    assert(!Object.hasOwn(transmitted,"tools"));
    assert(!Object.hasOwn(transmitted.generationConfig,"temperature"));
    assert.deepEqual(transmitted.generationConfig.thinkingConfig, {thinkingLevel:"MEDIUM"});
    assert.equal(transmitted.generationConfig.responseFormat.text.mimeType,"APPLICATION_JSON");
    assert.deepEqual(transmitted.generationConfig.responseFormat.text.schema.required,["sections"]);
    const input = JSON.parse(transmitted.contents[0].parts[0].text);
    if (expectedExcerpts) assert.deepEqual(input.excerpts, expectedExcerpts);
    return mock(input.excerpts);
  });
  env.ANALYSIS_GATE = { idFromName: name => name, get: () => ({
    fetch: (url, options) => gate.fetch(new Request(url,options)),
  }) };
  const worker = createWorker(testRegistry);
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
  assert.equal((await post({notice,documents:[{id:"d1",texts:["가".repeat(70_000)]}]})).status,413);
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

test("free-tier flag and global per-day, per-minute and concurrent quotas", async (t) => {
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-25T20:00:00Z")});
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
  const {post,calls} = setup(() => new Response("upstream hidden",{status:429,headers:{"Retry-After":"120"}}));
  const response = await post(payload(notice));
  assert.equal(response.status,429);
  assert.deepEqual(await response.json(),{error:"gemini_limit"});
  assert.equal(response.headers.get("Retry-After"),"120");
  assert.equal((await (await post(payload(alternate))).json()).error,"gemini_limit");
  assert.equal(calls(),1);
});

test("the confirmed project limit caps the app and resets on the Pacific day boundary", async (t) => {
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-25T08:05:00Z")});
  const {post,sql,env,calls} = setup();
  env.GEMINI_FREE_RPD = "2";
  const yesterday = Date.parse("2026-11-25T07:59:00Z");
  for (let i=0;i<6;i++) sql.exec("INSERT INTO requests VALUES (?)",yesterday-i);
  assert.equal((await post(payload(notice))).status,200);
  assert.equal((await (await post(payload(alternate))).json()).error,"daily_limit");
  assert.equal(calls(),1);
});

test("the authenticated fictional report verifies its sources and reuses the same generation", async (t) => {
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-11-25T20:00:00Z")});
  const reply = (excerpts) => {
    assert.equal(excerpts.length,6);
    assert.match(excerpts[0].text,/체험용 가상 공고/);
    const sections = [["scope",0],["eligibility",2],["documents",3],["schedule",4],["risks",5]].map(([id, i]) => {
      const quote = excerpts[i].text.split(". ")[0];
      return {id,items:[{type:"required", summary:quote, basis:[{id:excerpts[i].id, quote}]}]};
    });
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({sections})}]}}]});
  };
  const {env,worker,post,calls,sql} = setup(reply, null);
  const check = (authorization, body) => worker.fetch(new Request("https://worker/v1/model-check", {
    method:"POST", headers:{Origin:origin, Authorization:authorization}, body,
  }), env);
  const bearer = "Bearer " + code;
  assert.equal((await check("")).status,401);
  assert.equal((await check(bearer,"아무 내용")).status,400);
  assert.equal(calls(),0);
  for (let i=0;i<6;i++) sql.exec("INSERT INTO requests VALUES (?)",Date.now()-300_000-i);
  assert.equal((await (await post(payload(notice))).json()).error,"daily_limit");
  // Workers can expose a zero-length POST body as a readable stream.
  const response = await check(bearer, "");
  assert.equal(response.status,200);
  const report = await response.json();
  assert.equal(report.model,"gemini-3.6-flash");
  assert.equal(report.synthetic,true);
  assert.equal(report.mode,"live");
  assert.match(report.sections.schedule[0].basis[0].quote,/2027년 1월 11일 오전 10시/);
  assert.deepEqual(await (await check(bearer)).json(), {...report,mode:"reused"});
  assert.equal(calls(),1);
});

test("verified excerpts longer than 18,000 characters stay bounded and are labeled partial", async () => {
  const longTexts = Array.from({length:6},() => "가".repeat(4_000));
  const lateCondition = "검수 승인 후에만 잔금 30%를 지급합니다.";
  longTexts[5] = "가".repeat(4_000 - lateCondition.length) + lateCondition;
  const sha256 = await excerptDigest(longTexts);
  const longSource = {...source,sha256,segments:longTexts.map((text,i) => ({location:{page:i+1},start:0,end:text.length}))};
  const {post,calls} = setup((excerpts) => {
    assert.equal(excerpts.reduce((count,item) => count + item.text.length,0),24_000);
    assert(excerpts.at(-1).text.endsWith(lateCondition));
    return upstream();
  },null,{[notice]:{documents:[longSource]}});
  const response = await post({notice,documents:[{id:"d1",texts:longTexts}]});
  assert.equal(response.status,200);
  assert.equal((await response.json()).partial,true);
  assert.equal(calls(),1);
});

test("browser uses the approved normalized text range and invalid evidence is removed", () => {
  assert.deepEqual(selectApprovedExcerpts([{page:2,text:"  "+texts[0]}],source.segments),texts);
  assert.throws(() => selectApprovedExcerpts([{page:3,text:texts[0]}],source.segments),/version_mismatch/);
  assert.deepEqual(validateReport(fakeResult,[]).sections.schedule,[]);
});
