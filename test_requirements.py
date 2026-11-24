import json
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

from collect_requirements import _fields_ok, build_index
from requirement_rules import summarize_documents


def parts(*lines):
    return {"status": "success", "parts": [{"paragraph": n, "text": value} for n, value in enumerate(lines, 1)]}


def item(filename="공고문.pdf", category="공고문"):
    return {"filename": filename, "format": filename.split(".")[-1], "category": category,
            "sourceUrl": "https://www.g2b.go.kr/example/" + filename.split(".")[-1]}


class RulesTest(unittest.TestCase):
    def test_typed_facts_and_evidence_without_source_text(self):
        entries = summarize_documents([parts(
            "1. 주요 업무 : 정보시스템 유지보수 및 비공개테스트문구",
            "2. 사업예산 : 금 69,300,000원 (부가세 포함)",
            "3. 용역기간 : 계약일로부터 6개월",
            "4. 입찰 참가 자격",
            "주된 영업소가 경기도에 있는 업체로서 업종코드 1468 등록",
            "직접생산확인증명서를 소지해야 함",
            "유사사업 실적은 최근 3년 이내 2건 이상",
            "5. 제출 서류",
            "사업자등록증과 인감증명서",
            "가격제안서",
            "제안서 제출 마감 : 2026. 12. 3.(목) 14:30",
            "입찰서 접수 기간 : 2026. 11. 30. 12:00 ~ 2026. 12. 3. 10:00",
            "평가 기준 : 기술능력평가 90점, 입찰가격평가 10점",
            "공동수급은 불가. 하도급은 허용하지 아니한다.",
        )])
        self.assertTrue(_fields_ok(entries, 1))
        pairs = lambda key: {(f["type"], repr(f["value"])) for f in entries[key]["findings"]}
        self.assertIn(("topic", "'it'"), pairs("scope"))
        self.assertIn(("budget", "69300000"), pairs("budget"))
        self.assertEqual(entries["budget"]["findings"][0]["at"], [{"doc": 0, "paragraph": 2}])
        self.assertIn(("duration", "[6, 'month']"), pairs("period"))
        self.assertEqual(entries["eligibility"]["status"], "located")
        self.assertEqual(pairs("region_industry"), {("industryCode", "'1468'"), ("region", "'gyeonggi'")})
        self.assertIn(("certificate", "'direct'"), pairs("licenses"))
        self.assertEqual(pairs("experience"), {("experienceYears", "3"), ("experienceCount", "2")})
        self.assertIn(("document", "'priceProposal'"), pairs("documents"))
        self.assertNotIn(("document", "'proposal'"), pairs("documents"))
        self.assertIn(("proposalDeadline", "'2026-12-03 14:30'"), pairs("schedule"))
        self.assertIn(("bidDeadline", "'2026-12-03 10:00'"), pairs("schedule"))
        self.assertEqual(pairs("evaluation"), {("technical", "[90, 'point']"), ("price", "[10, 'point']")})
        self.assertEqual(pairs("joint_subcontract"), {("joint", "'prohibited'"), ("subcontract", "'prohibited'")})
        self.assertNotIn("비공개테스트문구", json.dumps(entries, ensure_ascii=False))

    def test_ambiguous_fields_and_conflicts(self):
        rules = summarize_documents([
            parts("공동수급 허용 여부", "하도급 계획 서식 예시", "사업 목적", "입찰공고일: 2026. 11. 24.",
                  "유사사업 수행실적 최근 0년 이내 0건 이상",
                  "제안서 제출일: 2026. 02. 30.", "사업예산: 10,000원"),
            parts("사업예산 20,000원", "추정가격: 9,000원"),
        ])
        self.assertEqual(rules["joint_subcontract"]["status"], "located")
        self.assertFalse(rules["joint_subcontract"]["findings"])
        self.assertFalse(rules["schedule"]["findings"])
        self.assertEqual(rules["budget"]["status"], "conflict")
        self.assertEqual({x["value"] for x in rules["budget"]["findings"]}, {9000, 10000, 20000})
        self.assertEqual(rules["scope"]["status"], "located")
        self.assertEqual(rules["licenses"]["status"], "missing")
        self.assertFalse(rules["experience"]["findings"])

    def test_egress_validator_rejects_text_and_cross_document_positions(self):
        result = summarize_documents([parts("사업예산: 1,000원")])
        result["budget"]["findings"][0]["value"] = "원문 유출 금지"
        self.assertFalse(_fields_ok(result, 1))
        result["budget"]["findings"][0]["value"] = 1000
        result["budget"]["findings"][0]["at"][0]["doc"] = 1
        self.assertFalse(_fields_ok(result, 1))

    def test_amended_figures_abbreviated_range_and_negation(self):
        rules = summarize_documents([parts(
            "○ 기초금액 : 36,000,000원 → 39,600,000원(부가가치세 포함)",
            "적격심사는 추정가격 10억원 이상인 경우의 기준 적용",
            "기초금액(1,000원 미만 절사)",
            "입찰서 제출기한 : 2026. 11. 24.(화) ~ 12. 01.(화), 10:00",
            "용역기간 : 계약체결일부터 2027년 2월 28일까지",
            "본 용역은 공동계약이 허용되지 않습니다.",
        )])
        findings = {field: [(item["type"], item["value"]) for item in rules[field]["findings"]]
                    for field in ("budget", "schedule", "period", "joint_subcontract")}
        self.assertEqual(findings, {
            "budget": [("base", 39600000)], "schedule": [("bidDeadline", "2026-12-01 10:00")],
            "period": [("endDate", "2027-02-28")], "joint_subcontract": [("joint", "prohibited")],
        })

    def test_scope_uses_work_heading_instead_of_incidental_citation(self):
        result = summarize_documents([parts(
            "본 사업은 소프트웨어진흥법에 따라 과업내용 확정을 위해 심의한다.",
            "□ 사 업 명 : 2027년 정보화시스템 통합유지관리",
        )])
        self.assertEqual(result["scope"]["findings"],
                         [{"type": "topic", "value": "it", "at": [{"doc": 0, "paragraph": 2}]}])


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 24, tzinfo=timezone.utc)
        self.bids = {"collectedAt": self.now.isoformat(), "notices": [
            {"noticeId": "R26BK01800001", "revision": "000", "공고명": "시스템 운영", "입찰마감일": "2026-12-01 10:00"},
            {"noticeId": "R26BK01800001", "revision": "001", "공고명": None, "입찰마감일": "2026-12-02 10:00"},
            {"noticeId": "R26BK01800002", "revision": "000", "공고명": "마감 파일", "입찰마감일": "2026-11-23 10:00"},
        ]}
        self.keys = ("R26BK01800001:000", "R26BK01800001:001", "R26BK01800002:000")
        self.attachments = {"collectedAt": self.now.isoformat(), "status": "available",
                            "notices": {key: [item()] for key in self.keys}}

    def test_duplicate_file_and_recent_public_cache(self):
        with patch("collect_requirements._download", return_value=({**parts("사업예산 10,000원"), "downloaded": True}, 42)) as get:
            result, stats, _ = build_index(self.bids, self.attachments, {}, self.now)
            self.assertEqual(get.call_count, 1)
            self.assertEqual(len(result["notices"]), 2)
            self.assertEqual(stats["reused_download"], 1)
            self.assertNotIn("parts", str(result))
            self.assertNotIn(self.keys[2], result["notices"])
            get.reset_mock()
            cached, stats, _ = build_index(self.bids, self.attachments, result["notices"], self.now + timedelta(hours=1))
            get.assert_not_called()
            self.assertEqual(stats["reused_notices"], 2)
            self.assertEqual(cached["notices"], result["notices"])
            self.attachments["notices"][self.keys[0]][0]["sourceUrl"] += "?revision=2"
            build_index(self.bids, self.attachments, result["notices"], self.now + timedelta(hours=2))
            self.assertEqual(get.call_count, 1)
            get.reset_mock()
            build_index(self.bids, self.attachments, result["notices"], self.now + timedelta(hours=25))
            self.assertEqual(get.call_count, 2)

    def test_missing_failed_partial_and_budget_states(self):
        self.attachments["notices"][self.keys[0]].append(item("제안요청서.hwp", "제안요청서"))
        self.attachments["notices"][self.keys[1]] = [item("공고문.hwpx")]
        def result_for(_session, source, *_remaining):
            return (parts("사업예산 10,000원"), 8) if source["format"] == "pdf" else (
                {"status": "failed", "reason": "encrypted", "downloaded": True}, 8)
        with patch("collect_requirements._download", side_effect=result_for):
            index, _, stats = build_index(self.bids, self.attachments, {}, self.now)
            self.assertEqual(index["notices"][self.keys[0]]["status"], "partial")
            self.assertEqual(index["notices"][self.keys[1]]["status"], "failed")
            self.assertEqual(stats["hwp"]["reason_encrypted"], 1)
        with patch("collect_requirements.PILOT_FILES", 1), patch("collect_requirements._download", side_effect=result_for):
            limited, stats, _ = build_index(self.bids, self.attachments, {}, self.now)
            self.assertEqual(stats["attempted"], 1)
            self.assertEqual({r["status"] for r in limited["notices"].values()}, {"partial", "unprocessed"})
        self.attachments["collectedAt"] = "different"
        index, _, _ = build_index(self.bids, self.attachments, {}, self.now)
        self.assertEqual(index["status"], "unavailable")
        self.assertFalse(index["notices"])


if __name__ == "__main__":
    unittest.main()
