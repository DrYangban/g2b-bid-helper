import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from g2b import COLUMNS, KOREA_TIME, BidApiError, fetch_notices, load_service_key, recent_window


def main() -> int:
    parser = argparse.ArgumentParser(description="나라장터 용역 공고를 웹사이트용 JSON으로 저장합니다.")
    parser.add_argument("output", type=Path, help="저장할 JSON 파일 경로")
    output = parser.parse_args().output

    try:
        service_key = load_service_key()
        if not service_key:
            raise BidApiError("G2B_SERVICE_KEY가 비어 있습니다. 저장소의 Actions Secret을 확인해 주세요.")

        start, end = recent_window()
        notices = fetch_notices(service_key, start, end)
        data = {
            "collectedAt": datetime.now(KOREA_TIME).isoformat(timespec="seconds"),
            "window": {"start": start.isoformat(), "end": end.isoformat()},
            "notices": [{column: notice.get(column) for column in COLUMNS} for notice in notices],
        }
        snapshot = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if service_key in unquote(snapshot):
            raise BidApiError("공개 데이터에 인증키가 포함되어 저장을 중단했습니다.")

        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(snapshot + "\n", encoding="utf-8")
    except BidApiError as error:
        print(error, file=sys.stderr)
        return 1
    except OSError:
        print("웹사이트용 데이터 파일을 저장하지 못했습니다.", file=sys.stderr)
        return 1

    print(f"나라장터 API 조회 성공. 용역 입찰공고 {len(notices):,}건을 저장했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
