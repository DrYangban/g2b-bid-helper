// Shared wire format. Document sentences and filenames are never fact values.
const documents = { proposal:"제안서", priceProposal:"가격제안서·가격입찰서", bidApplication:"입찰참가신청서",
  registration:"사업자등록증", registry:"법인 등기 증명", seal:"인감증명서", usedSeal:"사용인감계", agent:"위임장",
  pledge:"청렴 서약서", references:"실적증명서", direct:"직접생산확인증명서", small:"소기업·소상공인 확인서", sme:"중소기업확인서" };
const regions = { seoul:"서울특별시", busan:"부산광역시", daegu:"대구광역시", incheon:"인천광역시",
  gwangju:"광주광역시", daejeon:"대전광역시", ulsan:"울산광역시", sejong:"세종특별자치시", gyeonggi:"경기도",
  gangwon:"강원특별자치도", chungbuk:"충청북도", chungnam:"충청남도", jeonbuk:"전북특별자치도",
  jeonnam:"전라남도", gyeongbuk:"경상북도", gyeongnam:"경상남도", jeju:"제주특별자치도" };
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const integer = (max, unit) => value => positive(value, max) ? String(value) + unit : "";
const money = value => positive(value, 999_999_999_999_999) ? value.toLocaleString("ko-KR") + "원" : "";
const enums = values => value => typeof value === "string" && Object.hasOwn(values, value) ? values[value] : "";
const date = value => {
  if (typeof value !== "string" || !/^20\d{2}-\d\d-\d\d(?: (?:[01]\d|2[0-3]):[0-5]\d)?$/u.test(value)) return "";
  const stamp = new Date(value.slice(0,10) + "T00:00:00.000Z");
  return Number.isFinite(+stamp) && stamp.toISOString().slice(0,10) === value.slice(0,10) ? value : "";
};
const pair = (quantity, units) => value => Array.isArray(value) && value.length === 2 &&
  positive(value[0], quantity) && typeof value[1] === "string" && Object.hasOwn(units,value[1]) ? value[0] + units[value[1]] : "";
const codes = (pattern) => value => typeof value === "string" && pattern.test(value) ? value : "";

const rules = {
  topic:["scope","업무 유형 단서",enums({it:"정보화·전산",facilities:"시설·환경",culture:"콘텐츠·행사",
    transport:"운송",research:"조사·교육",engineering:"건설기술"})],
  task:["scope","문서에서 확인한 업무",enums({web:"웹서비스 구축·개선",maintenance:"시스템 유지관리",cleaning:"청소·환경미화",
    inspection:"안전점검·진단",shuttle:"통학·통근 운행",education:"교육 프로그램 운영",video:"영상 제작",survey:"조사·분석"})],
  budget:["budget","문서상 사업금액·예산",money], estimate:["budget","추정가격",money], base:["budget","기초금액",money],
  duration:["period","계약·착수 기준 기간",pair(3660,{day:"일",month:"개월",year:"년"})],
  dateRange:["period","기간",value => Array.isArray(value) && value.length === 2 &&
    date(value[0]) && date(value[1]) && value[0] <= value[1] ? value.join(" ~ ") : ""],
  endDate:["period","종료일",date],
  qualification:["eligibility","자격 관련 법령",enums({local:"지방계약법 시행령 제13조",national:"국가계약법 시행령 제12조"})],
  industryCode:["restrictions","입찰 관련 업종 코드",codes(/^\d{4}$/u)],
  region:["restrictions","언급된 소재지 제한",enums(regions)],
  productCode:["licenses","직접생산확인 관련 세부품명 번호",codes(/^[2-9]\d{9}$/u)],
  certificate:["licenses","언급된 면허·인증·등록",enums({direct:documents.direct,small:documents.small,sme:documents.sme,
    software:"소프트웨어사업자 등록·확인",g2b:"나라장터 입찰참가자격 등록"})],
  companySize:["experience","기업 규모 조건 단서",enums({small:"소기업·소상공인",sme:"중소기업"})],
  experienceYears:["experience","언급된 실적 기간(최근)",integer(99,"년")],
  experienceCount:["experience","실적 기준 건수·이상",integer(999,"건")],
  staffCount:["personnel","언급된 인력 최소 인원",integer(999,"명")],
  staffYears:["personnel","언급된 인력 최소 경력",integer(60,"년")],
  document:["documents","언급된 서류·필수 여부 확인 필요",enums(documents)],
  requiredDocument:["documents","제출 의무 근거가 있는 서류",enums(documents)],
  submissionMethod:["documents","확인된 제출 방법",enums({g2b:"나라장터 전자 제출",visit:"방문 제출"})],
  proposalDeadline:["schedule","제안서 제출 마감(한국시간)",date],
  bidDeadline:["schedule","입찰 마감(한국시간)",date],
  opening:["schedule","개찰 일시(한국시간)",date],
  technical:["evaluation","기술평가",pair(100,{point:"점",percent:"%"})],
  price:["evaluation","가격평가",pair(100,{point:"점",percent:"%"})],
  joint:["cooperation","공동수급",enums({allowed:"허용",prohibited:"불허"})],
  subcontract:["cooperation","하도급",enums({allowed:"허용",prohibited:"불허"})],
  risk:["risks","공고에 확인된 주의사항",enums({missingInvalid:"필수 입찰서 또는 제안서가 누락되면 무효",
    priceAbove:"사업금액을 초과한 입찰가격은 협상 대상에서 제외"})],
};

export const maxFactRows = 45;
export const maxFactFiles = 4;
export const autoFactCategories = ["공고문","제안요청서","과업지시서"];
export const excludedAttachmentName = /비공개|대외비|내부용|보안서약|개인정보|열람\s*제한/u;
export const excludedAttachmentText = /(?:본\s*(?:문서|자료)|이\s*(?:문서|자료)|해당\s*첨부(?:파일)?).{0,40}(?:외부\s*(?:제공|전송|배포)(?:를|을)?\s*(?:금지|불가|제한)|무단.{0,12}(?:복제|배포|전송).{0,10}금지)|(?:^|[\r\n])\s*(?:대외비|비공개용)(?:\s|$)/u;

export function isConversion(file) {
  return file.format === "pdf" && /변환본\s*[)）]?$/u.test(file.documentLabel ?? "");
}

export function pairedOriginal(file, files) {
  if (!isConversion(file)) return undefined;
  const stem = name => name.normalize("NFC").replace(/\.[a-z0-9]+$/iu,"").replace(/\s*[(（]변환본[)）]\s*$/u,"").trim();
  const candidates = files.filter(other => other.category === file.category && !isConversion(other) &&
    (other.documentLabel ?? "").replace(/\s*[（(]원본[)）]$/u,"") === file.documentLabel.replace(/\s*[（(]변환본[)）]$/u,""));
  return candidates.find(other => stem(other.filename) === stem(file.filename)) ??
    (candidates.length === 1 ? candidates[0] : undefined);
}

export function publicFact(type, value) {
  if (typeof type !== "string" || !Object.hasOwn(rules, type)) return undefined;
  const [section,label,encode] = rules[type];
  const rendered = encode(value);
  if (rendered) return { section, text: label + ": " + rendered };
}

export function factLocation(input) {
  if (!Array.isArray(input)) return undefined;
  if (input.length === 1 && positive(input[0],60)) return {page:input[0]};
  if (input.length === 2 && positive(input[1],4000)) {
    if (input[0] === 0) return {paragraph:input[1]};
    if (positive(input[0],4000)) return {section:input[0],paragraph:input[1]};
  }
}
