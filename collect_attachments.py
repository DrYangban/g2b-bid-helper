"""Publish attachment metadata and test a bounded sample in Actions."""

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit

import requests

from bid_conditions import _notice_key
from document_text import MAX_FILE, SUPPORTED
from g2b import API_BASE, BidApiError, _text, fetch_rows, load_service_key


ATTACHMENT_URL = API_BASE + "getBidPblancListInfoAtchFileInfo02"
DOWNLOAD_HOSTS = {"g2b.go.kr", "www.g2b.go.kr"}
SAMPLE_LIMIT = 16
SAMPLE_SECONDS = 140
SAMPLE_BYTES = 64 * 1024 * 1024
SECRET_PARAMETER = re.compile(r"service.?key|api.?key|token|password|credential|signature|authorization", re.I)


class DownloadError(ValueError):
    pass


def download_url(value):
    url = _text(value)
    if not url or not url.isascii() or "\\" in unquote(url) or any(char.isspace() for char in url):
        return None
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname not in DOWNLOAD_HOSTS or
                parsed.port not in {None, 443} or parsed.username is not None or parsed.fragment):
            return None
        if any(SECRET_PARAMETER.search(name) for name, _ in parse_qsl(parsed.query, keep_blank_values=True)):
            return None
    except ValueError:
        return None
    return url


def _category(label, filename):
    for source in (label, filename):
        normalized = re.sub(r"\s+", "", source or "")
        if re.search(r"제안요청|제안요구|RFP", normalized, re.I):
            return "제안요청서"
        if re.search(r"과업지시|과업내용|과업설명|과업명세|과업서|직무명세", normalized):
            return "과업지시서"
        if re.search(r"공고문|공고서|입찰공고", normalized):
            return "공고문"
    return "기타"


def group_attachments(rows, notices, service_key):
    keys = {(item.get("noticeId"), item.get("revision")) for item in notices if item.get("noticeId")}
    groups = {}
    seen = set()
    malformed = 0
    for row in rows:
        key = _notice_key(row)
        if key not in keys:
            continue
        filename = _text(row.get("atchFileNm"))
        label = _text(row.get("atchDocDivNm"))
        url = download_url(row.get("atchFileUrl"))
        if not filename or any(service_key in unquote(value) for value in (filename, label or "", url or "")):
            malformed += 1
            continue
        fingerprint = key, filename, url
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        suffix = Path(filename).suffix.lower().lstrip(".")
        fmt = suffix if re.fullmatch(r"[a-z0-9]{1,9}", suffix) else None
        groups.setdefault(":".join(key), []).append({
            "filename": filename,
            "format": fmt,
            "sourceUrl": url,
            "documentLabel": label,
            "category": _category(label, filename),
            "download": "untested" if url else "unavailable",
            "extraction": {"status": "untested" if fmt in SUPPORTED else "unsupported"},
        })
    return groups, malformed


def sample_candidates(groups, limit):
    categories = {"공고문": 0, "제안요청서": 1, "과업지시서": 2, "기타": 3}
    by_format = {
        fmt: sorted(
            ((key, item) for key, files in groups.items() for item in files
             if item["format"] == fmt and item["sourceUrl"]),
            key=lambda pair: categories[pair[1]["category"]],
        ) for fmt in SUPPORTED
    }
    used = set()
    for index in range(limit):
        choices = by_format[SUPPORTED[index % len(SUPPORTED)]]
        if not choices:
            choices = next((items for items in by_format.values() if items), [])
        if not choices:
            break
        chosen = next((i for i, (key, _) in enumerate(choices) if key not in used), 0)
        key, item = choices.pop(chosen)
        used.add(key)
        yield key, item


def fetch_document(session, url, allowance, stop_at):
    for _ in range(4):
        url = download_url(url)
        if not url:
            raise DownloadError("untrusted_url")
        remaining = stop_at - monotonic()
        if remaining <= 0:
            raise DownloadError("download_timeout")
        try:
            with session.get(
                url, stream=True, allow_redirects=False, timeout=(min(5, remaining), min(12, remaining)),
                headers={"Accept-Encoding": "identity"}, verify=True,
            ) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                if response.status_code != 200:
                    raise DownloadError("http_error")
                if "text/html" in response.headers.get("Content-Type", "").lower():
                    raise DownloadError("html_instead_of_file")
                content_length = response.headers.get("Content-Length", "")
                if content_length.isdigit() and len(content_length) < 20 and int(content_length) > allowance:
                    raise DownloadError("file_limit")
                data = bytearray()
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if monotonic() >= stop_at:
                        raise DownloadError("download_timeout")
                    if len(data) + len(chunk) > allowance:
                        raise DownloadError("file_limit")
                    data.extend(chunk)
                if not data:
                    raise DownloadError("empty_file")
                if re.match(rb"\s*<(?:!doctype html|html\b)", data[:1024], re.I):
                    raise DownloadError("html_instead_of_file")
                return data
        except requests.Timeout:
            raise DownloadError("download_timeout") from None
        except requests.RequestException:
            raise DownloadError("network_error") from None
    raise DownloadError("too_many_redirects")


def _extract_in_process(data, fmt, remaining):
    script = Path(__file__).with_name("document_text.py").resolve()
    environment = {key: value for key, value in os.environ.items()
                   if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "LANG", "LC_ALL"}}
    with TemporaryDirectory(prefix="g2b-attachment-") as temporary:
        document = Path(temporary) / "input.bin"
        document.write_bytes(data)
        try:
            outcome = subprocess.run(
                [sys.executable, "-I", str(script), fmt, str(document)],
                cwd=temporary, env=environment, timeout=min(18, remaining),
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
            )
            return json.loads(outcome.stdout)
        except subprocess.TimeoutExpired:
            return {"status": "failed", "reason": "extraction_timeout"}
        except (subprocess.CalledProcessError, ValueError, OSError):
            return {"status": "failed", "reason": "parser_error"}


def _public_result(result):
    return {
        "status": result["status"],
        "reason": result.get("reason"),
        "warnings": result.get("warnings", []),
        "units": len(result.get("parts", [])),
        "hangul": result.get("hangul", 0),
        "replacement": result.get("replacement", 0),
    }


def check_samples(groups, limit, keep_private=False):
    stats = {fmt: Counter() for fmt in SUPPORTED}
    private = []
    stop_at = monotonic() + SAMPLE_SECONDS
    remaining_bytes = SAMPLE_BYTES
    with requests.Session() as session:
        session.trust_env = False
        for key, item in sample_candidates(groups, limit):
            if stop_at - monotonic() <= 1 or remaining_bytes <= 0:
                break
            fmt = item["format"]
            metrics = stats[fmt]
            metrics["attempted"] += 1
            try:
                data = fetch_document(session, item["sourceUrl"], min(MAX_FILE, remaining_bytes), stop_at)
                remaining_bytes -= len(data)
                item["download"] = "downloaded"
                metrics["downloaded"] += 1
                remaining = stop_at - monotonic()
                result = _extract_in_process(data, fmt, remaining) if remaining > 0 else {
                    "status": "failed", "reason": "extraction_timeout",
                }
            except DownloadError as error:
                item["download"] = "failed"
                result = {"status": "failed", "reason": str(error)}
            item["extraction"] = _public_result(result)
            metrics[result["status"]] += 1
            if item["extraction"]["hangul"]:
                metrics["hangul_files"] += 1
            if item["extraction"]["replacement"]:
                metrics["replacement_files"] += 1
            for warning in item["extraction"]["warnings"]:
                metrics[warning] += 1
            if result.get("reason"):
                metrics["reason_" + result["reason"]] += 1
            if keep_private:
                private.append({"noticeKey": key, **item, "extraction": result})
    return stats, private


def _write_json(destination, payload):
    temporary = destination.with_suffix(".tmp")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(destination)


def main():
    parser = argparse.ArgumentParser(description="공개 첨부파일 목록 및 표본 추출 상태를 수집합니다.")
    parser.add_argument("bids", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sample", action="store_true", help="최대 16건 다운로드 및 텍스트 추출 시험")
    parser.add_argument("--private-report", type=Path, help="로컬에서만 전문 추출 JSON 저장")
    options = parser.parse_args()
    if options.private_report:
        publish_root = options.output.resolve().parent.parent
        if os.environ.get("GITHUB_ACTIONS") or options.private_report.resolve().is_relative_to(publish_root):
            parser.error("본문 결과는 GitHub Actions 또는 게시 폴더에 저장할 수 없습니다.")
        if not options.sample:
            parser.error("--private-report를 사용할 때는 --sample도 지정하세요.")
    service_key = load_service_key()
    if not service_key:
        raise SystemExit("첨부파일 API 키가 설정되지 않았습니다.")
    snapshot = json.loads(options.bids.read_text(encoding="utf-8"))
    start = datetime.fromisoformat(snapshot["window"]["start"])
    end = datetime.fromisoformat(snapshot["window"]["end"])
    try:
        rows = fetch_rows(
            service_key, start, end, url=ATTACHMENT_URL, page_size=500,
            max_pages=25, time_limit=110, extra_params={"bsnsDivCd": "5"},
        )
    except BidApiError:
        _write_json(options.output, json.dumps({
            "collectedAt": snapshot["collectedAt"], "status": "unavailable", "notices": {},
        }))
        print("첨부파일 목록 조회 미완료. 기본 공고는 계속 게시합니다.")
        return
    groups, malformed = group_attachments(rows, snapshot["notices"], service_key)
    print(f"첨부파일 API 조회 성공. 응답 {len(rows):,}건, 용역 공고 {len(groups):,}건에 첨부 {sum(map(len, groups.values())):,}건 연결.")
    if malformed:
        print(f"파일명이 없거나 인증 정보가 포함된 항목 {malformed:,}건 제외.")
    if options.sample:
        stats, private = check_samples(groups, SAMPLE_LIMIT, bool(options.private_report))
        for fmt, counts in stats.items():
            print("첨부 시험 " + fmt.upper() + " " + json.dumps(dict(sorted(counts.items())), ensure_ascii=False))
        if options.private_report:
            _write_json(options.private_report, json.dumps(private, ensure_ascii=False, indent=2))
    published = json.dumps({
        "collectedAt": snapshot["collectedAt"], "status": "available", "notices": groups,
    }, ensure_ascii=False, separators=(",", ":"))
    if service_key in unquote(published):
        raise SystemExit("공개 첨부파일 자료에서 인증 정보가 감지돼 저장을 중단했습니다.")
    _write_json(options.output, published)


if __name__ == "__main__":
    main()
