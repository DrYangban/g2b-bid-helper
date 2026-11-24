"""Find bounded, structured procurement facts and locations. No excerpts leave this module."""

from collections import defaultdict
from datetime import date, time
import re
import unicodedata


RULE_VERSION = 2
FIELDS = (
    "scope", "budget", "period", "eligibility", "region_industry", "licenses",
    "experience", "documents", "schedule", "evaluation", "joint_subcontract",
)
HEADINGS = {
    "scope": r"(?:사업|과업|용역)(?:의)?\s*(?:목적|개요|범위|내용|배경\s*및\s*목적)|추진\s*(?:목적|배경)|주요\s*(?:과업|업무)",
    "budget": r"사\s*업\s*(?:예산|비)|소요\s*예산|용역\s*(?:예정\s*금액|금액|비)|과업\s*예정\s*액|배정\s*예산|예산\s*(?:금액|액)|기초\s*금액|추정\s*(?:가격|금액)",
    "period": r"(?:사업|용역|이행|과업|수행|계약)\s*기간|용역\s*기한|납품\s*기한",
    "eligibility": r"(?:입찰|응찰|제안)\s*(?:참가|참여)\s*자격|입찰\s*자격|신청\s*자격",
    "region_industry": r"지역\s*제한|업종\s*(?:제한|코드)|참가\s*가능\s*지역|소재지\s*제한",
    "licenses": r"면허\s*(?:조건|요건|등록)|인증\s*(?:조건|요건)|직접\s*생산\s*확인|소기업.{0,8}확인서|중소기업.{0,8}확인서",
    "experience": r"(?:유사(?:\s*사업)?|수행|용역|이행|납품|동종)\s*(?:수행\s*)?실적",
    "documents": r"제출\s*(?:서류|자료|목록)|구비\s*서류|필수\s*서류|제안서\s*구비",
    "schedule": r"입찰\s*일정|제안서.{0,20}?(?:제출|접수)|입찰서\s*(?:제출|접수)|입찰\s*마감|투찰\s*(?:마감|기간)|개찰\s*(?:일시|일정|일)",
    "evaluation": r"평가\s*(?:기준|항목|방법|배점)|기술\s*(?:능력)?\s*평가|입찰\s*가격\s*평가",
    "joint_subcontract": r"공동\s*(?:수급|도급|계약|이행)|컨소시엄|하\s*도\s*급",
}
HEADING_PREFIX = r"^\s*(?:[○●□■▪※ㆍ·*\-]\s*|(?:\(?[0-9]{1,2}\s*[.)]|[0-9]{1,2}\s+|\(?[가-하]\s*[.)]|[ⅠⅡⅢⅣⅤⅥ]{1,4}[.)]?)\s*)*"
HEAD = {key: re.compile(HEADING_PREFIX + "(" + pattern + r")(?=$|[ \t:：({\[])")
        for key, pattern in HEADINGS.items()}
ANCHOR = {key: re.compile(pattern) for key, pattern in HEADINGS.items()}

MONEY = re.compile(r"(?<![\d,])(?:금\s*)?([1-9]\d{0,2}(?:,\s*\d{3})+|[1-9]\d{0,13})\s*(?:(천|백만|억)\s*)?원(?:정)?(?![가-힣])")
MONEY_KIND = ANCHOR["budget"]
DATE = re.compile(r"(?<!\d)(20\d{2})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})(?:일|\.)?(?!\d)")
SHORT_DATE = re.compile(r"^\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})(?:일|\.)?(?!\d)")
TIME = re.compile(r"^\s*(?:\([월화수목금토일]\)|[월화수목금토일]요일)?[,\s]*(\d{1,2})\s*[:시]\s*(\d{2})(?:분)?(?!\d)")
RANGE_SEPARATOR = re.compile(r"[~∼～]|부터")
DURATION = re.compile(r"(?:계약\s*체결일|계약\s*\(착수\)\s*일(?:\s*\(D\))?|계약일|착수일|착수)\s*(?:로부터|부터)\s*(\d{1,4})\s*(개월|일|년)(?![가-힣])")
CODE = re.compile(r"(?:업종|등록)\s*(?:코드|번호)\s*[:：(\s]*([0-9]{4})(?!\d)")
EXPERIENCE = re.compile(r"최근\s*(\d{1,2})\s*년\s*(?:이내|이상|간)")
EXPERIENCE_COUNT = re.compile(r"(\d{1,3})\s*건\s*이상")
FINDINGS_LIMIT = 10
REFERENCES_LIMIT = 5

TOPICS = {
    "it": r"전산|정보\s*시스템|소프트웨어|웹사이트|홈페이지|정보화|시스템|서버",
    "facilities": r"환경미화|청소|시설\s*관리|경비|방역|폐기물|수질|정화",
    "culture": r"행사|축제|영상|홍보|전시|콘텐츠|디자인",
    "transport": r"통학|운송|통근|수송|차량|버스",
    "research": r"연구|조사|교육|연수|컨설팅",
    "engineering": r"설계|감리|측량|안전진단|건설사업관리",
}
TOPIC_HEADER = re.compile(HEADING_PREFIX + r"((?:(?:사\s*업|용\s*역|과\s*업|입찰)\s*(?:건\s*)?명|공\s*고\s*명|건\s*명)(?=$|\s*[:：])|(?:주요\s*(?:업무|과업)|과업\s*내용)(?=$|[\s:：]))")
QUALIFICATIONS = {
    "local": r"(?:지방계약법|지방자치단체를\s*당사자로\s*하는\s*계약에\s*관한\s*법률)\s*시행령\s*제\s*13\s*조",
    "national": r"(?:국가계약법|국가를\s*당사자로\s*하는\s*계약에\s*관한\s*법률)\s*시행령\s*제\s*12\s*조",
}
REGIONS = {
    "seoul": "서울특별시", "busan": "부산광역시", "daegu": "대구광역시",
    "incheon": "인천광역시", "gwangju": "광주광역시", "daejeon": "대전광역시",
    "ulsan": "울산광역시", "sejong": "세종특별자치시", "gyeonggi": "경기도",
    "gangwon": "강원(?:특별자치도|도)", "chungbuk": "충청북도", "chungnam": "충청남도",
    "jeonbuk": "전북특별자치도|전라북도", "jeonnam": "전라남도", "gyeongbuk": "경상북도",
    "gyeongnam": "경상남도", "jeju": "제주(?:특별자치도|도)",
}
CERTIFICATES = {
    "direct": r"직접\s*생산\s*확인\s*증명서",
    "small": r"소기업\s*[·ㆍ,및 ]*\s*소상공인\s*확인서|소기업\s*확인서|소상공인\s*확인서",
    "sme": r"중\s*소\s*기업\s*확인서",
    "software": r"소프트웨어\s*사업자\s*(?:등록|신고|확인서)|소프트웨어\s*사업자\s*일반\s*현황\s*관리\s*확인서",
    "g2b": r"(?:나라장터|국가종합전자조달시스템).{0,35}입찰\s*참가\s*자격\s*등록",
}
DOCUMENTS = {
    "proposal": r"(?<!가격)(?<!사업)제안서(?!\s*(?:평가|작성\s*요령))", "priceProposal": r"가격\s*제안서",
    "bidApplication": r"입찰\s*참가\s*신청서", "registration": r"사업자\s*등록증",
    "registry": r"법인\s*등기\s*(?:부\s*)?(?:등본|사항\s*증명서)",
    "seal": r"인감\s*증명서", "usedSeal": r"사용\s*인감계",
    "agent": r"위임장", "pledge": r"청렴\s*(?:계약\s*)?(?:이행\s*)?서약서", "references": r"실적\s*증명서",
    "direct": CERTIFICATES["direct"], "small": CERTIFICATES["small"], "sme": CERTIFICATES["sme"],
}
JOINT = {
    "joint": r"공동\s*(?:수급|도급|계약|이행)(?:\s*체)?|컨소시엄",
    "subcontract": r"하\s*도\s*급",
}
PERMISSION = re.compile(r"허용\s*(?:하지|되지)\s*(?:않|아니)|인정\s*(?:하지|되지)\s*(?:않|아니)|미\s*허용|불\s*허|불\s*가|금\s*지|허\s*용|가능")
SCHEDULES = {
    "proposalDeadline": r"제안서.{0,20}?(?:제출|접수)(?:\s*(?:마감|기간|일시|일자|기한))*",
    "bidDeadline": r"(?:전자\s*|가격\s*)?입찰(?:서|가격서)?\s*(?:마감|제출|접수)(?:\s*(?:마감|기간|일시|일자|기한))*|투찰\s*(?:마감|기간)",
    "opening": r"개찰\s*(?:일시|일정|일)",
}
WEIGHTS = {
    "technical": r"기술\s*(?:능력)?\s*평가",
    "price": r"(?:입찰\s*)?가격\s*평가",
}
ENUMS = {"topic": TOPICS, "region": REGIONS, "qualification": QUALIFICATIONS,
         "certificate": CERTIFICATES, "document": DOCUMENTS}
ATTRS = {
    "scope": ("topic",), "budget": ("budget", "estimate", "base"), "period": ("duration", "dateRange", "endDate"),
    "eligibility": ("qualification",), "region_industry": ("region", "industryCode"), "licenses": ("certificate",),
    "experience": ("experienceYears", "experienceCount"), "documents": ("document",),
    "schedule": tuple(SCHEDULES), "evaluation": tuple(WEIGHTS), "joint_subcontract": tuple(JOINT),
}
SINGLE = {"budget", "estimate", "base", "duration", "dateRange", "endDate", *SCHEDULES, *JOINT}


def _dated(year, month, day, tail):
    try:
        found = date(year, month, day).isoformat()
        if after := TIME.match(tail):
            found += " " + time(*map(int, after.groups())).isoformat(timespec="minutes")
        return found
    except ValueError:
        return None


def _dates(text):
    matches = list(DATE.finditer(text))
    found = [value for match in matches
             if (value := _dated(*map(int, match.groups()), text[match.end():]))]
    if len(matches) == len(found) == 1 and (separator := RANGE_SEPARATOR.search(text, matches[0].end())):
        tail = text[separator.end():]
        if short := SHORT_DATE.match(tail):
            year, start_month, _ = map(int, matches[0].groups())
            month, day = map(int, short.groups())
            if month < start_month:
                year += 1
            if end := _dated(year, month, day, tail[short.end():]):
                found.append(end)
    return found


def _rows(parts):
    for part in parts:
        position = {key: value for key in ("page", "section", "paragraph", "line")
                    if type(value := part.get(key)) is int and 1 <= value <= 100_000}
        if not position:
            continue
        for line in part["text"].splitlines():
            normalized = re.sub(r"[ \t]+", " ", unicodedata.normalize("NFKC", line)).strip()
            if normalized:
                yield normalized[:600], position


def _matching_labels(patterns, text):
    return (label for label, pattern in patterns.items() if re.search(pattern, text))


def _candidates(field, text):
    if field == "scope":
        if title := TOPIC_HEADER.match(text):
            yield from (("topic", label) for label in _matching_labels(TOPICS, text[title.end():]))
    elif field == "budget":
        labels = list(MONEY_KIND.finditer(text))
        for index, label in enumerate(labels):
            tail = text[label.end():labels[index + 1].start() if index + 1 < len(labels) else None]
            match = MONEY.search(tail[:65])
            if not match or not re.fullmatch(r"(?:은|는|이|가)?[\s:：=\]()【】\[.·※]*(?:금\s*)?", tail[:match.start()]):
                continue
            if re.match(r"\s*(?:이상|이하|초과|미만|범위|절사)", tail[match.end():]):
                continue
            if update := re.match(r"\s*→\s*", tail[match.end():]):
                if new_amount := MONEY.match(tail, match.end() + update.end()):
                    match = new_amount
            number = int(re.sub(r"\D", "", match[1])) * {None: 1, "천": 1000, "백만": 1000000, "억": 100000000}[match[2]]
            label_text = label[0].replace(" ", "")
            kind = "estimate" if label_text.startswith("추정") else "base" if label_text.startswith("기초") else "budget"
            if 0 < number < 10**15:
                yield kind, number
    elif field == "period":
        if match := DURATION.search(text):
            quantity = int(match[1])
            if 0 < quantity <= {"일": 3660, "개월": 120, "년": 10}[match[2]]:
                yield "duration", [quantity, {"일": "day", "개월": "month", "년": "year"}[match[2]]]
        dates = _dates(text)
        if len(dates) == 2 and dates[0] <= dates[1] and RANGE_SEPARATOR.search(text):
            yield "dateRange", dates
        elif len(dates) == 1 and "까지" in text and re.search(r"계약|착수", text):
            yield "endDate", dates[0]
    elif field == "eligibility":
        yield from (("qualification", label) for label in _matching_labels(QUALIFICATIONS, text))
    elif field == "region_industry":
        if re.search(r"지역\s*제한|본점|주된\s*(?:영업소|사업장)|법인\s*등기부상", text):
            yield from (("region", label) for label in _matching_labels(REGIONS, text))
        yield from (("industryCode", match[1]) for match in CODE.finditer(text))
    elif field == "licenses":
        yield from (("certificate", label) for label in _matching_labels(CERTIFICATES, text))
    elif field == "experience":
        if (match := EXPERIENCE.search(text)) and int(match[1]) > 0:
            yield "experienceYears", int(match[1])
        if (match := EXPERIENCE_COUNT.search(text)) and int(match[1]) > 0:
            yield "experienceCount", int(match[1])
    elif field == "documents":
        if re.search(r"(?:제출|접수)\s*(?:기간|일정|일시|기한|마감)", text) and not ANCHOR["documents"].search(text):
            return
        names = set(_matching_labels(DOCUMENTS, text))
        if "priceProposal" in names and not re.search(r"(?:기술\s*|정성\s*|정량\s*|사업\s*)제안서|제안서\s*(?:[1-9]|및)", text):
            names.discard("proposal")
        yield from (("document", label) for label in DOCUMENTS if label in names)
    elif field == "schedule":
        if re.search(r"접수\s*(?:개시|시작)|제출\s*(?:개시|시작)|입찰\s*공고일|재입찰", text):
            return
        matches = sorted((match.start(), kind, match.end()) for kind, pattern in SCHEDULES.items()
                         if (match := re.search(pattern, text)))
        for index, (_, kind, end) in enumerate(matches):
            boundary = next((start for start, _, _ in matches[index + 1:] if start >= end), None)
            tail = text[end:boundary]
            dates = _dates(tail[:120])
            if len(dates) == 1 and not RANGE_SEPARATOR.search(tail) and ("기간" not in text[:end] or re.search(r"마감|종료", text[:end])):
                yield kind, dates[0]
            elif len(dates) == 2 and "→" in tail:
                yield kind, dates[1]
            elif len(dates) == 2 and "opening" != kind and RANGE_SEPARATOR.search(tail) and dates[0] <= dates[1]:
                yield kind, dates[1]
    elif field == "evaluation":
        for kind, pattern in WEIGHTS.items():
            match = re.search(pattern + r"\s*[:：=(\[]?\s*(\d{1,3})\s*(점|%)", text)
            if match and 0 < (weight := int(match[1])) <= 100:
                yield kind, [weight, "point" if match[2] == "점" else "percent"]
    elif field == "joint_subcontract":
        matches = sorted((match.start(), kind, match.end()) for kind, pattern in JOINT.items()
                         if (match := re.search(pattern, text)))
        for index, (_, kind, end) in enumerate(matches):
            tail = text[end:matches[index + 1][0] if index + 1 < len(matches) else None][:52]
            applicable = PERMISSION.search(tail)
            if applicable and re.match(r"^[\s:：().\[\]]*(?:은|는|이|가|의|\s)*(?:허용\s*여부\s*[:：]?\s*|원칙적으로\s*)?", tail):
                before = re.sub(r"\s+", "", tail[:applicable.start()])
                if re.fullmatch(r"[:：().\[\]은는이가의]*(?:허용여부[:：]?|원칙적으로)?", before):
                    phrase = applicable[0].replace(" ", "")
                    if phrase == "허용" and re.match(r"\s*(?:여부|하는|시|대상|범위|조건)", tail[applicable.end():]):
                        continue
                    allowed = phrase in {"허용", "가능"}
                    yield kind, "allowed" if allowed else "prohibited"


def summarize_documents(parsed_documents):
    fields = {field: {"status": "missing", "findings": [], "references": []} for field in FIELDS}
    for doc, parsed in enumerate(parsed_documents):
        rows = list(_rows(parsed.get("parts", [])))
        docs_context = 0
        for index, (line, position) in enumerate(rows):
            location = {"doc": doc, **position}
            headings = {field: HEAD[field].match(line) for field in FIELDS}
            headings["scope"] = TOPIC_HEADER.match(line) or headings["scope"]
            if headings["documents"]:
                docs_context = 7
            elif any(match for field, match in headings.items() if field not in {"licenses", "eligibility"}):
                docs_context = 0
            for field, output in fields.items():
                anchored = bool(ANCHOR[field].search(line))
                if field == "scope":
                    anchored |= headings["scope"] is not None
                if field == "eligibility":
                    anchored |= any(_matching_labels(QUALIFICATIONS, line))
                if field == "region_industry":
                    anchored |= bool(re.search(r"본점|주된\s*영업소|법인\s*등기부상", line))
                if field == "licenses":
                    anchored |= any(_matching_labels(CERTIFICATES, line))
                if field == "experience":
                    anchored |= bool(re.search(r"실적.{0,16}\d+\s*건\s*이상", line))
                if field == "documents":
                    anchored |= docs_context > 0 or bool(re.search(r"제출(?:하여|해야|하시|할|기한)|제출\s*:", line))
                if not anchored:
                    continue
                immediate = list(_candidates(field, line))
                evidence = location
                heading = headings[field]
                if not immediate and heading and index + 1 < len(rows) and re.fullmatch(r"[\s:：.()]*", line[heading.end():]):
                    next_line, next_location = rows[index + 1]
                    immediate = list(_candidates(field, line + " : " + next_line))
                    if immediate:
                        evidence = {"doc": doc, **next_location}
                references = output["references"]
                if (heading or immediate) and len(references) < REFERENCES_LIMIT and location not in references:
                    references.append(location)
                for kind, value in immediate:
                    existing = next((item for item in output["findings"] if item["type"] == kind and item["value"] == value), None)
                    if existing:
                        if evidence not in existing["at"] and len(existing["at"]) < 2:
                            existing["at"].append(evidence)
                    elif len(output["findings"]) < FINDINGS_LIMIT:
                        output["findings"].append({"type": kind, "value": value, "at": [evidence]})
            docs_context = max(0, docs_context - 1)
    for key, output in fields.items():
        if key == "schedule":
            timed = {(item["type"], item["value"][:10]) for item in output["findings"] if len(item["value"]) > 10}
            output["findings"] = [item for item in output["findings"]
                                  if len(item["value"]) > 10 or (item["type"], item["value"]) not in timed]
        per_kind = defaultdict(int)
        for item in output["findings"]:
            per_kind[item["type"]] += 1
        if any(kind in SINGLE and count > 1 for kind, count in per_kind.items()):
            output["status"] = "conflict"
        elif output["findings"]:
            output["status"] = "found"
        elif output["references"]:
            output["status"] = "located"
    return fields
