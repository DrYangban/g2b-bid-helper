// Independently recorded facts. Do not add attachment prose or contact information.
const base = "https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK01852410&bidPbancOrd=000&fileType=&prcmBsneSeCd=03&fileSeq=";

export const publicNoticeFacts = Object.freeze({
  "R26BK01852410:000": {
    until: "2026-12-08T10:00:00+09:00",
    filename: "국립민속박물관 입찰공고서 (변환본 PDF)",
    sourceUrl: base + "3",
    originalUrl: base + "2",
    converted: true,
    report: museumReport,
    facts: [
      ["scope", "업무 분류", "박물관 발간자료 웹서비스 확장 및 기능 개선", 3],
      ["budget", "사업 금액", "30,000,000원", 3],
      ["budget", "추정 가격", "27,272,727원", 3],
      ["period", "수행 기간", "2027-01-01 ~ 2027-12-31", 3],
      ["eligibility", "필수 업종 코드", "1468 (컴퓨터관련서비스사업)", 3],
      ["licenses", "직접생산확인 대상", "8111189901 (정보시스템유지관리서비스)", 3],
      ["documents", "전자 제출 필수", "기술 제안서 및 가격입찰서", 6],
      ["schedule", "전자입찰서 마감", "2026-12-08 10:00 (한국시간)", 6],
      ["schedule", "제안서 마감", "2026-12-08 10:00 (한국시간)", 6],
      ["evaluation", "평가 배점 비율", "기술 90%, 가격 10%", 8],
      ["cooperation", "공동수급", "허용 (공동이행)", 3],
      ["risks", "미제출 시 입찰 효력", "기술 제안서 또는 가격입찰서 미제출 시 입찰 무효", 6],
    ],
  },
});
import { museumReport } from "./public-notice-report.mjs";

