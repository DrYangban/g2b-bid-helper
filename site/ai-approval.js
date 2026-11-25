export function normalizeExcerpt(text) {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

const hiddenText = "[가림]";
const sensitivePatterns = [
  /[\w.+%'-]+\s*[@＠]\s*[\w-]+(?:\s*\.\s*[\w-]+)+/gu,
  /(?<!\d)(?:\+82[\s().-]*(?:0[\s().-]*)?|0)(?:1[016789]|2|[3-6][1-5]|70|80|50[2-8])[\s().-]*\d{3,4}[\s().-]*\d{4}(?!\d)/gu,
  /(?<!\d)\d{6}[\s-]+[1-8]\d{6}(?!\d)/gu,
  /((?:담당자(?:명|\s*성명)?|연락담당|성명|주무관|책임자)\s*[:：=]\s*)(?:[가-힣]{2,5}(?![가-힣])|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gu,
  /((?:계좌번호|여권번호|비밀번호|접속\s*토큰)\s*[:：=]\s*)[A-Za-z0-9][\w.+/=-]+/gu,
];

export function redactApprovedText(text, spans = []) {
  if (!Array.isArray(spans)) throw Error("version_mismatch");
  let cursor = 0;
  let filtered = "";
  for (const span of spans) {
    if (!Array.isArray(span) || span.length !== 2) throw Error("version_mismatch");
    const [start, end] = span;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < cursor || end <= start || end > text.length) {
      throw Error("version_mismatch");
    }
    filtered += text.slice(cursor, start) + hiddenText;
    cursor = end;
  }
  filtered += text.slice(cursor);
  for (const pattern of sensitivePatterns) {
    filtered = filtered.replace(pattern, (_, label) => (typeof label === "string" ? label : "") + hiddenText);
  }
  return normalizeExcerpt(filtered);
}

export async function excerptDigest(texts) {
  const bytes = new TextEncoder().encode(JSON.stringify(texts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function selectApprovedExcerpts(parts, segments) {
  return segments.map(({ location, start, end, redactions }) => {
    const at = Object.entries(location);
    if (!at.length || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end <= start || end - start > 4_000) throw Error("version_mismatch");
    const part = parts.find((candidate) => at.every(([key, value]) => candidate[key] === value));
    if (!part) throw Error("version_mismatch");
    const text = normalizeExcerpt(part.text);
    if (end > text.length) throw Error("version_mismatch");
    return redactApprovedText(text.slice(start, end), redactions);
  });
}

export const aiSections = Object.freeze({
  scope: "사업 목적과 주요 업무",
  budget: "사업 예산 및 금액 조건",
  period: "사업 수행 기간",
  eligibility: "입찰 참가 자격",
  restrictions: "지역 및 업종 제한",
  licenses: "면허·인증서·자격증",
  experience: "기업 규모와 수행 실적",
  personnel: "인력 및 경력 조건",
  documents: "제출서류와 제출 방법",
  schedule: "입찰 마감과 주요 일정",
  evaluation: "평가 기준과 배점",
  cooperation: "공동수급 및 하도급",
  risks: "계약상 위험 요소와 주의사항",
  review: "AI 종합 검토 의견",
});
