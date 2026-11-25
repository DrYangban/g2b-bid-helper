import { cellValue, noticeLink } from "./bid-ui.js";
import { officialAttachmentUrl } from "./attachment-source.js?v=5b1";
import { reasonLabels } from "./attachment-preview.js?v=5b1";
import { analyzePublicNotice, readApprovedAttachment } from "./requirement-analysis.js?v=7b1";
import { aiSections, excerptDigest, selectApprovedExcerpts } from "./ai-approval.js?v=6b3";

const service = "https://g2b-bid-helper-ai.kupaksa.workers.dev";
const byId = (id) => document.getElementById(id);
const dialog = byId("ai-report-dialog");
const status = byId("ai-report-status");
const body = byId("ai-report-body");
const accessForm = byId("ai-access-form");
const accessInput = byId("ai-access-code");
const errors = {
  access_required: "데모 접근 코드가 필요하거나 코드가 맞지 않습니다.",
  not_approved: "이 공고의 첨부파일을 Gemini 무료 서비스에 전송할 수 있는지 아직 검토되지 않았습니다. 필요 요건 확인을 이용할 수 있습니다.",
  attachment_terms_unverified: "공고 정보는 공개돼 있지만, 첨부파일의 외부 AI 전송 이용조건을 확인하지 못했습니다. 필요 요건 확인을 이용할 수 있습니다.",
  license_scope_unverified: "첨부의 이용표시가 외부 AI 전송, 보고서 요약, 제공자의 서비스 개선까지 허용하는지 확인하지 못했습니다. 필요 요건 확인을 이용할 수 있습니다.",
  sensitive_input: "보내려는 발췌에 개인정보 또는 민감정보로 보이는 내용이 남아 분석을 멈췄습니다.",
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
  no_public_files: "현재 공개 목록에서 분석할 수 있는 첨부를 확인하지 못했습니다.",
  no_public_facts: "문서를 확인했지만 전송할 수 있는 공개 사실 항목을 추출하지 못했습니다.",
  public_index_unavailable: "공개 첨부 목록을 잠시 불러올 수 없습니다.",
  attachment_index_unavailable: "공고와 일치하는 첨부 목록을 불러올 수 없습니다.",
  rules_unavailable: "브라우저의 공개 사실 추출기를 불러올 수 없습니다.",
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
  const overview = el("p", result.publicFacts ?
    (result.mode === "verified" ? "이 공고의 공개 사실을 바탕으로 Gemini가 생성했고, 확인을 마친 요약입니다." :
      result.mode === "reused" ? "확인한 공개 사실이 같아 저장된 Gemini 요약을 다시 열었습니다." :
      "이 공고의 공개 사실을 바탕으로 Gemini가 생성한 요약입니다.") : result.synthetic ?
    "체험용 가상 공고입니다. Gemini가 가상 원문을 분석해 생성한 보고서를 표시합니다." : result.mode === "reused" ?
    "Gemini의 기존 결과를 다시 열었습니다." : "이번 요청에서 Gemini가 생성한 보고서입니다.");
  overview.className = "form-note";
  body.append(overview);
  if (result.partial || unavailable.length) {
    body.append(el("p", result.publicFacts ?
      "일부 범위 분석 · 확인된 공개 사실만 사용했습니다. 미확인 자격·예외·과업 조건은 원본에서 확인하세요." : result.synthetic ?
      "일부 항목의 근거를 검증하지 못했습니다. 아래의 확인 필요 항목을 살펴보세요." :
      "일부 범위 분석 · 승인된 발췌만 사용했습니다. 누락된 문서·표·이미지와 적용 예외는 원문에서 확인하세요."));
  }
  if (result.converted) body.append(el("p", result.automatic ?
    "AI 인식용 변환본 PDF를 우선 읽었습니다. 내용이 다르면 원본이 기준입니다. 아래 처리 범위에서 읽지 못한 원본과 별첨을 확인하세요." :
    "나라장터의 AI 인식용 변환본 PDF를 먼저 읽고 등록 원본과 대조했습니다. 차이가 있으면 원본이 입찰·계약 해석의 기준입니다."));
  if (Array.isArray(result.coverage)) {
    const details = el("details");
    details.append(el("summary", "문서 처리 범위"));
    details.append(el("p", "공고문·제안요청서·과업지시서 중심의 일부 분석입니다. 기타 별첨과 확인되지 않은 예외는 원문에서 확인하세요."));
    const states = {success:"읽음",partial:"일부 읽음",restricted:"이용 제한 표시로 제외",unreadable:"읽지 못함"};
    const list = el("ul");
    for (const file of result.coverage) list.append(el("li", file.filename + " · " + states[file.state] +
      (file.used ? " · 사실 근거 사용" : "")));
    if (result.omittedDocuments) list.append(el("li", "처리 범위에 포함하지 않은 첨부 " + result.omittedDocuments + "건"));
    details.append(list);
    body.append(details);
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
    if (!items.length) section.append(el("p", result.publicFacts ?
      "확인 필요 · 이 요약에 사용한 공개 항목에는 확인된 값이 없습니다." : "확인 필요 · 전달한 문서 범위에서 근거를 확인하지 못했습니다."));
    for (const item of items) {
      const claim = el("div");
      claim.className = "ai-claim";
      claim.append(el("p", (itemLabels[item.type] ?? "참고") + " · " + item.summary));
      const details = el("details");
      details.append(el("summary", result.publicFacts ? "대조한 공개 항목과 출처" : "원문 근거"));
      const list = el("ul");
      for (const ref of item.basis) {
        const entry = el("li");
        const link = noticeLink(officialAttachmentUrl(ref.sourceUrl), ref.filename);
        entry.append(link ?? el("span", ref.filename), " · " + locationLabel(ref.location));
        const original = noticeLink(officialAttachmentUrl(ref.originalUrl), "등록 원본");
        if (original) entry.append(" · ", original);
        entry.append(el(result.publicFacts ? "p" : "blockquote", ref.quote));
        if (ref.attribution) {
          const credit = el("p", ref.attribution + " ");
          const permissionLink = noticeLink(ref.permissionUrl, "이용조건 근거");
          if (permissionLink) credit.append(permissionLink);
          entry.append(credit);
        }
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
  let automaticPayload;
  if (approval.automatic) {
    try {
      automaticPayload = await analyzePublicNotice(notice, signal, (stage, filename) => {
        if (!current()) return;
        status.textContent = stage === "rules" ? "브라우저에서 공개 사실을 추출하고 있습니다…" :
          "공개 첨부 읽는 중 · " + filename;
      });
    } catch (error) {
      if (current()) status.textContent = errors[error.message] ?? "공개 문서에서 분석용 사실을 읽지 못했습니다.";
      return;
    }
  }
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
  for (const doc of approval.documents ?? []) {
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
  if (!approval.publicFacts && !approved.length) {
    status.textContent = "전송할 수 있는 승인된 원문 발췌를 읽지 못했습니다.";
    const list = el("ul");
    for (const [name, reason] of unavailable) list.append(el("li", name + " · " + reason));
    body.replaceChildren(list);
    return;
  }
  status.textContent = approval.publicFacts ? "대조한 공개 사실을 Gemini로 정리하고 있습니다…" : "승인된 발췌를 Gemini로 분석하고 있습니다…";
  try {
    const result = await request("/v1/analyze", {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionCode },
      body: JSON.stringify(automaticPayload ?? (approval.publicFacts ? { notice: key } : { notice: key, documents: approved })),
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
  status.textContent = "공개 첨부의 분석 범위를 확인하는 중입니다…";
  if (!dialog.open) dialog.showModal();
  try {
    const approval = await request("/v1/approval?" + new URLSearchParams({ notice: key, public: "1" }), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
    });
    if (active !== controller || !dialog.open) return;
    if (approval.publicFacts && approval.report?.publicFacts) {
      status.textContent = "공개 사실 AI 요약";
      render(approval.report, []);
      return;
    }
    selection = { notice, key, approval };
    if (sessionCode) await runAnalysis(selection, controller);
    else {
      accessForm.hidden = false;
      accessInput.focus();
      status.textContent = approval.automatic ? "접근 코드를 입력하면 공개 첨부에서 사실을 읽고 요약합니다." :
        approval.publicFacts ? "대조한 공개 사실이 있습니다. 접근 코드를 입력하면 요약합니다." :
        "허용된 문서입니다. 데모 접근 코드를 입력하면 분석합니다.";
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

byId("ai-demo-button").addEventListener("click", async () => {
  active?.abort();
  const controller = active = new AbortController();
  selection = undefined;
  body.replaceChildren();
  accessForm.hidden = true;
  accessInput.value = "";
  byId("ai-report-notice").textContent = "가상 공고 체험";
  status.textContent = "가상 공고의 AI 보고서를 불러오는 중입니다…";
  if (!dialog.open) dialog.showModal();
  try {
    const { demoReport: result } = await import("./ai-demo-result.js?v=6b2");
    if (active !== controller || !dialog.open) return;
    byId("ai-report-notice").textContent = result.title;
    status.textContent = result.partial ? "가상 공고 · AI 일부 분석" : "가상 공고 · AI 분석 결과";
    render(result, []);
  } catch (error) {
    if (active === controller && dialog.open) status.textContent = "가상 공고의 보고서를 불러오지 못했습니다.";
  }
});

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
