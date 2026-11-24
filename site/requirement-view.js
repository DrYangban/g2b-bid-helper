import { cellValue, noticeLink } from "./bid-ui.js";
import { reasonLabels, warningLabels } from "./attachment-preview.js?v=5b1";
import { officialAttachmentUrl } from "./attachment-source.js?v=5b1";
import { analyzeNotice, analyzeUploaded } from "./requirement-analysis.js?v=5b1";

const byId = (id) => document.getElementById(id);
const dialog = byId("requirement-dialog");
const status = byId("requirement-status");
const content = byId("requirement-content");
const manual = byId("requirement-manual");
const files = byId("requirement-files");
const noticeStatuses = {
  processed: "사전 처리 완료",
  partial: "일부 처리 · 누락 항목 확인 필요",
  failed: "문서 추출 실패 · 원문 확인 필요",
  unprocessed: "아직 사전 처리되지 않은 공고",
};
const documentStatuses = { success: "텍스트 읽음", partial: "일부만 읽음", failed: "읽기 실패", unprocessed: "처리 범위 밖" };
const badgeLabels = {
  processed: "사전 분석 완료", partial: "사전 일부 분석", failed: "사전 분석 실패",
  unprocessed: "미분석", loading: "사전 결과 확인 중", unavailable: "사전 상태 확인 불가",
};
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
let loadPromise;
let published = {};
let indexState = "loading";
let selection = 0;
let activeJob;
let chosenNotice;
const sessionReports = new Map();

function element(tag, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function setRequirementSnapshot(data) {
  published = {};
  sessionReports.clear();
  indexState = "loading";
  const request = fetch("./data/requirements.json", { cache: "no-cache", signal: AbortSignal.timeout(8_000) }).then(async (response) => {
    if (!response.ok) throw Error("requirements_unavailable");
    const index = await response.json();
    if (index.collectedAt !== data.collectedAt || index.status !== "available" ||
        !index.notices || typeof index.notices !== "object" || Array.isArray(index.notices)) throw Error("requirements_unavailable");
    if (loadPromise !== request) return false;
    published = index.notices;
    indexState = "available";
    return true;
  }).catch(() => {
    if (loadPromise === request) indexState = "unavailable";
    return false;
  });
  loadPromise = request;
  return request;
}

function key(notice) {
  return notice.noticeId + ":" + notice.revision;
}

export function hasPublishedRequirements(notice) {
  return ["processed", "partial"].includes(published[key(notice)]?.status);
}

function findingText({type, value}) {
  if (type === "document" || type === "requiredDocument") return labels.document[value];
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
  return noticeLink(officialAttachmentUrl(source.sourceUrl), source.filename);
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
  section.append(element("h4", fieldNames[key]), element("p", fieldStatuses[value.status], "form-note"));
  if (key === "documents") {
    for (const [type, title] of [["requiredDocument", "필수 제출 근거 있음"], ["document", "언급된 서류 · 필수 여부 확인 필요"]]) {
      const group = value.findings.filter((finding) => finding.type === type);
      if (!group.length) continue;
      section.append(element("h5", title));
      for (const finding of group) {
        section.append(element("p", findingText(finding), "requirement-fact"), sourceList(finding.at, documents));
      }
    }
  } else {
    for (const finding of value.findings) {
      section.append(element("p", findingText(finding), "requirement-fact"), sourceList(finding.at, documents));
    }
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
  const fields = element("div", "", "requirement-fields");
  if (report.fields) {
    for (const [title, keys] of [
      ["사업 개요와 일정", ["scope", "budget", "period", "schedule"]],
      ["참가 요건", ["eligibility", "region_industry", "licenses", "experience", "joint_subcontract"]],
      ["제출과 평가", ["documents", "evaluation"]],
    ]) {
      const group = element("section", "", "requirement-group");
      group.append(element("h3", title));
      for (const key of keys) group.append(renderField(key, report.fields[key], report.documents));
      fields.append(group);
    }
  }
  const origin = report.manual ? "직접 선택한 문서" : report.browser ? "이 브라우저에서 자동 처리" : "공개 사전 처리 결과";
  content.replaceChildren(element("p", origin, "form-note"), renderDocuments(report.documents, report.omitted), fields);
}

async function openRequirements(notice) {
  const active = ++selection;
  activeJob?.abort();
  chosenNotice = notice;
  manual.open = false;
  files.value = "";
  byId("requirement-notice-title").textContent = cellValue(notice, "공고명");
  const original = noticeLink(cellValue(notice, "공고 상세 링크"), "공고 원문 열기");
  byId("requirement-original").replaceChildren(...(original ? [original] : []));
  content.replaceChildren();
  status.textContent = "공개된 사전 처리 결과를 불러오는 중입니다…";
  if (!dialog.open) dialog.showModal();
  await loadPromise;
  if (active !== selection || !dialog.open) return;
  const id = key(notice);
  if (hasPublishedRequirements(notice)) {
    const report = published[id];
    status.textContent = noticeStatuses[report.status];
    renderReport(report);
    return;
  }
  if (sessionReports.has(id)) {
    showLocal(sessionReports.get(id));
    return;
  }
  await runLocal((signal, progress) => analyzeNotice(notice, signal, progress), id, published[id]);
}

function showLocal(report) {
  if (report.status === "failed") {
    status.textContent = (report.manual ? "수동 처리 실패 · " : "자동 처리 실패 · ") +
      (reasonLabels[report.reason] ?? "문서별 실패 사유를 확인해 주세요.");
  } else {
    status.textContent = report.status === "partial" ? "브라우저 일부 처리 · 누락 항목 확인 필요" : "브라우저 처리 완료";
  }
  renderReport(report);
  if (report.status === "failed") content.querySelector("details").open = true;
}

async function runLocal(job, id, prior) {
  activeJob?.abort();
  const controller = new AbortController();
  const active = activeJob = controller;
  const visible = () => active === activeJob && dialog.open && !active.signal.aborted;
  content.replaceChildren();
  content.setAttribute("aria-busy", "true");
  status.textContent = id ? "공개 첨부파일 목록 확인 중…" : "선택한 문서를 읽는 중…";
  try {
    const report = await job(active.signal, (phase, filename, done, total) => {
      if (!visible()) return;
      if (phase === "rules") status.textContent = "문서 읽기 " + done + "/" + total + " · 요건 정리 중…";
      if (phase === "download") status.textContent = "원본 내려받는 중 · " + filename + " (" + done + "/" + total + " 처리)";
      if (phase === "read") status.textContent = "텍스트 읽는 중 · " + filename + " (" + done + "/" + total + " 처리)";
      if (phase === "done") status.textContent = "문서 " + done + "/" + total + "개 처리 중…";
    });
    if (!visible()) return;
    if (id && report.fields) {
      if (sessionReports.size >= 24) sessionReports.delete(sessionReports.keys().next().value);
      sessionReports.set(id, report);
    }
    showLocal(report);
  } catch (error) {
    if (!visible()) return;
    status.textContent = (id ? "자동 처리 실패 · " : "수동 처리 실패 · ") +
      (reasonLabels[error.message] ?? "이 브라우저에서 처리하지 못했습니다.");
    if (prior?.documents?.length) renderReport(prior);
  } finally {
    if (active === activeJob) content.removeAttribute("aria-busy");
  }
}

export function requirementButton(notice) {
  const action = element("div", "", "requirement-action");
  const button = element("button", "필요 요건 확인", "attachment-button requirement-button");
  button.type = "button";
  button.disabled = typeof notice.noticeId !== "string" || typeof notice.revision !== "string";
  if (!button.disabled) button.addEventListener("click", () => openRequirements(notice));
  const current = indexState === "available" ? published[key(notice)]?.status ?? "unprocessed" : indexState;
  const badge = element("span", badgeLabels[current] ?? badgeLabels.unprocessed, "requirement-badge");
  badge.dataset.status = current;
  action.append(button, badge);
  return action;
}

byId("requirement-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  selection++;
  activeJob?.abort();
  chosenNotice = undefined;
  files.value = "";
  content.replaceChildren();
  content.removeAttribute("aria-busy");
});
byId("requirement-manual-run").addEventListener("click", () => {
  if (!chosenNotice || !dialog.open) return;
  const chosenFiles = Array.from(files.files);
  files.value = "";
  void runLocal((signal, progress) => analyzeUploaded(chosenFiles, signal, progress));
});
