const maxFile = 12 * 1024 * 1024;
const maxCharacters = 24_000;
const maxParts = 200;

export const reasonLabels = {
  browser_unsupported: "이 브라우저에서는 문서 압축을 풀 수 없습니다.",
  download_timeout: "원본 서버에서 제시간에 받지 못했습니다.",
  empty_file: "빈 파일입니다.",
  encrypted: "암호화·배포용 보호가 설정된 문서입니다.",
  expanded_limit: "압축을 푼 문서가 허용 범위를 넘었습니다.",
  extraction_timeout: "문서 읽기 시간 제한을 넘었습니다.",
  file_limit: "12MB 파일 한도 또는 표본 전체 용량 한도를 넘었습니다.",
  html_instead_of_file: "원본 파일 대신 안내 페이지가 돌아왔습니다.",
  http_error: "원본 서버가 정상적인 파일 응답을 반환하지 않았습니다.",
  invalid_document: "문서가 손상됐거나 읽을 수 없는 구조입니다.",
  network_error: "원본 서버에 연결하지 못했습니다.",
  no_text: "읽을 수 있는 본문 텍스트가 없습니다.",
  no_text_layer: "읽을 수 있는 텍스트층이 없습니다. 스캔·이미지 PDF는 OCR이 필요합니다.",
  parser_error: "문서 추출기를 완료하지 못했습니다.",
  too_many_redirects: "원본 주소의 이동 횟수가 제한을 넘었습니다.",
  unsupported: "지원 형식은 PDF, HWP, HWPX, DOCX, TXT입니다.",
  unsafe_archive: "안전하지 않은 압축 경로나 XML 정의를 차단했습니다.",
  untrusted_url: "허용된 나라장터 HTTPS 원본 주소를 확인할 수 없습니다.",
  wrong_format: "파일 내용이 표시된 형식과 일치하지 않습니다.",
};

export const warningLabels = {
  body_only: "본문 위주로 표시합니다. 머리말·각주·서식 등은 빠질 수 있습니다.",
  images_skipped: "이미지와 이미지 속 글자는 읽지 않았습니다.",
  page_limit: "페이지 읽기 상한에 도달했습니다.",
  page_without_text: "일부 페이지에 읽을 수 있는 텍스트층이 없습니다.",
  pdf_layout: "PDF의 표, 다단 배치, 줄 순서는 원본과 다를 수 있습니다.",
  table_linear: "표의 텍스트를 순서대로 표시합니다. 셀 경계와 병합은 원본을 확인하세요.",
  text_limit: "미리보기 또는 추출 범위 상한에 도달했습니다.",
  unmapped_characters: "일부 글자를 읽지 못해 대체 문자나 글꼴 번호가 남았습니다.",
  unreadable_page: "일부 페이지를 읽지 못했습니다.",
};

function previewBuilder() {
  const parts = [];
  const warnings = new Set();
  let remaining = maxCharacters;
  return {
    parts, warnings,
    add(text, location) {
      const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
      if (!clean) return true;
      if (parts.length >= maxParts || remaining === 0) {
        warnings.add("text_limit");
        return false;
      }
      const portion = clean.slice(0, remaining);
      if (portion.length < clean.length) warnings.add("text_limit");
      if (/\ufffd|\(cid:\d+\)/.test(portion)) warnings.add("unmapped_characters");
      parts.push({ ...location, text: portion });
      remaining -= portion.length;
      return remaining > 0;
    },
  };
}

function pdfPreview(buffer, result, signal) {
  return (async () => {
    const { getDocument, GlobalWorkerOptions } = await import("./vendor/pdfjs/pdf.min.mjs");
    signal?.throwIfAborted();
    GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
    const task = getDocument({
      data: buffer,
      cMapUrl: new URL("./vendor/pdfjs/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
      useWasm: false,
      isEvalSupported: false,
      enableXfa: false,
    });
    const cancel = () => { void task.destroy().catch(() => {}); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, 15_000);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const pdf = await task.promise;
      result.warnings.add("pdf_layout");
      if (pdf.numPages > 20) result.warnings.add("page_limit");
      for (let page = 1; page <= Math.min(pdf.numPages, 20); page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        const text = content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : " ")).join("");
        if (!text.trim()) result.warnings.add("page_without_text");
        if (!result.add(text, { page })) break;
      }
      if (!result.parts.length) throw Error("no_text_layer");
    } catch (error) {
      if (timedOut) throw Error("extraction_timeout");
      if (error.name === "PasswordException") throw Error("encrypted");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      await task.destroy().catch(() => {});
    }
  })();
}

function readContainer(buffer, format, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL("./attachment-binary-worker.js", import.meta.url));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => { cleanup(); reject(Error("extraction_timeout")); };
    const timer = setTimeout(abort, 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      cleanup();
      if (data.error) reject(Error(data.error));
      else resolve(data);
    };
    worker.onerror = () => { cleanup(); reject(Error("parser_error")); };
    worker.postMessage({ buffer, format }, [buffer]);
  });
}

function addXmlParts(files, result) {
  const ignored = new Set(["drawing", "pict", "pic", "object", "del", "moveFrom"]);
  const pushChildren = (stack, node) => {
    for (let child = node.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
  };
  for (const file of files) {
    const document = new DOMParser().parseFromString(file.text, "application/xml");
    if (document.querySelector("parsererror")) throw Error("invalid_document");
    const stack = [document.documentElement];
    let paragraph = 0;
    while (stack.length) {
      const node = stack.pop();
      const tag = node.localName;
      if (ignored.has(tag)) continue;
      if (tag === "tbl") result.warnings.add("table_linear");
      if (tag === "p") {
        paragraph++;
        const inline = [];
        const chunks = [];
        pushChildren(inline, node);
        while (inline.length) {
          const child = inline.pop();
          const kind = child.localName;
          if (kind === "t") chunks.push(child.textContent);
          else if (["tab", "br", "lineBreak"].includes(kind)) chunks.push(kind === "tab" ? "\t" : "\n");
          else if (kind !== "p" && kind !== "tbl" && !ignored.has(kind)) pushChildren(inline, child);
        }
        if (!result.add(chunks.join(""), { section: file.section, paragraph })) return;
      }
      pushChildren(stack, node);
    }
  }
}

function txtPreview(buffer, result) {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    if (encoding !== "utf-8") throw Error("invalid_document");
    text = new TextDecoder("euc-kr", { fatal: true }).decode(buffer);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|^\s*<(?:!doctype html|html\b)/i.test(text)) throw Error("wrong_format");
  const lines = text.split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    if (!result.add(lines[line], { line: line + 1 })) break;
  }
}

export async function previewDocument(file, signal) {
  const format = file.name.split(".").pop().toLowerCase();
  if (!["pdf", "hwp", "hwpx", "docx", "txt"].includes(format)) throw Error("unsupported");
  if (file.size > maxFile) throw Error("file_limit");
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  const result = previewBuilder();
  if (format === "pdf") {
    if (!new TextDecoder().decode(buffer.slice(0, 1024)).includes("%PDF-")) throw Error("wrong_format");
    await pdfPreview(buffer, result, signal);
  } else if (format === "txt") {
    txtPreview(buffer, result);
  } else {
    const container = await readContainer(buffer, format, signal);
    container.warnings.forEach((warning) => result.warnings.add(warning));
    if (container.xml) addXmlParts(container.xml, result);
    else for (const { text, ...location } of container.parts) result.add(text, location);
  }
  if (!result.parts.length) throw Error("no_text");
  return { parts: result.parts, warnings: [...result.warnings] };
}
