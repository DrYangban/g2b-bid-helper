import { cellValue, noticeLink } from "./bid-ui.js";
import { previewDocument, reasonLabels, warningLabels } from "./attachment-preview.js?v=5b1";
import { loadAttachments, officialAttachmentUrl } from "./attachment-source.js?v=5b1";

const byId = (id) => document.getElementById(id);
const statusLabels = {
  success: "표본 추출 성공",
  partial: "표본 일부 추출",
  failed: "표본 추출 실패",
  untested: "자동 시험 대상 아님",
  unsupported: "추출 지원 형식 아님",
};
let openNotice = 0;
let localPreview;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function fileRow(item) {
  const row = document.createElement("li");
  row.append(element("strong", item.filename));
  const description = [item.category || "기타", item.format?.toUpperCase() || "형식 미확인"];
  row.append(element("p", description.join(" · "), "form-note"));
  const extraction = item.extraction ?? {};
  const status = statusLabels[extraction.status] ?? statusLabels.untested;
  const notes = [status];
  if (item.download === "downloaded") notes.push("원본 받기 성공");
  if (extraction.units) notes.push("읽은 단위 " + extraction.units + "개");
  if (reasonLabels[extraction.reason]) notes.push(reasonLabels[extraction.reason]);
  row.append(element("p", notes.join(" · "), "form-note"));
  const original = noticeLink(officialAttachmentUrl(item.sourceUrl), "원본 열기·다운로드");
  if (original) row.append(original);
  else row.append(element("p", "확인된 원본 주소가 없습니다. 공고 원문을 확인하세요.", "form-note"));
  const warnings = (extraction.warnings ?? []).map((id) => warningLabels[id]).filter(Boolean);
  if (warnings.length) row.append(element("p", warnings.join(" "), "form-note"));
  return row;
}

export function attachmentButton(notice) {
  const button = element("button", "첨부파일", "attachment-button");
  button.type = "button";
  const id = notice.noticeId;
  const revision = notice.revision;
  button.disabled = typeof id !== "string" || typeof revision !== "string";
  if (!button.disabled) button.addEventListener("click", () => showAttachments(notice));
  return button;
}

async function showAttachments(notice) {
  const active = ++openNotice;
  const dialog = byId("attachment-dialog");
  const list = byId("attachment-files");
  const status = byId("attachment-status");
  clearPreview();
  byId("attachment-notice-title").textContent = cellValue(notice, "공고명");
  const noticeSource = noticeLink(cellValue(notice, "공고 상세 링크"), "공고 원문 열기");
  byId("attachment-notice-link").replaceChildren(...(noticeSource ? [noticeSource] : []));
  list.replaceChildren();
  status.textContent = "첨부파일 목록을 불러오는 중입니다…";
  if (!dialog.open) dialog.showModal();
  try {
    const files = await loadAttachments(notice);
    if (active !== openNotice || !dialog.open) return;
    status.textContent = files?.length ? "첨부파일 " + files.length + "개" :
      "연결된 첨부파일 자료가 없습니다. 공고 원문에서 확인하세요.";
    if (files?.length) list.append(...files.map(fileRow));
  } catch {
    if (active === openNotice && dialog.open) {
      status.textContent = "첨부파일 목록을 불러오지 못했습니다. 공고 원문에서 확인하세요.";
    }
  }
}

function clearPreview() {
  localPreview?.abort();
  localPreview = undefined;
  byId("local-attachment-file").value = "";
  byId("local-attachment-output").replaceChildren();
  byId("local-attachment-state").textContent = "";
}

function partLabel(part) {
  if (part.page) return part.page + "쪽";
  if (part.line) return part.line + "번째 줄";
  return (part.section ? "구역 " + part.section + " · " : "") + "문단 " + part.paragraph;
}

byId("attachment-close").addEventListener("click", () => byId("attachment-dialog").close());
byId("attachment-dialog").addEventListener("close", () => {
  openNotice++;
  clearPreview();
});
byId("local-attachment-file").addEventListener("change", async (event) => {
  localPreview?.abort();
  const file = event.target.files[0];
  const output = byId("local-attachment-output");
  const status = byId("local-attachment-state");
  output.replaceChildren();
  if (!file) {
    status.textContent = "";
    return;
  }
  const controller = new AbortController();
  localPreview = controller;
  status.textContent = "이 브라우저에서 읽는 중입니다…";
  try {
    const { parts, warnings } = await previewDocument(file, controller.signal);
    if (controller.signal.aborted) return;
    status.textContent = file.name + " · " + parts.length + "개 읽음";
    if (warnings.length) output.append(element("p", warnings.map((id) => warningLabels[id]).filter(Boolean).join(" "), "form-note"));
    for (const part of parts) {
      const portion = document.createElement("section");
      portion.append(element("h4", partLabel(part)), element("pre", part.text));
      output.append(portion);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      status.textContent = "미리보기 실패 · " + (reasonLabels[error.message] ?? reasonLabels.invalid_document);
    }
  }
});
