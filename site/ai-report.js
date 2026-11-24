import { cellValue, noticeLink } from "./bid-ui.js";
import { officialAttachmentUrl } from "./attachment-source.js?v=5b1";
import { reasonLabels } from "./attachment-preview.js?v=5b1";
import { readApprovedAttachment } from "./requirement-analysis.js?v=6b1";
import { aiSections, excerptDigest, selectApprovedExcerpts } from "./ai-approval.js?v=6b1";

const service = "https://g2b-bid-helper-ai.kupaksa.workers.dev";
const byId = (id) => document.getElementById(id);
const dialog = byId("ai-report-dialog");
const status = byId("ai-report-status");
const body = byId("ai-report-body");
const accessForm = byId("ai-access-form");
const accessInput = byId("ai-access-code");
const errors = {
  access_required: "데모 접근 코드가 필요하거나 코드가 맞지 않습니다.",
  not_approved: "외부 AI 이용이 확인된 첨부 문서가 없습니다. 필요 요건 확인을 이용할 수 있습니다.",
  not_enabled: "무료 이용 등급과 데모 설정을 확인하는 중입니다. 필요 요건 확인을 이용할 수 있습니다.",
  version_mismatch: "현재 파일의 내용 또는 버전이 승인된 범위와 다릅니다.",
  daily_limit: "오늘의 데모 분석 한도를 사용했습니다.",
  minute_limit: "분석 요청 사이에 잠시 기다려 주세요.",
  gemini_limit: "Gemini 무료 사용 한도에 도달했습니다.",
  busy: "다른 분석이 진행 중입니다. 잠시 뒤 다시 시도하세요.",
  invalid_model_report: "Gemini 보고서 형식을 검증할 수 없습니다.",
  model_incomplete: "Gemini 응답이 끝까지 생성되지 않았습니다.",
  gemini_unavailable: "Gemini 분석 응답을 받지 못했습니다.",
  service_unavailable: "AI 분석 서버에 연결할 수 없습니다. 필요 요건 확인을 이용할 수 있습니다.",
  input_limit: "허용된 발췌 크기 한도를 넘었습니다.",
};
const itemLabels = { required:"필수", optional:"선택", conditional:"조건부", information:"참고" };
let selection;
let active;
let sessionCode;

function el(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

async function request(path, options = {}) {
  let response;
  let value;
  try {
    response = await fetch(service + path, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...options });
    value = await response.json();
  } catch {
    options.signal?.throwIfAborted();
    throw Error("service_unavailable");
  }
  if (!response.ok) throw Error(value.error ?? "service_unavailable");
  return value;
}

function locationLabel(location) {
  return [location?.page && location.page + "쪽", location?.section && "구역 " + location.section,
    location?.paragraph && "문단 " + location.paragraph, location?.line && location.line + "번째 줄"].filter(Boolean).join(" · ");
}

function render(result, unavailable) {
  body.replaceChildren();
  const overview = el("p", result.mode === "reused" ?
    "Gemini의 기존 결과를 다시 열었습니다." : "이번 요청에서 Gemini가 생성한 보고서입니다.");
  overview.className = "form-note";
  body.append(overview);
  if (result.partial || unavailable.length) {
    body.append(el("p", "일부 범위 분석 · 승인된 발췌만 사용했습니다. 누락된 문서·표·이미지와 적용 예외는 원문에서 확인하세요."));
  }
  if (unavailable.length) {
    const details = el("details");
    details.append(el("summary", "읽지 못한 문서 (" + unavailable.length + "개)"));
    const failures = el("ul");
    for (const [filename, reason] of unavailable) failures.append(el("li", filename + " · " + reason));
    details.append(failures);
    body.append(details);
  }
  if (result.discarded) body.append(el("p", "원문 근거를 확인할 수 없는 항목 " + result.discarded + "개를 제외했습니다."));
  for (const [id, name] of Object.entries(aiSections)) {
    const section = el("section");
    section.className = "requirement-field";
    section.append(el("h3", name));
    const items = result.sections?.[id] ?? [];
    if (!items.length) section.append(el("p", "확인 필요 · 전달한 문서 범위에서 근거를 확인하지 못했습니다."));
    for (const item of items) {
      const claim = el("div");
      claim.className = "ai-claim";
      claim.append(el("p", (itemLabels[item.type] ?? "참고") + " · " + item.summary));
      const details = el("details");
      details.append(el("summary", "원문 근거"));
      const list = el("ul");
      for (const ref of item.basis) {
        const entry = el("li");
        const link = noticeLink(officialAttachmentUrl(ref.sourceUrl), ref.filename);
        entry.append(link ?? el("span", ref.filename), " · " + locationLabel(ref.location), el("blockquote", ref.quote));
        list.append(entry);
      }
      details.append(list);
      claim.append(details);
      section.append(claim);
    }
    body.append(section);
  }
}

async function runAnalysis(context, controller) {
  const signal = controller.signal;
  const current = () => active === controller && dialog.open && !signal.aborted;
  const { notice, approval, key } = context;
  accessForm.hidden = true;
  const budget = { remaining: 24 * 1024 * 1024 };
  const approved = [];
  const unavailable = [];
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
  for (const doc of approval.documents) {
    if (!current()) return;
    status.textContent = "원본 확인 및 텍스트 읽는 중 · " + doc.filename;
    try {
      const extracted = await readApprovedAttachment(notice, doc, budget, readSignal);
      const texts = selectApprovedExcerpts(extracted.parts, doc.segments);
      if (await excerptDigest(texts) !== doc.sha256) throw Error("version_mismatch");
      approved.push({ id: doc.id, texts });
    } catch (error) {
      unavailable.push([doc.filename, errors[error.message] ?? reasonLabels[error.message] ?? "문서를 읽지 못했습니다."]);
    }
  }
  if (!current()) return;
  if (!approved.length) {
    status.textContent = "전송할 수 있는 승인된 원문 발췌를 읽지 못했습니다.";
    const list = el("ul");
    for (const [name, reason] of unavailable) list.append(el("li", name + " · " + reason));
    body.replaceChildren(list);
    return;
  }
  status.textContent = "승인된 발췌를 Gemini로 분석하고 있습니다…";
  try {
    const result = await request("/v1/analyze", {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(32_000)]),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionCode },
      body: JSON.stringify({ notice: key, documents: approved }),
    });
    if (!current()) return;
    status.textContent = result.partial || unavailable.length ? "AI 일부 분석" : "AI 분석 결과";
    render(result, unavailable);
  } catch (error) {
    if (!current()) return;
    if (error.message === "access_required") {
      sessionCode = undefined;
      accessForm.hidden = false;
      accessInput.focus();
    }
    status.textContent = errors[error.message] ?? errors.service_unavailable;
  } finally {
    approved.length = 0;
  }
}

async function open(notice) {
  active?.abort();
  const controller = active = new AbortController();
  selection = undefined;
  const key = notice.noticeId + ":" + notice.revision;
  byId("ai-report-notice").textContent = cellValue(notice, "공고명");
  body.replaceChildren();
  accessForm.hidden = true;
  accessInput.value = "";
  status.textContent = "외부 분석을 허용한 문서인지 확인하는 중입니다…";
  if (!dialog.open) dialog.showModal();
  try {
    const approval = await request("/v1/approval?" + new URLSearchParams({ notice: key }), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
    });
    if (active !== controller || !dialog.open) return;
    selection = { notice, key, approval };
    if (sessionCode) await runAnalysis(selection, controller);
    else {
      accessForm.hidden = false;
      accessInput.focus();
      status.textContent = "허용된 문서입니다. 데모 접근 코드를 입력하면 분석합니다.";
    }
  } catch (error) {
    if (active === controller && dialog.open) {
      status.textContent = errors[error.message] ?? errors.service_unavailable;
    }
  }
}

export function aiReportButton(notice) {
  const button = el("button", "AI 공고문 분석");
  button.className = "attachment-button";
  button.type = "button";
  button.disabled = typeof notice.noticeId !== "string" || typeof notice.revision !== "string";
  if (!button.disabled) button.addEventListener("click", () => void open(notice));
  return button;
}

accessForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selection || !dialog.open) return;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(accessInput.value)) {
    status.textContent = errors.access_required;
    return;
  }
  sessionCode = accessInput.value;
  accessInput.value = "";
  active?.abort();
  const controller = active = new AbortController();
  void runAnalysis(selection, controller);
});
byId("ai-report-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  active?.abort();
  selection = undefined;
  accessInput.value = "";
  body.replaceChildren();
});
