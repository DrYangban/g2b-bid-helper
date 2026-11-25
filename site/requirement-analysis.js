import { loadAttachments, officialAttachmentUrl } from "./attachment-source.js?v=5b1";
import { extractAttachment, maxAttachmentBytes, supportedAttachmentFormats, reasonLabels } from "./attachment-preview.js?v=5b1";
import { autoFactCategories, excludedAttachmentName, excludedAttachmentText, factLocation,
  isConversion, maxFactFiles, maxFactRows, pairedOriginal, publicFact } from "./ai-facts.js";

const priorities = ["공고문", "제안요청서", "과업지시서"];
const maxDocuments = 3;
const maxTotalBytes = 24 * 1024 * 1024;
const metadataOnlyWarnings = new Set(["pdf_layout", "table_linear", "body_only"]);
let engine;

function candidates(files) {
  const core = files.filter((item) => priorities.includes(item.category));
  const usable = (items) => items.filter((item) =>
    typeof item.filename === "string" && supportedAttachmentFormats.includes(item.format) && officialAttachmentUrl(item.sourceUrl));
  const primary = usable(core);
  const pool = primary.length ? primary : usable(files);
  const selected = [];
  const seen = new Set();
  for (const item of [...priorities.map((category) => pool.find((file) => file.category === category)), ...pool]) {
    if (!item || seen.has(item.sourceUrl)) continue;
    seen.add(item.sourceUrl);
    selected.push(item);
    if (selected.length === maxDocuments) break;
  }
  return { selected, omitted: (primary.length ? core : files).length - selected.length };
}

function timeBox(parent, milliseconds, code) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Error(code)), milliseconds);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function download(item, budget, parent) {
  const url = officialAttachmentUrl(item.sourceUrl);
  if (!url) throw Error("untrusted_url");
  const time = timeBox(parent, 12_000, "download_timeout");
  let reader;
  try {
    const response = await fetch(url, {
      mode: "cors", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      cache: "no-store", signal: time.signal,
    });
    if (response.status !== 200 || !response.body) throw Error("http_error");
    if (/text\/html|application\/(?:problem\+)?json/i.test(response.headers.get("Content-Type") ?? "")) {
      throw Error("html_instead_of_file");
    }
    const advertised = Number(response.headers.get("Content-Length"));
    if (advertised > maxAttachmentBytes || advertised > budget.remaining) throw Error("file_limit");
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      time.signal.throwIfAborted();
      if (done) break;
      budget.remaining -= value.length;
      length += value.length;
      if (length > maxAttachmentBytes || budget.remaining < 0) throw Error("file_limit");
      chunks.push(value);
    }
    if (!length) throw Error("empty_file");
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    if (/^\s*<(?:!doctype html|html\b)/i.test(new TextDecoder().decode(buffer.subarray(0, 1024)))) {
      throw Error("html_instead_of_file");
    }
    return buffer.buffer;
  } catch (error) {
    time.signal.throwIfAborted();
    if (error instanceof TypeError) throw Error("cors_network");
    throw error;
  } finally {
    if (reader) void reader.cancel().catch(() => {});
    time.close();
  }
}

export async function readApprovedAttachment(notice, approved, budget, signal) {
  const source = officialAttachmentUrl(approved.sourceUrl);
  const files = await loadAttachments(notice);
  const item = files.find((file) => source && officialAttachmentUrl(file.sourceUrl) === source &&
    file.filename === approved.filename && file.format === approved.format);
  if (!item) throw Error("version_mismatch");
  const buffer = await download(item, budget, signal);
  return extractAttachment(buffer, item.format, signal, true);
}

function classify(documents, parent, separate = false) {
  return new Promise((resolve, reject) => {
    parent.throwIfAborted();
    const launch = () => new Worker(new URL("./requirement-rules-worker.js?v=7b1", import.meta.url), { type: "module" });
    const worker = separate ? launch() : (engine ??= launch());
    const time = timeBox(parent, 28_000, "rules_timeout");
    const finish = (error, value) => {
      time.signal.removeEventListener("abort", abort);
      time.close();
      worker.onmessage = null;
      worker.onerror = null;
      if (separate || error) {
        worker.terminate();
        if (!separate) engine = undefined;
      }
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(time.signal.reason);
    time.signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => data.fields ? finish(null, data.fields) : finish(Error("rules_unavailable"));
    worker.onerror = (event) => {
      event.preventDefault();
      finish(Error("rules_unavailable"));
    };
    worker.postMessage({ documents, separate });
  });
}

export async function analyzeNotice(notice, signal, progress) {
  const files = await loadAttachments(notice);
  signal.throwIfAborted();
  if (!files.length) throw Error("no_attachments");
  const { selected, omitted } = candidates(files);
  if (!selected.length) throw Error("no_supported_attachments");
  return analyzeFiles(selected, omitted, download, signal, progress);
}

export async function analyzePublicNotice(notice, signal, progress) {
  const files = (await loadAttachments(notice)).filter(file => autoFactCategories.includes(file.category) &&
    ["pdf","hwp","hwpx","docx"].includes(file.format) && officialAttachmentUrl(file.sourceUrl)).slice(0,24);
  signal.throwIfAborted();
  const pool = files.filter(file => !excludedAttachmentName.test(file.filename));
  const selected = [];
  for (const category of autoFactCategories) {
    const candidates = pool.filter(file => file.category === category);
    const first = candidates.find(isConversion) ?? candidates[0];
    if (!first) continue;
    for (const file of [first, pairedOriginal(first, candidates)]) {
      if (file && selected.length < maxFactFiles) selected.push(file);
    }
  }
  if (!selected.length) throw Error("no_public_files");
  const outcome = await analyzeFiles(selected, files.length - selected.length, download, signal, progress, false, true);
  if (!outcome.facts?.length) throw Error(outcome.reason ?? "no_public_facts");
  return {
    notice: notice.noticeId + ":" + notice.revision,
    files: selected.map(({sourceUrl}, index) => [sourceUrl, outcome.documents[index].state.status === "failed" ?
      outcome.documents[index].state.reason === "restricted" ? "restricted" : "unreadable" : outcome.documents[index].state.status]),
    facts: outcome.facts,
  };
}

function supplementalFacts(parts, doc) {
  const patterns = [
    ["task","web",/웹서비스.{0,16}(?:구축|확장|개선)|웹사이트.{0,16}(?:구축|개선)/u],
    ["task","maintenance",/정보시스템.{0,12}유지\s*(?:관리|보수)/u],
    ["task","cleaning",/건물\s*청소|환경미화|청소\s*용역/u],
    ["task","inspection",/안전\s*(?:점검|진단)/u],
    ["task","shuttle",/(?:통학|통근)\s*(?:버스|차량|운행)/u],
    ["task","education",/교육\s*프로그램.{0,15}운영/u],
    ["task","video",/홍보\s*영상.{0,12}제작/u],
    ["task","survey",/설문\s*조사.{0,14}분석/u],
    ["submissionMethod","g2b",/(?:제출\s*방법|제안서.{0,15}제출|입찰서.{0,15}제출).{0,38}(?:나라장터.{0,18}제출|전자\s*제출|온라인\s*제출)/u],
    ["submissionMethod","visit",/제출\s*방법\s*[:：]?\s*(?:직접\s*)?방문\s*제출/u],
    ["companySize","small",/(?:입찰\s*참가자격.{0,60})?소기업.{0,8}소상공인\s*확인서.{0,30}(?:소지|보유)(?:한|하여야)/u],
    ["risk","missingInvalid",/(?:입찰서와\s*제안서|제안서와\s*입찰서).{0,45}미제출.{0,15}입찰\s*무효/u],
    ["risk","priceAbove",/입찰가격.{0,48}사업금액.{0,42}초과.{0,38}협상.{0,15}제외/u],
  ];
  const rows = [];
  for (const { text, ...pos } of parts) {
    const normalized = text.replace(/\s+/gu," ");
    const at = [{ doc, ...pos }];
    for (const [type,value,pattern] of patterns) if (pattern.test(normalized)) rows.push({type,value,at});
    for (const [type,pattern] of [
      ["productCode", /직접\s*생산.{0,90}세부품명\s*(?:번호|코드)?\s*[:：]?\s*([2-9]\d{9})(?!\d)/u],
      ["staffCount", /(?:투입\s*인력|필수\s*인력).{0,25}?(\d{1,3})\s*명\s*이상/u],
      ["staffYears", /(?:책임\s*인력|총괄\s*책임자|전담\s*인력).{0,35}?경력.{0,10}?(\d{1,2})\s*년\s*이상/u],
    ]) {
      const match = pattern.exec(normalized);
      if (match) rows.push({type,value:type === "productCode" ? match[1] : Number(match[1]),at});
    }
  }
  return rows;
}

function reportFacts(fieldGroups, files, documents, extracts) {
  const merged = new Map();
  const findings = [...fieldGroups.flatMap((fields,doc) => Object.values(fields).filter(field => field.status === "found")
    .flatMap(field => field.findings.map(item => ({...item,at:item.at.map(at => ({...at,doc}))})))),
    ...extracts.flatMap(({parts}, doc) => supplementalFacts(parts, doc))];
  for (const {type,value,at} of findings) {
    if (!publicFact(type,value)) continue;
    const key = JSON.stringify([type,value]);
    if (!merged.has(key)) merged.set(key,{type,value,at:[]});
    merged.get(key).at.push(...at);
  }
  const rows = [];
  for (const {type,value,at} of merged.values()) {
    const usable = at.filter(({doc}) => {
      const original = pairedOriginal(files[doc], files);
      const index = files.indexOf(original);
      if (index < 0) return true;
      const state = documents[index].state;
      return state.reason !== "restricted" && (!state.units || at.some(location => location.doc === index));
    });
    const preferred = usable.find(({doc}) => isConversion(files[doc])) ?? usable[0];
    if (!preferred) continue;
    const {doc,page,section,paragraph} = preferred;
    const where = page ? [page] : [section ?? 0,paragraph];
    if (factLocation(where)) rows.push([type,value,doc,where]);
  }
  const single = new Set(["budget","estimate","base","duration","dateRange","endDate","proposalDeadline","bidDeadline","opening","joint","subcontract"]);
  const counts = new Map();
  for (const [type] of rows) counts.set(type,(counts.get(type) ?? 0)+1);
  return rows.filter(([type]) => !single.has(type) || counts.get(type) === 1).slice(0,maxFactRows);
}

export async function analyzeUploaded(files, signal, progress) {
  if (!files.length) throw Error("no_attachments");
  if (files.length > maxDocuments) throw Error("file_count_limit");
  const selected = files.map((file) => ({
    filename: file.name, format: file.name.split(".").pop().toLowerCase(), category: "직접 선택", sourceUrl: null, file,
  }));
  return analyzeFiles(selected, 0, async ({ file }, budget) => {
    if (file.size > maxAttachmentBytes || file.size > budget.remaining) throw Error("file_limit");
    if (!file.size) throw Error("empty_file");
    budget.remaining -= file.size;
    return file.arrayBuffer();
  }, signal, progress, true);
}

async function analyzeFiles(selected, omitted, readBuffer, signal, progress, manual = false, publicOnly = false) {
  const documents = selected.map(({ filename, format, category, sourceUrl }) => ({ filename, format, category, sourceUrl }));
  const extracts = selected.map(() => ({ parts: [] }));
  const budget = { remaining: maxTotalBytes };
  const readTime = timeBox(signal, 40_000, "extraction_timeout");
  let next = 0;
  let completed = 0;

  async function readNext() {
    while (next < selected.length && !signal.aborted) {
      const index = next++;
      const item = selected[index];
      const document = documents[index];
      let downloaded = false;
      let phase = "download";
      try {
        if (!manual) progress("download", item.filename, completed, selected.length);
        let buffer = await readBuffer(item, budget, readTime.signal);
        downloaded = !manual;
        phase = "read";
        progress("read", item.filename, completed, selected.length);
        const extracted = await extractAttachment(buffer, item.format, readTime.signal, true);
        buffer = undefined;
        if (publicOnly && extracted.parts.some(({text}) => excludedAttachmentText.test(text) ||
            excludedAttachmentText.test(text.replace(/\s+/gu," ")))) {
          document.state = {status:"failed",reason:"restricted",warnings:[],units:0,downloaded};
          completed++;
          continue;
        }
        extracts[index] = { parts: extracted.parts };
        const warnings = extracted.warnings;
        document.state = {
          status: warnings.some((warning) => !metadataOnlyWarnings.has(warning)) ? "partial" : "success",
          reason: null, warnings, units: extracted.parts.length, downloaded,
        };
      } catch (error) {
        if (signal.aborted) return;
        const code = error?.message;
        document.state = {
          status: "failed", reason: Object.hasOwn(reasonLabels, code) ? code : phase === "read" ? "parser_error" : "cors_network",
          warnings: [], units: 0, downloaded,
        };
      }
      completed++;
      progress("done", item.filename, completed, selected.length);
    }
  }

  try {
    await Promise.all([readNext(), readNext()]);
  } finally {
    readTime.close();
  }
  signal.throwIfAborted();
  const base = { documents, omitted, browser: true, manual };
  if (documents.every((item) => !item.state.units)) return { ...base, status: "failed" };
  progress("rules", "", completed, selected.length);
  try {
    const fields = await classify(extracts, signal, publicOnly);
    const result = { ...base, status: omitted || documents.some((item) => item.state.status !== "success") ? "partial" : "processed" };
    if (publicOnly) result.facts = reportFacts(fields, selected, documents, extracts);
    else result.fields = fields;
    return result;
  } catch (error) {
    signal.throwIfAborted();
    return { ...base, status: "failed", reason: error.message === "rules_timeout" ? error.message : "rules_unavailable" };
  }
}
