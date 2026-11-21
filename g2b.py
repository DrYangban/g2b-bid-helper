import csv
import io
import os
import re
from datetime import datetime, timedelta, timezone
from itertools import count
from pathlib import Path
from time import monotonic
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

import requests
from dotenv import dotenv_values


API_BASE = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService02/"
API_URL = API_BASE + "getBidPblancListInfoServc02"
KOREA_TIME = timezone(timedelta(hours=9))
PAGE_SIZE = 100
COLUMNS = ("공고명", "발주기관", "입찰마감일", "추정가격(원)", "공고 상세 링크")
Notice = dict[str, str | None]

AUTH_CODES = {"20", "30", "31", "32", "33"}
UNEXPECTED_RESPONSE = "공공데이터포털에서 예상과 다른 응답을 받았습니다. 잠시 후 다시 조회해 주세요."
AUTH_ERROR = "API 인증에 실패했습니다. 공공데이터포털의 활용 승인 상태와 인증키를 확인해 주세요."
RATE_LIMIT_ERROR = "API 호출 한도에 도달했습니다. 공공데이터포털에서 남은 호출 횟수를 확인해 주세요."


class BidApiError(Exception):
    """화면에 표시해도 되는 오류 안내."""


def load_service_key() -> str:
    key = os.environ.get("G2B_SERVICE_KEY", "").strip()
    if not key:
        env_file = Path(__file__).with_name(".env")
        try:
            if env_file.is_file():
                values = dotenv_values(env_file, encoding="utf-8-sig", interpolate=False)
                key = (values.get("G2B_SERVICE_KEY") or "").strip()
        except (OSError, UnicodeError):
            raise BidApiError(".env 파일을 읽을 수 없습니다. 파일을 UTF-8로 저장해 주세요.") from None

    # requests가 쿼리를 인코딩하므로 포털에서 복사한 Encoding 키도 먼저 디코딩한다.
    return unquote(key)


def recent_window() -> tuple[datetime, datetime]:
    end = datetime.now(KOREA_TIME).replace(second=0, microsecond=0)
    start = (end - timedelta(days=2)).replace(hour=0, minute=0)
    return start, end


def _api_error(code: str) -> BidApiError:
    if code in AUTH_CODES:
        return BidApiError(AUTH_ERROR)
    if code == "22":
        return BidApiError(RATE_LIMIT_ERROR)
    return BidApiError("입찰공고 조회 중 공공데이터포털에서 오류를 반환했습니다. 잠시 후 다시 조회해 주세요.")


def _read_page(response: requests.Response) -> tuple[int, list[dict]]:
    if response.status_code in {401, 403}:
        raise BidApiError(AUTH_ERROR)
    if response.status_code == 429:
        raise BidApiError(RATE_LIMIT_ERROR)
    if response.status_code != 200:
        raise BidApiError(f"공공데이터포털에 연결했지만 조회에 실패했습니다 (HTTP {response.status_code}).")

    try:
        payload = response.json()
    except ValueError:
        # 포털 게이트웨이는 JSON 요청에도 인증 오류를 XML로 응답할 수 있다.
        try:
            root = ElementTree.fromstring(response.content)
        except ElementTree.ParseError:
            raise BidApiError(UNEXPECTED_RESPONSE) from None
        code = root.findtext(".//returnReasonCode") or root.findtext(".//resultCode")
        if code == "03":
            return 0, []
        if code and code != "00":
            raise _api_error(code) from None
        raise BidApiError(UNEXPECTED_RESPONSE) from None

    if not isinstance(payload, dict):
        raise BidApiError(UNEXPECTED_RESPONSE)

    gateway_error = payload.get("OpenAPI_ServiceResponse")
    if isinstance(gateway_error, dict):
        header = gateway_error.get("cmmMsgHeader")
        code = str(header.get("returnReasonCode", "")) if isinstance(header, dict) else ""
        if code == "03":
            return 0, []
        raise _api_error(code)

    envelope = payload.get("response")
    if not isinstance(envelope, dict) or not isinstance(envelope.get("header"), dict):
        raise BidApiError(UNEXPECTED_RESPONSE)
    code = str(envelope["header"].get("resultCode", ""))
    if code == "03":
        return 0, []
    if not code:
        raise BidApiError(UNEXPECTED_RESPONSE)
    if code != "00":
        raise _api_error(code)

    body = envelope.get("body")
    if not isinstance(body, dict):
        raise BidApiError(UNEXPECTED_RESPONSE)
    try:
        total = int(str(body.get("totalCount")))
    except ValueError:
        raise BidApiError(UNEXPECTED_RESPONSE) from None

    items = body.get("items")
    if isinstance(items, dict) and "item" in items:
        items = items["item"]
        if isinstance(items, dict):
            items = [items]
    if items in (None, ""):
        items = []

    if (
        not isinstance(items, list)
        or total < len(items)
        or any(not isinstance(item, dict) for item in items)
    ):
        raise BidApiError(UNEXPECTED_RESPONSE)
    return total, items


def _text(value: object) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None


def _link(value: object) -> str | None:
    link = _text(value)
    if not link or any(ch.isspace() or ord(ch) < 32 for ch in link):
        return None
    try:
        parsed = urlsplit(link)
        if parsed.scheme in {"http", "https"} and parsed.hostname and parsed.username is None:
            return link
    except ValueError:
        pass
    return None


def _notice(item: dict) -> Notice:
    price = str(item.get("presmptPrce", "")).strip().replace(",", "")
    return {
        "공고명": _text(item.get("bidNtceNm")),
        "발주기관": _text(item.get("dminsttNm")) or _text(item.get("ntceInsttNm")),
        "입찰마감일": _text(item.get("bidClseDt")),
        "추정가격(원)": price if re.fullmatch(r"[0-9]{1,25}", price) else None,
        "공고 상세 링크": _link(item.get("bidNtceDtlUrl")) or _link(item.get("bidNtceUrl")),
    }


def fetch_rows(
    service_key: str,
    start: datetime,
    end: datetime,
    *,
    url: str = API_URL,
    page_size: int = PAGE_SIZE,
    max_pages: int | None = None,
    time_limit: int | None = None,
) -> list[dict]:
    if not timedelta(0) <= end - start < timedelta(days=7):
        raise BidApiError("조회기간은 7일 이내로 설정해 주세요.")

    params = {
        "serviceKey": service_key,
        "type": "json",
        "inqryDiv": "1",
        "inqryBgnDt": start.strftime("%Y%m%d%H%M"),
        "inqryEndDt": end.strftime("%Y%m%d%H%M"),
        "numOfRows": page_size,
    }
    rows = []
    expected_total = None
    started = monotonic()

    with requests.Session() as session:
        for page_number in count(1):
            if (max_pages and page_number > max_pages) or (time_limit and monotonic() - started >= time_limit):
                raise BidApiError("부가 조회에서 정해진 수집 범위를 초과했습니다.")
            try:
                response = session.get(
                    url,
                    params={**params, "pageNo": page_number},
                    timeout=(5, 20),
                    allow_redirects=False,
                )
            except requests.Timeout:
                raise BidApiError("응답이 늦어 조회를 마치지 못했습니다. 다시 조회해 주세요.") from None
            except requests.RequestException:
                raise BidApiError("공공데이터포털에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.") from None

            total, items = _read_page(response)
            if expected_total is None:
                expected_total = total
            rows.extend(items)
            if len(rows) >= expected_total:
                return rows
            if not items:
                raise BidApiError("일부 결과를 받지 못했습니다. 공고를 다시 조회해 주세요.")


def fetch_notices(service_key: str, start: datetime, end: datetime) -> list[Notice]:
    return [_notice(item) for item in fetch_rows(service_key, start, end)]


def filter_notices(notices: list[Notice], search: str) -> list[Notice]:
    keywords = re.findall(r"[^,\s]+", search.casefold())
    if not keywords:
        return notices
    return [
        notice
        for notice in notices
        if any(keyword in (notice["공고명"] or "").casefold() for keyword in keywords)
    ]


def make_csv(notices: list[Notice]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(COLUMNS)
    for notice in notices:
        row = []
        for column in COLUMNS:
            value = notice[column] or ""
            # 외부 제공 텍스트가 Excel 수식으로 실행되지 않도록 한다.
            if value.lstrip().startswith(("=", "+", "-", "@", "＝", "＋", "－", "＠")):
                value = "'" + value
            row.append(value)
        writer.writerow(row)
    return buffer.getvalue().encode("utf-8-sig")
