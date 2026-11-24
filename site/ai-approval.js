export function normalizeExcerpt(text) {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export async function excerptDigest(texts) {
  const bytes = new TextEncoder().encode(JSON.stringify(texts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function selectApprovedExcerpts(parts, segments) {
  return segments.map(({ location, start, end }) => {
    const at = Object.entries(location);
    if (!at.length || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end <= start || end - start > 4_000) throw Error("version_mismatch");
    const part = parts.find((candidate) => at.every(([key, value]) => candidate[key] === value));
    if (!part) throw Error("version_mismatch");
    const text = normalizeExcerpt(part.text);
    if (end > text.length) throw Error("version_mismatch");
    return text.slice(start, end).trim();
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
