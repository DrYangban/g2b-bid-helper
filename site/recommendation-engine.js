import { businessRegions, industries, workFields } from "./industry-catalog.js";

export const weights = {
  industry: 25, field: 30, keyword: 15, price: 10, region: 8, license: 7, deadline: 5,
};

const factorLabels = {
  industry: "주요 업종", field: "관심 업무 분야", keyword: "관심 키워드", price: "입찰금액",
  region: "참가 가능 지역", license: "면허·업종 등록", deadline: "마감까지 남은 기간",
};
const day = 86_400_000;
const normalize = (value) => String(value ?? "").normalize("NFKC")
  .toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const matchableFields = workFields.map((field) => ({
  ...field, normalizedAliases: field.aliases.map(normalize),
}));

export function splitPreferences(value) {
  return Array.from(new Set(String(value ?? "").split(/[,;\n，]+/).map((part) => part.trim()).filter(Boolean)));
}

export function parseWon(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return null;
  const digits = text.replaceAll(",", "");
  return digits.length <= 25 ? BigInt(digits) : null;
}

export function priceRange(low, high) {
  const min = parseWon(low);
  const max = parseWon(high);
  const valid = (!String(low ?? "").trim() || min !== null) &&
    (!String(high ?? "").trim() || max !== null) && (min === null || max === null || min <= max);
  return { min, max, valid, active: min !== null || max !== null };
}

export function inPriceRange(amount, range) {
  return (!range.active) || (amount !== null &&
    (range.min === null || amount >= range.min) && (range.max === null || amount <= range.max));
}

export function readBidPrice(notice) {
  for (const [field, label] of [["추정가격(원)", "추정가격"], ["allocatedBudget", "배정예산금액"]]) {
    const value = parseWon(notice[field]);
    if (value !== null && value > 0n) return { value, label };
  }
  return { value: null, label: "확인 필요" };
}

function koreaDeadline(value) {
  const formatted = typeof value === "string" &&
    value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  if (!formatted) return null;
  const [, date, clock] = formatted;
  const millis = Date.parse(date + "T" + clock + "+09:00");
  if (!Number.isFinite(millis)) return null;
  const localIso = new Date(millis + 9 * 3_600_000).toISOString();
  return localIso.startsWith(date + "T" + clock) ? millis : null;
}

export function prepareNotices(notices) {
  const unique = new Map();
  notices.forEach((notice, index) => {
    const key = notice.noticeId ? (notice.type ?? "service") + ":" + notice.noticeId : "row:" + index;
    const old = unique.get(key);
    const revision = Number(notice.revision ?? -1);
    const cancelled = /^취소/.test(notice.noticeKind ?? "");
    if (old && (revision < old.revision || (revision === old.revision && old.cancelled))) return;
    unique.set(key, { notice, revision, cancelled });
  });
  return Array.from(unique.values(), ({ notice, cancelled }) => {
    const samples = [notice["공고명"], ...(Array.isArray(notice.classification) ? notice.classification : [])]
      .map(normalize);
    const matches = (term) => term.length >= 2 && samples.some((sample) => sample.includes(term));
    return {
      notice, cancelled, matches,
      fields: matchableFields.filter((field) => field.normalizedAliases.some(matches)),
      price: readBidPrice(notice),
      deadline: koreaDeadline(notice["입찰마감일"]),
    };
  });
}

function regionName(raw) {
  const text = String(raw).trim().replace(/\s+/g, " ");
  for (const [region, ...aliases] of businessRegions) {
    for (const alias of [region, ...aliases]) {
      if (text === alias) return { region, district: "" };
      if (text.startsWith(alias + " ")) {
        const district = text.slice(alias.length + 1);
        if (/^(?:[가-힣0-9]+[시군구읍면동](?: |$))+$/u.test(district)) return { region, district };
      }
    }
  }
  return null;
}

function checkRegion(conditions, profile) {
  const regions = conditions.permittedRegions ?? [];
  const max = weights.region;
  if (!regions.length) return { note: "참가 가능 지역 자료가 없어 공고 원문의 지역 제한을 확인하세요." };
  if (!profile.region) return { note: "사업장 소재지를 입력하면 참가 가능 지역과 비교할 수 있습니다." };
  if (regions.some((region) => region.trim() === "전국")) {
    return { points: max, note: "참가 가능 지역이 전국으로 등록되어 있습니다." };
  }
  const parsed = regions.map(regionName);
  const sameRegion = parsed.filter((entry) => entry?.region === profile.region);
  const district = normalize(profile.district);
  if (sameRegion.some((entry) => !entry.district || (district && (
    normalize(entry.district) === district || profile.district.trim().startsWith(entry.district + " ")
  )))) {
    return { points: max, note: "입력한 소재지가 API의 참가 가능 지역에 포함됩니다." };
  }
  if (parsed.every(Boolean) && !sameRegion.length) {
    return { mismatch: true, note: "입력한 소재지가 API의 참가 가능 지역과 불일치합니다. 본사·지사 등 적용 기준은 원문을 확인하세요." };
  }
  return { note: "광역지역만으로 일치 여부를 판단할 수 없습니다. 시·군·구와 원문의 소재지 기준을 확인하세요." };
}

function licenseIdentifiers(label) {
  if (!label) return [];
  const tagged = label.match(/^(.+?)\s*(?:\/\s*(\d{4,8})|\(\s*(\d{4,8})\s*\))$/);
  if (!tagged) return [normalize(label)];
  return [normalize(tagged[1]), tagged[2] ?? tagged[3]];
}

function checkLicenses(conditions, licenseText) {
  const rules = conditions.licenses ?? [];
  if (!rules.length) {
    if (conditions.industryLimited === "N") {
      return { points: weights.license, note: "용역 API에 업종 제한 없음으로 표시됩니다." };
    }
    return { note: conditions.industryLimited === "Y" ?
      "업종 제한이 있으며 세부 면허 조건은 원문에서 확인해야 합니다." :
      "면허·업종 제한 정보가 없어 원문 확인이 필요합니다." };
  }
  const held = new Set(splitPreferences(licenseText).flatMap(licenseIdentifiers).filter(Boolean));
  const ruleMatches = rules.map((rule) => {
    const alternatives = Array.from((rule.alternatives ?? "").matchAll(/\[([^\]]+)\]/g), (match) => match[1]);
    return [rule.name, ...alternatives].flatMap(licenseIdentifiers).some((entry) => held.has(entry));
  });
  if (ruleMatches.some(Boolean)) {
    const all = ruleMatches.every(Boolean) && !rules.some((rule) => rule.specialties);
    return { points: all ? weights.license : 4, note: "입력한 면허 이름 또는 코드가 API 목록과 일치합니다. 제한 그룹·주력분야·기타 자격은 원문 확인이 필요합니다." };
  }
  return { note: held.size ?
    "입력한 면허와 일치 항목을 찾지 못했습니다. 누락·대체 면허 등은 원문 확인이 필요합니다." :
    "면허·업종 제한이 있습니다. 보유 면허와 원문 조건을 대조하세요." };
}

function cappedMatchPoints(matches, selected, max) {
  return selected ? Math.round(max * Math.min(matches, Math.min(2, selected)) / Math.min(2, selected)) : 0;
}

function assess(entry, profile, preferences, budget, now) {
  const { notice, fields, matches, price, deadline, cancelled } = entry;
  const matchingIndustries = industries.filter((industry) =>
    profile.industries.includes(industry.id) && fields.some((field) => field.industry === industry.id));
  const matchingFields = fields.filter((field) => profile.fields.includes(field.id)).map((field) => field.label);
  const { custom, terms } = preferences;
  const matchingTerms = terms.filter(([term]) => matches(term)).map(([, label]) => label);
  const matchingAreas = [...matchingFields, ...custom.filter(([term]) => matches(term)).map(([, label]) => label)];
  if (!matchingIndustries.length && !matchingAreas.length && !matchingTerms.length) return null;

  const factors = [];
  const add = (key, points, note) => factors.push({ label: factorLabels[key], points, max: weights[key], note });
  add("industry", matchingIndustries.length ? weights.industry : 0, matchingIndustries.length ?
    matchingIndustries.map((industry) => industry.label).join(", ") + " 관련 업무가 공고 제목 또는 조달분류에 있습니다." :
    "선택한 주요 업종과 공고의 관련 업무가 일치하는 근거를 찾지 못했습니다.");
  add("field", cappedMatchPoints(matchingAreas.length, profile.fields.length + custom.length, weights.field),
    matchingAreas.length ? "일치 분야 " + matchingAreas.join(", ") : "일치하는 관심 업무 분야가 없습니다.");
  add("keyword", cappedMatchPoints(matchingTerms.length, terms.length, weights.keyword),
    matchingTerms.length ? "일치 키워드 " + matchingTerms.join(", ") : "일치하는 관심 키워드가 없습니다.");
  const inside = budget.active && price.value !== null && inPriceRange(price.value, budget);
  add("price", inside ? weights.price : 0, !budget.active ? "관심 금액을 입력하지 않았습니다." :
    price.value === null ? "확인 가능한 금액이 없습니다." :
    inside ? "관심 입찰금액 범위에 포함됩니다." : "관심 입찰금액 범위를 벗어납니다.");
  const conditions = notice.conditions ?? {};
  const region = checkRegion(conditions, profile);
  const license = checkLicenses(conditions, profile.licenses);
  add("region", region.points ?? 0, region.note);
  add("license", license.points ?? 0, license.note);

  const remaining = deadline === null ? null : deadline - now;
  const excluded = cancelled ? "취소 공고" : remaining !== null && remaining <= 0 ? "입찰마감 경과" : "";
  const timePoints = excluded || remaining === null ? 0 : remaining >= 3 * day ? 5 : remaining >= day ? 3 : 1;
  add("deadline", timePoints, excluded || (remaining === null ? "마감일을 확인할 수 없습니다." :
    remaining >= day ? "입찰마감까지 " + Math.floor(remaining / day) + "일 이상 남았습니다." : "입찰마감까지 24시간 미만입니다."));

  const checks = [];
  if (conditions.permittedRegions?.length) checks.push("API 참가 가능 지역 " + conditions.permittedRegions.join(", "));
  if (conditions.regionBasis) checks.push("소재지 기준 " + conditions.regionBasis);
  if (conditions.jointRegionRestricted) checks.push("공동수급 구성원에 지역 제한이 적용됩니다.");
  for (const rule of conditions.licenses ?? []) {
    checks.push([rule.group && "그룹 " + rule.group, rule.name, rule.alternatives && "허용 " + rule.alternatives,
      rule.specialties && "주력분야 " + rule.specialties].filter(Boolean).join(" · "));
  }
  if (conditions.experienceCompetition) checks.push("실적경쟁 공고입니다. 수행 실적은 원문 기준과 증빙을 확인하세요.");
  if (conditions.designatedCompetition) checks.push("지명경쟁 공고입니다. 지명 범위를 확인하세요.");
  if (conditions.participationRestricted) checks.push("입찰 참가 제한이 표시된 공고입니다. 세부 조건은 원문을 확인하세요.");
  if (conditions.prequalification) checks.push("입찰참가자격 사전심사(PQ) 요건을 확인하세요.");
  return {
    ...entry, factors, checks, excluded,
    score: factors.reduce((total, factor) => total + factor.points, 0),
    eligibility: excluded ? "추천 제외 · " + excluded : region.mismatch ? "지역 조건 불일치 · 원문 확인 필요" : "원문 확인 필요",
  };
}

export function rankNotices(entries, profile, filters = {}, now = Date.now()) {
  const budget = priceRange(profile.min, profile.max);
  const range = priceRange(filters.min, filters.max);
  if (!budget.valid || !range.valid) return [];
  const selectedAreas = new Set(workFields.filter((field) => profile.fields.includes(field.id))
    .flatMap((field) => field.aliases.map(normalize)));
  const usable = (text) => Array.from(new Map(splitPreferences(text)
    .map((label) => [normalize(label), label]))).filter(([term]) => term.length >= 2);
  const preferences = {
    custom: usable(profile.customFields).filter(([term]) => !selectedAreas.has(term)),
    terms: usable(profile.keywords),
  };
  const results = [];
  for (const entry of entries) {
    if (!inPriceRange(entry.price.value, range) ||
        (filters.field && !entry.fields.some((field) => field.id === filters.field))) continue;
    const result = assess(entry, profile, preferences, budget, now);
    if (result && (!result.excluded || filters.excludeClosed === false)) results.push(result);
  }
  const byDeadline = (a, b) => (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER);
  return results.sort((a, b) => filters.sort === "deadline" ?
    byDeadline(a, b) || b.score - a.score : b.score - a.score || byDeadline(a, b));
}
