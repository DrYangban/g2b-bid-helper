"""Prepare a small, public index of rule-based findings from official bid attachments."""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from time import monotonic

import requests

from collect_attachments import DownloadError, _extract_in_process, _public_result, _write_json, download_url, fetch_document
from document_text import MAX_FILE, SUPPORTED
from requirement_rules import ATTRS, ENUMS, FIELDS, FINDINGS_LIMIT, REFERENCES_LIMIT, RULE_VERSION, TOPICS, summarize_documents


PREVIOUS = "https://dryangban.github.io/g2b-bid-helper/data/requirements.json"
PILOT_NOTICES = 16
PILOT_FILES = 24
PILOT_BYTES = 64 * 1024 * 1024
PILOT_SECONDS = 150
MAX_INDEX_BYTES = 600_000
DOCUMENT_CATEGORIES = ("공고문", "제안요청서", "과업지시서")
WARNINGS = {
    "body_only", "images_skipped", "page_limit", "page_without_text", "pdf_layout", "table_linear",
    "text_limit", "unmapped_characters", "unreadable_page",
}
REASONS = {
    "download_timeout", "empty_file", "encrypted", "expanded_limit", "extraction_timeout",
    "file_limit", "html_instead_of_file", "http_error", "invalid_document", "network_error", "no_text",
    "no_text_layer", "parser_error", "too_many_redirects", "untrusted_url", "wrong_format",
}
STATUSES = {"processed", "partial", "failed", "unprocessed"}
DATE_VALUE = re.compile(r"20\d{2}-\d{2}-\d{2}(?: \d{2}:\d{2})?")
KEY = re.compile(r"[A-Z0-9]{6,28}:[0-9]{3}")


def _value_ok(kind, value):
    if kind in ENUMS:
        return isinstance(value, str) and value in ENUMS[kind]
    if kind in {"budget", "estimate", "base", "experienceYears", "experienceCount"}:
        return type(value) is int and 0 < value < 10**15
    if kind == "industryCode":
        return isinstance(value, str) and bool(re.fullmatch(r"\d{4}", value))
    if kind in {"joint", "subcontract"}:
        return value in ("allowed", "prohibited")
    if kind in {"proposalDeadline", "bidDeadline", "opening", "endDate"}:
        return isinstance(value, str) and bool(DATE_VALUE.fullmatch(value))
    if not isinstance(value, list) or len(value) != 2:
        return False
    first, second = value
    if kind == "dateRange":
        return all(isinstance(item, str) and DATE_VALUE.fullmatch(item) for item in value)
    if kind == "duration":
        return type(first) is int and 0 < first <= 9999 and second in ("day", "month", "year")
    if kind in {"technical", "price"}:
        return type(first) is int and 0 < first <= 100 and second in ("point", "percent")
    return False


def _position_ok(value, count):
    if not isinstance(value, dict) or not {"doc"} < value.keys() <= {"doc", "page", "section", "paragraph", "line"}:
        return False
    return all(type(number) is int and (0 <= number < count if key == "doc" else 1 <= number <= 100_000)
               for key, number in value.items())


def _fields_ok(fields, count):
    if not isinstance(fields, dict) or fields.keys() != set(FIELDS):
        return False
    for key, entry in fields.items():
        if not isinstance(entry, dict) or entry.keys() != {"status", "findings", "references"}:
            return False
        if entry["status"] not in ("found", "missing", "located", "conflict"):
            return False
        findings, refs = entry["findings"], entry["references"]
        if not isinstance(findings, list) or len(findings) > FINDINGS_LIMIT or not isinstance(refs, list) or len(refs) > REFERENCES_LIMIT:
            return False
        if not all(_position_ok(pos, count) for pos in refs):
            return False
        for item in findings:
            if not isinstance(item, dict) or item.keys() != {"type", "value", "at"} or item["type"] not in ATTRS[key]:
                return False
            at = item["at"]
            if not _value_ok(item["type"], item["value"]) or not isinstance(at, list) or not 1 <= len(at) <= 2:
                return False
            if not all(_position_ok(pos, count) for pos in at):
                return False
    return True


def _state(result):
    public = _public_result(result)
    return {
        "status": public["status"],
        "reason": public["reason"] if public["reason"] in REASONS else None,
        "warnings": sorted(set(public["warnings"]) & WARNINGS),
        "units": public["units"],
        "downloaded": bool(result.get("downloaded")),
    }


def _state_ok(value):
    return (
        isinstance(value, dict) and value.keys() == {"status", "reason", "warnings", "units", "downloaded"}
        and value["status"] in ("success", "partial", "failed", "unprocessed")
        and (value["reason"] is None or isinstance(value["reason"], str) and value["reason"] in REASONS)
        and isinstance(value["warnings"], list)
        and all(isinstance(flag, str) and flag in WARNINGS for flag in value["warnings"])
        and type(value["units"]) is int and 0 <= value["units"] <= 4000 and type(value["downloaded"]) is bool
    )


def _clock(text):
    try:
        return datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return None


def load_previous():
    try:
        # Only the fixed HTTPS Pages result is read. Disallow redirects and bound the body.
        with requests.get(PREVIOUS, allow_redirects=False, stream=True, timeout=(4, 7)) as response:
            if response.status_code != 200:
                return {}
            body = bytearray()
            end_at = monotonic() + 9
            for chunk in response.iter_content(32_768):
                if len(body) + len(chunk) > MAX_INDEX_BYTES or monotonic() >= end_at:
                    return {}
                body.extend(chunk)
        previous = json.loads(body)
    except (requests.RequestException, ValueError, OSError):
        return {}
    if isinstance(previous, dict) and previous.get("rulesVersion") == RULE_VERSION and isinstance(previous.get("notices"), dict):
        return previous["notices"]
    return {}


def _file_identity(item):
    return item["filename"], item["sourceUrl"], item["category"], item["format"]


def _select_files(files):
    core = [item for item in files if item["category"] in DOCUMENT_CATEGORIES]
    usable = [item for item in core if item["format"] in SUPPORTED and download_url(item["sourceUrl"])]
    selected = []
    seen = set()
    for category in DOCUMENT_CATEGORIES:
        for item in usable:
            if item["category"] == category and item["sourceUrl"] not in seen:
                selected.append(item)
                seen.add(item["sourceUrl"])
                break
    signature = hashlib.sha256(json.dumps(sorted((_file_identity(i) for i in core), key=repr),
                                          ensure_ascii=False).encode("utf-8")).hexdigest()
    return selected, signature, len(core) - len(selected)


def _cached(previous, signature, selected, omitted, now):
    if not isinstance(previous, dict) or previous.get("sourceSignature") != signature or previous.get("status") not in ("processed", "partial"):
        return None
    checked = _clock(previous.get("checkedAt"))
    states = previous.get("documents")
    if not checked or not checked.tzinfo or not timedelta(0) <= now - checked <= timedelta(hours=24):
        return None
    if not isinstance(states, list) or len(states) != len(selected) or previous.get("omitted") != omitted:
        return None
    if not _fields_ok(previous.get("fields"), len(selected)):
        return None
    result = []
    for old, item in zip(states, selected):
        if not isinstance(old, dict) or not _state_ok(old.get("state")):
            return None
        document = _document(item, old["state"])
        if any(old.get(key) != document[key] for key in ("filename", "format", "category", "sourceUrl")):
            return None
        result.append(document)
    return {"sourceSignature": signature, "status": previous["status"], "checkedAt": checked.isoformat(),
            "omitted": omitted, "documents": result, "fields": previous["fields"]}


def _document(item, state):
    return {"filename": item["filename"], "format": item["format"], "category": item["category"],
            "sourceUrl": item["sourceUrl"], "state": state}


def choose_notices(bids, attachments, previous, now):
    candidates = []
    for notice in bids["notices"]:
        key = f"{notice.get('noticeId')}:{notice.get('revision')}"
        if not KEY.fullmatch(key) or "취소" in (notice.get("noticeKind") or ""):
            continue
        deadline = _clock(notice.get("입찰마감일"))
        if deadline and (deadline.replace(tzinfo=timezone(timedelta(hours=9))) if not deadline.tzinfo else deadline) <= now:
            continue
        selected, signature, omitted = _select_files(attachments.get(key, []))
        if not selected:
            continue
        title = notice.get("공고명") or ""
        topic = next((name for name, pattern in TOPICS.items() if re.search(pattern, title)), "other")
        cached = _cached(previous.get(key), signature, selected, omitted, now)
        candidates.append((key, selected, signature, omitted, topic, cached))
    pending = [row for row in candidates if row[-1] is None]
    chosen = [row for row in candidates if row[-1] is not None][:PILOT_NOTICES]
    topics = Counter(row[4] for row in chosen)
    formats = Counter(row[1][0]["format"] for row in chosen)
    while len(chosen) < PILOT_NOTICES and pending:
        index = min(range(len(pending)), key=lambda i: (topics[pending[i][4]], formats[pending[i][1][0]["format"]]))
        row = pending.pop(index)
        topics[row[4]] += 1
        formats[row[1][0]["format"]] += 1
        chosen.append(row)
    return chosen


def _download(session, item, stop_at, allowance):
    try:
        data = fetch_document(session, item["sourceUrl"], min(MAX_FILE, allowance), stop_at)
    except DownloadError as error:
        return {"status": "failed", "reason": str(error)}, 0
    time_left = stop_at - monotonic()
    result = _extract_in_process(data, item["format"], time_left) if time_left > 0 else {
        "status": "failed", "reason": "extraction_timeout",
    }
    return {**result, "downloaded": True}, len(data)


def build_index(bids, attachment_index, previous, now=None):
    now = now or datetime.now(timezone.utc)
    output = {"collectedAt": bids["collectedAt"], "rulesVersion": RULE_VERSION, "status": "unavailable", "notices": {}}
    if attachment_index.get("status") != "available" or attachment_index.get("collectedAt") != bids["collectedAt"]:
        return output, Counter(), {}
    output["status"] = "available"
    chosen = choose_notices(bids, attachment_index["notices"], previous, now)
    results = {row[0]: row[-1] for row in chosen if row[-1]}
    current = [row for row in chosen if not row[-1]]
    parsed = {}
    metrics = Counter(reused_notices=len(results))
    by_format = {}
    stop_at = monotonic() + PILOT_SECONDS
    allowance = PILOT_BYTES
    with requests.Session() as session:
        session.trust_env = False
        for position in range(len(DOCUMENT_CATEGORIES)):
            for _, selected, _, _, _, _ in current:
                if position >= len(selected) or metrics["attempted"] >= PILOT_FILES or allowance <= 0 or monotonic() >= stop_at:
                    continue
                item = selected[position]
                identity = item["format"], item["sourceUrl"]
                if identity not in parsed:
                    result, size = _download(session, item, stop_at, allowance)
                    parsed[identity] = result
                    allowance -= size
                    metrics["attempted"] += 1
                    counts = by_format.setdefault(item["format"], Counter())
                    counts["attempted"] += 1
                    counts["downloaded"] += int(result.get("downloaded", False))
                    counts[result["status"]] += 1
                    if result.get("reason") in REASONS:
                        counts["reason_" + result["reason"]] += 1
                else:
                    metrics["reused_download"] += 1
    for key, selected, signature, omitted, _, _ in current:
        extracts = [parsed.get((item["format"], item["sourceUrl"]), {"status": "unprocessed"}) for item in selected]
        states = [_state(result) for result in extracts]
        has_text = any(item["units"] for item in states)
        status = "processed"
        if not any(item["status"] != "unprocessed" for item in states):
            status = "unprocessed"
        elif not has_text:
            status = "failed"
        elif omitted or any(item["status"] != "success" for item in states):
            status = "partial"
        fields = summarize_documents(extracts)
        if not _fields_ok(fields, len(selected)) or status not in STATUSES:
            raise ValueError("Invalid public requirement result")
        results[key] = {
            "sourceSignature": signature, "status": status, "checkedAt": now.isoformat(),
            "omitted": omitted, "documents": [_document(item, state) for item, state in zip(selected, states)],
            "fields": fields,
        }
    output["notices"] = results
    # Counts and code lists are the only workflow output. Never print the document text.
    for key, report in results.items():
        metrics["notice_" + report["status"]] += 1
        for document in report["documents"]:
            if document["state"]["status"] == "unprocessed":
                continue
            for item in attachment_index["notices"][key]:
                if _file_identity(item) == _file_identity(document):
                    state = document["state"]
                    item["download"] = "downloaded" if state["downloaded"] else "failed"
                    item["extraction"] = {k: state[k] for k in ("status", "reason", "warnings", "units")}
                    break
    return output, metrics, by_format


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bids", type=Path)
    parser.add_argument("attachments", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fresh", action="store_true", help="의도적으로 이전 결과를 재사용하지 않고 표본을 검증")
    options = parser.parse_args()
    bids = json.loads(options.bids.read_text(encoding="utf-8"))
    attachments = json.loads(options.attachments.read_text(encoding="utf-8")) if options.attachments.is_file() else {}
    previous = {} if options.fresh else load_previous()
    output, metrics, by_format = build_index(bids, attachments, previous)
    published = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    if len(published.encode("utf-8")) > MAX_INDEX_BYTES:
        raise ValueError("Public requirement index exceeded its size limit")
    _write_json(options.output, published)
    if output["status"] == "available":
        _write_json(options.attachments, json.dumps(attachments, ensure_ascii=False, separators=(",", ":")))
    print("요건 사전 처리 " + json.dumps({"status": output["status"], **metrics}, ensure_ascii=False, sort_keys=True))
    for fmt, counter in sorted(by_format.items()):
        print("요건 파일 " + fmt.upper() + " " + json.dumps(counter, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
