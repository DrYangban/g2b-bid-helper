const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require(process.env.G2B_QA_NODE_MODULES
  ? path.join(process.env.G2B_QA_NODE_MODULES, "playwright") : "playwright");

const root = path.resolve(process.argv[2] ?? ".");
const vendor = path.resolve(process.env.G2B_QA_VENDOR ?? path.join(root,"site","vendor"));
const now = new Date().toISOString();
const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
const names = ["시설 청소 완료", "시설 청소 일부", "시설 청소 실패", "시설 청소 미처리", "시설 청소 미지원", "시설 청소 취소 시험"];
const notices = names.map((name, i) => ({
  noticeId: "R26BK0180000" + i, revision: String(i).padStart(3, "0"), type: "service",
  "공고명": name, "발주기관": "테스트 기관", "입찰마감일": deadline,
  "추정가격(원)": "2500000", "공고 상세 링크": "https://www.g2b.go.kr/",
}));
const testKey = i => notices[i].noticeId + ":" + notices[i].revision;
const attachment = { filename: "공고문.pdf", format: "pdf", category: "공고문",
  sourceUrl: "https://www.g2b.go.kr/fixture.pdf" };
const txt = (suffix, format = "txt") => ({ filename: "공고문."+format, format, category:"공고문",
  sourceUrl: "https://www.g2b.go.kr/fixture-"+suffix+"."+format });
const documentText = "사업예산 : 금 3,750,000원\n필수 제출서류\n사업자등록증 1부\n해당 시 위임장\n";
const pdfOnPreview = "한글 파일 미리보기";
const keys = ["scope", "budget", "period", "eligibility", "region_industry", "licenses", "experience",
  "documents", "schedule", "evaluation", "joint_subcontract"];
const fields = Object.fromEntries(keys.map(key => [key, { status: "missing", findings: [], references: [] }]));
fields.budget = { status: "found", findings: [{ type: "budget", value: 2500000, at: [{ doc: 0, page: 2 }] }], references: [] };
const report = status => ({ status, omitted: status === "partial" ? 1 : 0, fields, documents: [{...attachment,
  state: { status: status === "failed" ? "failed" : "success", reason: status === "failed" ? "encrypted" : null,
    warnings: [], units: status === "failed" ? 0 : 2, downloaded: true }
}] });
const base = {collectedAt: now, status: "available"};
const data = {
  "bids.json": { ...base, window: {start:now,end:now}, notices },
  "attachments.json": { ...base, notices: {
    [testKey(0)]: [attachment], [testKey(2)]:[txt("blocked")],
    [testKey(3)]:[txt("valid")], [testKey(4)]:[txt("unsupported","xlsx")],
    [testKey(5)]:[txt("slow")],
  } },
  "requirements.json": { ...base, notices: Object.fromEntries(["processed","partial","failed"]
    .map((status,i) => [testKey(i),report(status)])) },
};
const mime = {".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".wasm":"application/wasm",".zip":"application/zip"};
const server = http.createServer(async (request,response) => {
  const name = new URL(request.url,"http://localhost").pathname.replace(/^\/project\//,"");
  const document = name.startsWith("data/") && data[name.slice(5)];
  if(document) return response.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(document));
  try {
    const file = name.startsWith("vendor/") ? path.join(vendor,name.slice(7)) :
      name === "requirement_rules.py" ? path.join(root,name) : path.join(root,"site",name||"index.html");
    const payload = await fs.readFile(file);
    response.writeHead(200,{"Content-Type":mime[path.extname(file)]??"text/plain; charset=utf-8"}).end(payload);
  } catch { response.writeHead(404).end(); }
});

(async () => {
  await new Promise((resolve,reject) => {server.on("error",reject);server.listen(0,"127.0.0.1",resolve);});
  let browser;
  try {
    browser = await chromium.launch(process.env.G2B_TEST_BROWSER_CHANNEL ? {channel:process.env.G2B_TEST_BROWSER_CHANNEL} : {});
    const url = "http://127.0.0.1:"+server.address().port+"/project/";
    const page = await browser.newPage({acceptDownloads:true, viewport:{width:1280,height:900}});
    const traffic = [];
    const errors = [];
    const requestErrors = [];
    let outside = 0;
    page.on("pageerror",error => errors.push(error.message));
    page.on("request",request => traffic.push([request.method(),request.url(),request.postData()]));
    page.on("requestfailed",request => requestErrors.push([request.url(),request.failure()?.errorText]));
    await page.route(/^https:\/\/www\.g2b\.go\.kr\/fixture-.*\.txt$/, async (route) => {
      outside++;
      const requestUrl = route.request().url();
      const headers = {"Access-Control-Allow-Origin":"*"};
      if(requestUrl.includes("-blocked.")) return route.fulfill({status:503,headers,body:"unavailable"});
      if(requestUrl.includes("-slow.")) {
        await new Promise(resolve => setTimeout(resolve,800));
        return route.fulfill({status:200,headers,body:documentText}).catch(()=>{});
      }
      await new Promise(resolve => setTimeout(resolve,200));
      return route.fulfill({status:200,headers,body:documentText});
    });
    await page.goto(url);
    const dialog = page.getByRole("dialog",{name:"필요 요건 확인",exact:true});
    const open = index => page.getByRole("row",{name:new RegExp(names[index])}).getByRole("button",{name:"필요 요건 확인",exact:true}).click();
    const close = () => dialog.getByRole("button",{name:"닫기",exact:true}).click();
    const searchFilter = page.locator("#search-preprocessed");
    await page.locator(".requirement-badge[data-status=unprocessed]").first().waitFor();
    await searchFilter.check();
    assert.equal(await page.locator("#rows tr").count(),2);
    await searchFilter.uncheck();
    const expected = ["사전 처리 완료","일부 처리","정상적인 파일 응답","브라우저 처리 완료","자동으로 읽을 수 있는"];
    for(let i=0;i<expected.length;i++){
      await open(i);
      if(i===3) await dialog.getByText(/원본 내려받는 중/).waitFor({timeout: 5000});
      await dialog.getByText(expected[i]).waitFor({timeout: i===3 ? 22000 : 9000}).catch(async () => {
        throw Error("Fixture " + i + " did not show " + expected[i] + "\n" + await dialog.innerText()
          + "\nFixture route count " + outside + "\n" + JSON.stringify(requestErrors));
      });
      if(i===0){
        await dialog.getByText("문서상 예산·용역금액 · 2,500,000원",{exact:true}).waitFor();
        const source = dialog.getByRole("link",{name:"공고문.pdf",exact:true}).last();
        assert.equal(await source.getAttribute("href"),attachment.sourceUrl);
        await dialog.getByText("· 2쪽",{exact:false}).waitFor();
        assert.equal(await dialog.locator("input[type=file]").isVisible(),false);
        assert.equal(outside,0);
      }
      if(i===2){
        await dialog.getByText("수동 첨부로 요건 확인",{exact:true}).click();
        await dialog.locator("#requirement-files").setInputFiles({name:"직접 선택.txt",mimeType:"text/plain",buffer:Buffer.from(documentText)});
        await dialog.getByRole("button",{name:"선택한 파일 분석",exact:true}).click();
        await dialog.getByText("브라우저 처리 완료",{exact:true}).waitFor();
        await dialog.getByText("직접 선택한 문서",{exact:true}).waitFor();
      }
      if(i===3){
        await dialog.getByText("문서상 예산·용역금액 · 3,750,000원",{exact:true}).waitFor();
        await dialog.getByText("필수 제출 근거 있음",{exact:true}).waitFor();
        await dialog.getByText("언급된 서류 · 필수 여부 확인 필요",{exact:true}).waitFor();
        await dialog.getByText("· 3번째 줄",{exact:false}).waitFor();
        assert.equal(await dialog.locator("input[type=file]").isVisible(),false);
      }
      await close();
    }
    const priorOutside = outside;
    await open(3);
    await dialog.getByText("브라우저 처리 완료",{exact:true}).waitFor();
    assert.equal(outside,priorOutside);
    await close();
    await open(5);
    await dialog.getByText(/원본 내려받는 중/).waitFor();
    await close();
    await open(0);
    await dialog.getByText("사전 처리 완료",{exact:true}).waitFor();
    await close();
    await page.getByRole("row",{name:new RegExp(names[0])}).getByRole("button",{name:"첨부파일",exact:true}).click();
    const preview = page.getByRole("dialog",{name:"공고 첨부파일",exact:true});
    await preview.getByRole("link",{name:"원본 열기·다운로드"}).waitFor();
    await preview.getByLabel("12MB 이하 파일 선택").setInputFiles({name:"fixture.txt",mimeType:"text/plain",buffer:Buffer.from(pdfOnPreview)});
    await preview.getByText(pdfOnPreview,{exact:true}).waitFor();
    await preview.getByRole("button",{name:"닫기",exact:true}).click();
    await page.getByRole("searchbox",{name:"공고명 키워드"}).fill("미처리");
    assert.equal(await page.locator("#rows tr").count(),1);
    let download = page.waitForEvent("download");
    await page.getByRole("button",{name:"검색 결과 CSV 저장"}).click();
    assert((await download).suggestedFilename().endsWith(".csv"));
    await page.getByRole("button",{name:"맞춤 추천",exact:true}).click();
    await page.getByRole("checkbox",{name:"시설관리·청소",exact:true}).check();
    await page.locator("#recommendation-preprocessed").check();
    assert.equal(await page.locator("#recommendation-list .requirement-button").count(),2);
    await page.locator("#recommendation-preprocessed").uncheck();
    await page.locator("#recommendation-list").getByRole("button",{name:"필요 요건 확인",exact:true}).first().click();
    assert(await dialog.isVisible());
    await dialog.getByRole("button",{name:"닫기",exact:true}).click();
    download = page.waitForEvent("download");
    await page.getByRole("button",{name:"추천 결과 CSV 저장",exact:true}).click();
    assert((await download).suggestedFilename().endsWith(".csv"));
    await page.reload();
    await page.getByRole("button",{name:"맞춤 추천",exact:true}).click();
    assert(await page.getByRole("checkbox",{name:"시설관리·청소",exact:true}).isChecked());
    assert.deepEqual(errors,[]);
    assert(traffic.every(([method,resource,body])=>method==="GET"&&!body&&
      (resource.startsWith(url)||resource.startsWith("https://www.g2b.go.kr/fixture-"))));
    if(process.env.G2B_TEST_PYTHON){
      const documents = [{parts:documentText.trim().split("\n").map((text,i)=>({text,line:i+1}))}];
      const native = spawnSync(process.env.G2B_TEST_PYTHON,
        ["-X","utf8","-c","import json,sys; from requirement_rules import summarize_documents; print(json.dumps(summarize_documents(json.load(sys.stdin))))"],
        {cwd:root,input:JSON.stringify(documents),encoding:"utf8"});
      assert.equal(native.status,0,native.stderr);
      const inBrowser = await page.evaluate(docs => new Promise((resolve,reject)=>{
        const worker = new Worker("./requirement-rules-worker.js?v=5b1",{type:"module"});
        worker.onmessage = ({data}) => {worker.terminate(); if(data.fields) resolve(data.fields); else reject(Error(data.error));};
        worker.onerror = error => {worker.terminate(); reject(error);};
        worker.postMessage({documents:docs});
      }),documents);
      assert.deepEqual(inBrowser,JSON.parse(native.stdout));
      console.log("PASS identical browser and native Python rules for the same text and evidence");
    }
    const mobile = await browser.newPage({viewport:{width:375,height:800},isMobile:true});
    await mobile.goto(url);
    await mobile.getByRole("row",{name:new RegExp(names[0])}).getByRole("button",{name:"필요 요건 확인",exact:true}).click();
    await mobile.getByText("문서상 예산·용역금액 · 2,500,000원",{exact:true}).waitFor();
    const rect = await mobile.locator("#requirement-dialog").boundingBox();
    assert(rect.x>=0 && rect.x+rect.width<=375);
    console.log("PASS automatic processing, status/filter, sources, direct fail + manual fallback, cancellation, and tab result reuse");
    console.log("PASS desktop/mobile, search, both CSVs, profile persistence, manual preview, and no text upload");
  } finally { if(browser) await browser.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
