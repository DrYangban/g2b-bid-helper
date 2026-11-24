/* ZIP and HWP containers are parsed in a disposable worker. */
const maxFile = 12 * 1024 * 1024;
const maxExpanded = 12 * 1024 * 1024;
const maxText = 24_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const little = new TextDecoder("utf-16le");
const hwpWideControls = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

async function inflate(bytes, ceiling) {
  if (!("DecompressionStream" in self)) throw Error("browser_unsupported");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > ceiling) throw Error("expanded_limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function isOle(bytes) {
  return [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value);
}

async function xmlFiles(bytes, format) {
  if (isOle(bytes) && format === "docx") {
    importScripts("./vendor/cfb/cfb.min.js");
    if (CFB.find(CFB.read(bytes, { type: "array" }), "EncryptedPackage")) throw Error("encrypted");
  }
  const view = new DataView(bytes.buffer);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) throw Error("wrong_format");
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 &&
        end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65_557)) throw Error("invalid_document");
  const entries = view.getUint16(end + 10, true);
  const centralLength = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
      entries > 2000 || offset + centralLength > end) throw Error("unsafe_archive");
  const selected = [];
  const names = new Set();
  let claimed = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw Error("invalid_document");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength) throw Error("invalid_document");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = (flags & 0x800 ? utf8 : new TextDecoder("windows-1252")).decode(rawName);
    if (/^\/|\\|:|\0/.test(name) || name.split("/").includes("..") || names.has(name)) throw Error("unsafe_archive");
    names.add(name);
    claimed += size;
    if (claimed > 96 * 1024 * 1024) throw Error("expanded_limit");
    offset = next;
    if (!(format === "docx" ? name === "word/document.xml" : /^Contents\/section\d+\.xml$/.test(name))) continue;
    if (flags & 1) throw Error("encrypted");
    if (local + 30 > end || view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 6, true) & 1 ||
        view.getUint16(local + 8, true) !== method) throw Error("invalid_document");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressed > end || ![0, 8].includes(method)) throw Error("invalid_document");
    selected.push({ name, method, start, compressed, size });
  }
  if (!selected.length) throw Error("wrong_format");
  if (selected.length > 60 || selected.reduce((sum, file) => sum + file.size, 0) > maxExpanded) throw Error("expanded_limit");
  const sectionNumber = (item) => Number(item.name.match(/\d+/)?.[0] ?? 0);
  const xml = [];
  for (const file of selected.sort((a, b) => sectionNumber(a) - sectionNumber(b))) {
    const raw = bytes.subarray(file.start, file.start + file.compressed);
    const inside = file.method === 8 ? await inflate(raw, file.size) : raw;
    if (inside.length !== file.size) throw Error("invalid_document");
    const encoding = inside[0] === 255 && inside[1] === 254 ? "utf-16le" : inside[0] === 254 && inside[1] === 255 ? "utf-16be" : "utf-8";
    const text = new TextDecoder(encoding, { fatal: true }).decode(inside);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error("unsafe_archive");
    xml.push({ section: format === "hwpx" ? sectionNumber(file) + 1 : null, text });
  }
  return { xml, warnings: ["body_only", ...([...names].some(name => /^(word\/media\/|BinData\/)/.test(name)) ? ["images_skipped"] : [])] };
}

function hwpParagraph(bytes) {
  if (bytes.length % 2) throw Error("invalid_document");
  const result = new Uint8Array(bytes.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let size = 0;
  for (let offset = 0; offset < bytes.length;) {
    const code = view.getUint16(offset, true);
    if (hwpWideControls.has(code)) {
      if (offset + 16 > bytes.length) throw Error("invalid_document");
      if (code === 9) { result[size++] = 9; result[size++] = 0; }
      offset += 16;
      continue;
    }
    if (code >= 32 || [10, 13, 30, 31].includes(code)) {
      result[size++] = code < 30 ? 10 : code < 32 ? 32 : bytes[offset];
      result[size++] = code < 32 ? 0 : bytes[offset + 1];
    }
    offset += 2;
  }
  return little.decode(result.subarray(0, size)).trim();
}

async function hwpParts(bytes) {
  if (!isOle(bytes)) throw Error("wrong_format");
  importScripts("./vendor/cfb/cfb.min.js");
  const doc = CFB.read(bytes, { type: "array" });
  const header = CFB.find(doc, "FileHeader")?.content;
  if (!header || header.length < 40 || header[35] !== 5 ||
      new TextDecoder().decode(new Uint8Array(header).subarray(0, 17)) !== "HWP Document File") throw Error("wrong_format");
  const flags = header[36] + header[37] * 256;
  if (flags & 0x516) throw Error("encrypted");
  const streams = doc.FullPaths.map((name, i) => ({ name, entry: doc.FileIndex[i] }))
    .filter(({ name }) => /\/BodyText\/Section\d+$/.test(name));
  const section = ({ name }) => Number(name.match(/\d+$/)[0]) + 1;
  streams.sort((a, b) => section(a) - section(b));
  if (streams.length > 60) throw Error("expanded_limit");
  const parts = [];
  const warnings = new Set(["body_only"]);
  let remaining = maxExpanded;
  let length = 0;
  for (const stream of streams) {
    if (stream.entry.content.length > maxFile) throw Error("expanded_limit");
    const raw = new Uint8Array(stream.entry.content);
    const decoded = flags & 1 ? await inflate(raw, remaining) : raw;
    remaining -= decoded.length;
    if (remaining < 0) throw Error("expanded_limit");
    const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.length);
    let offset = 0;
    let paragraph = 0;
    while (offset + 4 <= decoded.length) {
      const header = view.getUint32(offset, true);
      const tag = header & 0x3ff;
      let size = header >>> 20;
      offset += 4;
      if (size === 0xfff) {
        if (offset + 4 > decoded.length) throw Error("invalid_document");
        size = view.getUint32(offset, true);
        offset += 4;
      }
      if (offset + size > decoded.length) throw Error("invalid_document");
      if (tag === 77) warnings.add("table_linear");
      if (tag === 85) warnings.add("images_skipped");
      if (tag === 67) {
        paragraph++;
        if (parts.length >= 200 || length >= maxText) {
          warnings.add("text_limit");
          return { parts, warnings: [...warnings] };
        }
        const full = hwpParagraph(decoded.subarray(offset, offset + size));
        const text = full.slice(0, maxText - length);
        if (full.length > text.length) warnings.add("text_limit");
        if (text) parts.push({ section: section(stream), paragraph, text });
        length += text.length;
      }
      offset += size;
    }
    if (offset !== decoded.length) throw Error("invalid_document");
  }
  return { parts, warnings: [...warnings] };
}

self.onmessage = async ({ data }) => {
  try {
    const bytes = new Uint8Array(data.buffer);
    if (bytes.length > maxFile) throw Error("file_limit");
    if (!["hwp", "hwpx", "docx"].includes(data.format)) throw Error("unsupported");
    const contents = data.format === "hwp" ? await hwpParts(bytes) : await xmlFiles(bytes, data.format);
    self.postMessage(contents);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "invalid_document" });
  }
};
