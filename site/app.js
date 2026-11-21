"use strict";

const fields = [
  ["공고명", "title"],
  ["발주기관", "agency"],
  ["입찰마감일", "deadline"],
  ["추정가격(원)", "price"],
  ["공고 상세 링크", "detail"],
];
const pageSize = 25;
const numberFormat = new Intl.NumberFormat("ko-KR");
const koreaDateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
});

const keywords = document.querySelector("#keywords");
const download = document.querySelector("#download");
const status = document.querySelector("#status");
const table = document.querySelector("#table-wrap");
const rows = document.querySelector("#rows");
const pagination = document.querySelector("#pagination");
const previous = document.querySelector("#previous");
const next = document.querySelector("#next");
const pageNumber = document.querySelector("#page-number");

let snapshot;
let matches = [];
let page = 0;

function cellValue(notice, key) {
  return typeof notice[key] === "string" ? notice[key] : "";
}

function detailUrl(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // 표시할 주소가 없거나 URL 형식이 잘못된 경우 빈칸으로 둔다.
  }
  return "";
}

function noticeRow(notice) {
  const row = document.createElement("tr");
  for (const [key, column] of fields) {
    const cell = row.insertCell();
    cell.className = column;
    const value = cellValue(notice, key);
    if (column === "detail") {
      const url = detailUrl(value);
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "공고 보기";
        cell.append(link);
      }
    } else if (column === "price") {
      cell.textContent = value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    } else {
      cell.textContent = value;
    }
  }
  return row;
}

function renderResults() {
  const total = snapshot.notices.length;
  const count = matches.length;
  const pageCount = Math.ceil(count / pageSize);
  table.hidden = count === 0;
  download.disabled = count === 0;
  pagination.hidden = pageCount < 2;
  rows.replaceChildren(...matches.slice(page * pageSize, (page + 1) * pageSize).map(noticeRow));
  previous.disabled = page === 0;
  next.disabled = page >= pageCount - 1;
  pageNumber.textContent = [page + 1, pageCount].join(" / ");

  if (!total) {
    status.textContent = "이 기간에 등록된 용역 입찰공고가 없습니다.";
  } else if (!count) {
    status.textContent = "키워드에 맞는 공고가 없습니다. 검색어를 지우면 전체 공고를 볼 수 있습니다.";
  } else {
    status.textContent = "전체 " + numberFormat.format(total) + "건 중 " +
      numberFormat.format(count) + "건";
  }
}

function applySearch() {
  const terms = keywords.value.toLowerCase().split(/[,\s]+/).filter(Boolean);
  matches = terms.length ? snapshot.notices.filter((notice) => {
    const title = cellValue(notice, "공고명").toLowerCase();
    return terms.some((term) => title.includes(term));
  }) : snapshot.notices;
  page = 0;
  renderResults();
}

function csvCell(value) {
  // 외부에서 받은 문자열을 Excel이 수식으로 해석하지 않도록 한다.
  const text = /^[=+\-@＝＋－＠]/u.test(value.trimStart()) ? "'" + value : value;
  return '"' + text.replaceAll('"', '""') + '"';
}

function downloadCsv() {
  const names = fields.map(([key]) => key);
  const lines = [names.map(csvCell).join(",")];
  for (const notice of matches) {
    lines.push(names.map((key) => csvCell(cellValue(notice, key))).join(","));
  }
  const csv = new Blob(["\uFEFF", lines.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(csv);
  const link = document.createElement("a");
  link.href = url;
  link.download = "나라장터_용역입찰공고_" + snapshot.collectedAt.slice(0, 10).replaceAll("-", "") + ".csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadNotices() {
  status.textContent = "공고를 불러오는 중입니다…";
  try {
    const response = await fetch("./data/bids.json", { cache: "no-cache" });
    if (response.status === 404) {
      status.textContent = "아직 게시된 공고 데이터가 없습니다. 첫 수집과 배포가 끝난 뒤 다시 확인해 주세요.";
      return;
    }
    if (!response.ok) {
      throw new Error("공고 파일 응답 오류");
    }
    const data = await response.json();
    const dates = [data.window?.start, data.window?.end, data.collectedAt];
    if (
      !dates.every((value) => typeof value === "string" && Number.isFinite(Date.parse(value))) ||
      !Array.isArray(data.notices) ||
      data.notices.some((notice) => !notice || typeof notice !== "object" || Array.isArray(notice))
    ) {
      throw new Error("공고 파일 형식 오류");
    }

    const [start, end, collected] = dates.map((value) => new Date(value));
    snapshot = data;
    document.querySelector("#window").textContent = koreaDateTime.format(start) + " ~ " +
      koreaDateTime.format(end) + " (한국시간)";
    document.querySelector("#collected-at").textContent = koreaDateTime.format(collected);
    document.querySelector("#metadata").hidden = false;
    document.querySelector("#stale").hidden = Date.now() - collected.getTime() <= 8 * 60 * 60 * 1000;
    keywords.disabled = data.notices.length === 0;
    applySearch();
  } catch {
    status.textContent = "공고를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.";
  }
}

keywords.addEventListener("input", applySearch);
download.addEventListener("click", downloadCsv);
previous.addEventListener("click", () => {
  page -= 1;
  renderResults();
});
next.addEventListener("click", () => {
  page += 1;
  renderResults();
});

loadNotices();
