const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require(process.env.G2B_QA_NODE_MODULES
  ? path.join(process.env.G2B_QA_NODE_MODULES, "playwright") : "playwright");

const root = path.resolve(process.argv[2] ?? ".");
const now = new Date().toISOString();
const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
const noticeId = "R26BK01800001";
const names = ["시설 청소 완료", "시설 청소 일부", "시설 청소 실패", "시설 청소 미처리"];
const notices = names.map((name, i) => ({
  noticeId, revision: String(i).padStart(3, "0"), type: "service",
  "공고명": name, "발주기관": "테스트 기관", "입찰마감일": deadline,
  "추정가격(원)": "2500000", "공고 상세 링크": "https://www.g2b.go.kr/",
}));
const attachment = { filename: "공고문.pdf", format: "pdf", category: "공고문",
  sourceUrl: "https://www.g2b.go.kr/fixture.pdf" };
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
  "attachments.json": { ...base, notices: { [noticeId+":000"]: [attachment] } },
  "requirements.json": { ...base, notices: Object.fromEntries(["processed","partial","failed"]
    .map((status,i) => [noticeId+":"+String(i).padStart(3,"0"),report(status)])) },
};
const mime = {".html":"text/html",".js":"text/javascript",".css":"text/css"};
const server = http.createServer(async (request,response) => {
  const name = new URL(request.url,"http://localhost").pathname.replace(/^\/project\//,"");
  const document = name.startsWith("data/") && data[name.slice(5)];
  if(document) return response.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify(document));
  try {
    const file = path.join(root,"site",name||"index.html");
    const payload = await fs.readFile(file);
    response.writeHead(200,{"Content-Type":(mime[path.extname(file)]??"text/plain")+"; charset=utf-8"}).end(payload);
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
    page.on("pageerror",error => errors.push(error.message));
    page.on("request",request => traffic.push([request.method(),request.url()]));
    await page.goto(url);
    const dialog = page.getByRole("dialog",{name:"필요 요건 확인",exact:true});
    const expected = ["사전 처리 완료","일부 처리","문서 추출 실패","아직 사전 처리되지 않은"];
    for(let i=0;i<names.length;i++){
      await page.getByRole("row",{name:new RegExp(names[i])}).getByRole("button",{name:"필요 요건 확인",exact:true}).click();
      await dialog.getByText(expected[i]).waitFor();
      if(i===0){
        await dialog.getByText("문서상 예산·용역금액 · 2,500,000원",{exact:true}).waitFor();
        const source = dialog.getByRole("link",{name:"공고문.pdf",exact:true}).last();
        assert.equal(await source.getAttribute("href"),attachment.sourceUrl);
        await dialog.getByText("· 2쪽",{exact:false}).waitFor();
        assert.equal(await dialog.locator("input[type=file]").count(),0);
      }
      if(i===2){
        await dialog.getByText("처리한 문서와 누락 확인",{exact:true}).click();
        await dialog.getByText(/암호화/).waitFor();
      }
      await dialog.getByRole("button",{name:"닫기",exact:true}).click();
    }
    await page.getByRole("row",{name:new RegExp(names[0])}).getByRole("button",{name:"첨부파일",exact:true}).click();
    const preview = page.getByRole("dialog",{name:"공고 첨부파일",exact:true});
    await preview.getByRole("link",{name:"원본 열기·다운로드"}).waitFor();
    await preview.getByLabel("12MB 이하 파일 선택").setInputFiles({name:"fixture.txt",mimeType:"text/plain",buffer:Buffer.from("한글 파일 미리보기")});
    await preview.getByText("한글 파일 미리보기",{exact:true}).waitFor();
    await preview.getByRole("button",{name:"닫기",exact:true}).click();
    await page.getByRole("searchbox",{name:"공고명 키워드"}).fill("미처리");
    assert.equal(await page.locator("#rows tr").count(),1);
    let download = page.waitForEvent("download");
    await page.getByRole("button",{name:"검색 결과 CSV 저장"}).click();
    assert((await download).suggestedFilename().endsWith(".csv"));
    await page.getByRole("button",{name:"맞춤 추천",exact:true}).click();
    await page.getByRole("checkbox",{name:"시설관리·청소",exact:true}).check();
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
    assert(traffic.every(([method,resource])=>method==="GET"&&resource.startsWith(url)));
    const mobile = await browser.newPage({viewport:{width:375,height:800},isMobile:true});
    await mobile.goto(url);
    await mobile.getByRole("row",{name:new RegExp(names[0])}).getByRole("button",{name:"필요 요건 확인",exact:true}).click();
    await mobile.getByText("문서상 예산·용역금액 · 2,500,000원",{exact:true}).waitFor();
    const rect = await mobile.locator("#requirement-dialog").boundingBox();
    assert(rect.x>=0 && rect.x+rect.width<=375);
    console.log("PASS desktop/mobile requirements, evidence, missing/failed/partial, search, both CSVs, profile persistence, and manual preview");
    console.log("PASS requirement opening fetched only public same-origin JSON");
  } finally { if(browser) await browser.close(); server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
