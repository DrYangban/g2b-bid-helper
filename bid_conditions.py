import re
from collections import defaultdict
from datetime import datetime

from g2b import API_BASE, BidApiError, _notice, _text, fetch_rows


NOTICE_TYPES = {
    "service": {"api_name": "용역", "operation": "getBidPblancListInfoServc02"},
}
DETAIL_OPERATIONS = {
    "regions": "getBidPblancListInfoPrtcptPsblRgn02",
    "licenses": "getBidPblancListInfoLicenseLimit02",
}


def _notice_key(row: dict) -> tuple[str, str] | None:
    number = _text(row.get("bidNtceNo"))
    revision = str(row.get("bidNtceOrd", "")).strip()
    if number and re.fullmatch(r"[0-9]{1,3}", revision):
        return number, revision.zfill(3)
    return None


def _lookup_conditions(
    service_key: str, start: datetime, end: datetime, keys: set
) -> tuple[dict, dict]:
    result = {}
    coverage = {}
    for name, operation in DETAIL_OPERATIONS.items():
        grouped = defaultdict(list)
        try:
            rows = fetch_rows(
                service_key, start, end, url=API_BASE + operation,
                page_size=500, max_pages=15, time_limit=100,
            ) if keys else []
            for row in rows:
                key = _notice_key(row)
                business = _text(row.get("bsnsDivNm"))
                if key in keys and business in {None, NOTICE_TYPES["service"]["api_name"]}:
                    grouped[key].append(row)
            coverage[name] = {"status": "available", "matchedNotices": len(grouped)}
        except BidApiError:
            # 부가 조회 실패 시 기본 공고를 게시하고, 미확인 조건은 화면에서 안내한다.
            grouped.clear()
            coverage[name] = {"status": "unavailable", "matchedNotices": 0}
        result[name] = grouped
    return result, coverage


def _license(row: dict) -> dict:
    return {
        "group": _text(str(row.get("lmtGrpNo") or "")),
        "name": _text(row.get("lcnsLmtNm")),
        "alternatives": _text(row.get("permsnIndstrytyList")),
        "specialties": _text(row.get("indstrytyMfrcFldList")),
    }


def _enrich(item: dict, details: dict) -> dict:
    key = _notice_key(item)
    region_names = dict.fromkeys(
        name for row in details["regions"].get(key, [])
        if (name := _text(row.get("prtcptPsblRgnNm")))
    )
    licenses = [_license(row) for row in details["licenses"].get(key, [])]
    licenses = [rule for rule in licenses if rule["name"] or rule["alternatives"] or rule["specialties"]]
    budget = str(item.get("asignBdgtAmt", "")).strip().replace(",", "")
    return {
        **_notice(item),
        "type": "service",
        "noticeId": key[0] if key else None,
        "revision": key[1] if key else None,
        "noticeKind": _text(item.get("ntceKindNm")),
        "classification": [
            value for field in ("pubPrcrmntClsfcNm", "pubPrcrmntMidclsfcNm", "pubPrcrmntLrgclsfcNm")
            if (value := _text(item.get(field)))
        ],
        "allocatedBudget": budget if re.fullmatch(r"[0-9]{1,25}", budget) else None,
        "conditions": {
            "permittedRegions": list(region_names),
            "regionBasis": _text(item.get("rgnLmtBidLocplcJdgmBssNm")),
            "jointRegionRestricted": item.get("cmmnSpldmdCorpRgnLmtYn") == "Y",
            "industryLimited": _text(item.get("indstrytyLmtYn")),
            "licenses": licenses,
            "experienceCompetition": item.get("arsltCmptYn") == "Y",
            "designatedCompetition": item.get("dsgntCmptYn") == "Y",
            "participationRestricted": item.get("bidPrtcptLmtYn") == "Y",
            "prequalification": item.get("pqEvalYn") == "Y",
        },
    }


def fetch_public_notices(service_key: str, start: datetime, end: datetime) -> tuple[list[dict], dict]:
    rows = fetch_rows(service_key, start, end, url=API_BASE + NOTICE_TYPES["service"]["operation"])
    keys = {key for row in rows if (key := _notice_key(row))}
    details, coverage = _lookup_conditions(service_key, start, end, keys)
    return [_enrich(row, details) for row in rows], coverage
