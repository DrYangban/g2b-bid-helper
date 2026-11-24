import { cellValue, noticeLink } from "./bid-ui.js";
import { reasonLabels, warningLabels } from "./attachment-preview.js?v=3a2";

const byId = (id) => document.getElementById(id);
const dialog = byId("requirement-dialog");
const noticeStatuses = {
  processed: "사전 처리 완료",
  partial: "일부 처리 · 누락 항목 확인 필요",
  failed: "문서 추출 실패 · 원문 확인 필요",
  unprocessed: "아직 사전 처리되지 않은 공고",
};
const documentStatuses = { success: "텍스트 읽음", partial: "일부만 읽음", failed: "읽기 실패", unprocessed: "처리 범위 밖" };
const fieldNames = {
  scope: "사업 목적 및 주요 업무", budget: "사업 예산", period: "사업 수행 기간", eligibility: "입찰 참가 자격",
  region_industry: "지역 및 업종 제한", licenses: "면허 및 인증 요건", experience: "유사 사업 수행 실적",
  documents: "필수 제출서류", schedule: "입찰 및 제안서 제출 일정(한국시간)", evaluation: "평가 기준",
  joint_subcontract: "공동수급 및 하도급 조건",
};
const fieldStatuses = {
  found: "추출한 단서 · 적용 조건은 원문 확인",
  located: "관련 위치를 찾음 · 자세한 내용 확인 필요",
  missing: "확인 필요 · 추출 결과에서 찾지 못함",
  conflict: "확인 필요 · 같은 항목에 다른 값이 있음",
};
const labels = {
  topic: {it:"정보화·전산", facilities:"시설·환경", culture:"콘텐츠·행사", transport:"운송", research:"조사·교육", engineering:"건설기술"},
  region: {seoul:"서울특별시", busan:"부산광역시", daegu:"대구광역시", incheon:"인천광역시", gwangju:"광주광역시", daejeon:"대전광역시", ulsan:"울산광역시", sejong:"세종특별자치시", gyeonggi:"경기도", gangwon:"강원특별자치도", chungbuk:"충청북도", chungnam:"충청남도", jeonbuk:"전북특별자치도", jeonnam:"전라남도", gyeongbuk:"경상북도", gyeongnam:"경상남도", jeju:"제주특별자치도"},
  certificate: {direct:"직접생산확인증명서", small:"소기업·소상공인 확인서", sme:"중소기업확인서", software:"소프트웨어사업자 등록·확인", g2b:"나라장터 입찰참가자격 등록"},
  qualification: {local:"지방계약법 시행령 제13조", national:"국가계약법 시행령 제12조"},
  document: {proposal:"제안서", priceProposal:"가격제안서", bidApplication:"입찰참가신청서", registration:"사업자등록증", registry:"법인 등기 증명", seal:"인감증명서", usedSeal:"사용인감계", agent:"위임장", pledge:"청렴 관련 서약서", references:"실적증명서", direct:"직접생산확인증명서", small:"소기업·소상공인 확인서", sme:"중소기업확인서"},
};
const findingNames = {
  topic:"업무 유형 단서", budget:"문서상 예산·용역금액", estimate:"추정가격·추정금액", base:"기초금액",
  region:"문서에 표시된 지역", certificate:"언급된 인증·등록", qualification:"언급된 자격 근거", document:"언급된 제출서류", industryCode:"업종 코드",
  proposalDeadline:"제안서 제출 마감", bidDeadline:"입찰 마감", opening:"개찰 일시",
  technical:"기술평가", price:"가격평가", joint:"공동수급", subcontract:"하도급",
};
const currency = new Intl.NumberFormat("ko-KR");
let collectedAt;
let loadPromise;
let selection = 0;

function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function setRequirementSnapshot(data) {
  collectedAt = data.collectedAt;
  loadPromise = undefined;
}

function loadReports() {
  loadPromise ??= fetch("./data/requirements.json", { cache: "no-cache" }).then(async (response) => {
    if (!response.ok) throw Error("requirements_unavailable");
    const data = await response.json();
    if (data.collectedAt !== collectedAt || data.status !== "available" || !data.notices) throw Error("requirements_unavailable");
    return data.notices;
  }).catch((error) => {
    loadPromise = undefined;
    throw error;
  });
  return loadPromise;
}

function findingText({type, value}) {
  const name = findingNames[type];
  if (labels[type]) return name + " · " + labels[type][value];
  if (["budget", "estimate", "base"].includes(type)) return name + " · " + currency.format(value) + "원";
  if (type === "duration") return "계약·착수 기준 기간 · " + value[0] + {day:"일", month:"개월", year:"년"}[value[1]];
  if (type === "dateRange") return "문서상 기간 · " + value.join(" ~ ");
  if (type === "endDate") return "문서상 종료일 · " + value;
  if (type === "experienceYears") return "문서에 언급된 실적 조회 기간 · 최근 " + value + "년";
  if (type === "experienceCount") return "언급된 실적 건수 단서 · " + value + "건 이상";
  if (["technical", "price"].includes(type)) return name + " · " + value[0] + (value[1] === "point" ? "점" : "%");
  if (["joint", "subcontract"].includes(type)) return name + " · " + (value === "allowed" ? "허용 문구" : "불허 문구");
  return name + " · " + value;
}

function sourceLink(source) {
  const link = noticeLink(source.sourceUrl, source.filename);
  if (!link) return null;
  const url = new URL(link.href);
  return url.protocol === "https:" && ["g2b.go.kr", "www.g2b.go.kr"].includes(url.hostname) && (!url.port || url.port === "443")
    ? link : null;
}

function sourcePosition(at, documents) {
  const document = documents[at.doc];
  if (!document) return null;
  const where = [at.page && at.page + "쪽", at.section && "구역 " + at.section,
    at.paragraph && "문단 " + at.paragraph, at.line && at.line + "번째 줄"].filter(Boolean).join(" · ");
  const item = element("li");
  item.append(sourceLink(document) ?? document.filename, " · " + where);
  return item;
}

function sourceList(locations, documents) {
  const list = element("ul", "", "requirement-sources");
  list.append(...locations.map((at) => sourcePosition(at, documents)).filter(Boolean));
  return list;
}

function renderField(key, value, documents) {
  const section = element("section", "", "requirement-field");
  section.append(element("h3", fieldNames[key]), element("p", fieldStatuses[value.status], "form-note"));
  for (const finding of value.findings) {
    section.append(element("p", findingText(finding), "requirement-fact"), sourceList(finding.at, documents));
  }
  if (!value.findings.length && value.references.length) section.append(sourceList(value.references, documents));
  return section;
}

function renderDocuments(documents, omitted) {
  const details = element("details", "", "requirement-documents");
  details.append(element("summary", "처리한 문서와 누락 확인"));
  if (omitted) details.append(element("p", "처리 대상에서 빠진 주요 첨부 " + omitted + "개", "form-note"));
  const list = element("ul", "", "attachment-files");
  for (const item of documents) {
    const line = element("li");
    line.append(sourceLink(item) ?? item.filename);
    const {state} = item;
    const notes = [item.category, item.format?.toUpperCase(), documentStatuses[state.status], reasonLabels[state.reason]];
    if (state.units > 0) notes.push("텍스트 단위 " + state.units + "개");
    line.append(element("p", notes.filter(Boolean).join(" · "), "form-note"));
    if (state.warnings?.length) line.append(element("p", state.warnings.map((note) => warningLabels[note]).filter(Boolean).join(" "), "form-note"));
    list.append(line);
  }
  details.append(list);
  return details;
}

function renderReport(report) {
  const content = byId("requirement-content");
  const fields = element("div", "", "requirement-fields");
  if (report.status !== "failed" && report.status !== "unprocessed") {
    for (const key of Object.keys(fieldNames)) {
      fields.append(renderField(key, report.fields[key], report.documents));
    }
  }
  content.replaceChildren(renderDocuments(report.documents, report.omitted), fields);
}

async function openRequirements(notice) {
  const active = ++selection;
  const status = byId("requirement-status");
  byId("requirement-notice-title").textContent = cellValue(notice, "공고명");
  const original = noticeLink(cellValue(notice, "공고 상세 링크"), "공고 원문 열기");
  byId("requirement-original").replaceChildren(...(original ? [original] : []));
  byId("requirement-content").replaceChildren();
  status.textContent = "공개된 사전 처리 결과를 불러오는 중입니다…";
  if (!dialog.open) dialog.showModal();
  try {
    const reports = await loadReports();
    if (active !== selection || !dialog.open) return;
    const report = reports[notice.noticeId + ":" + notice.revision];
    status.textContent = noticeStatuses[report?.status] ?? noticeStatuses.unprocessed;
    if (report) renderReport(report);
  } catch {
    if (active === selection && dialog.open) status.textContent = "사전 처리 자료를 불러오지 못했습니다. 공고 원문을 확인하세요.";
  }
}

export function requirementButton(notice) {
  const button = element("button", "필요 요건 확인", "attachment-button requirement-button");
  button.type = "button";
  button.disabled = typeof notice.noticeId !== "string" || typeof notice.revision !== "string";
  if (!button.disabled) button.addEventListener("click", () => openRequirements(notice));
  return button;
}

byId("requirement-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { selection++; });
