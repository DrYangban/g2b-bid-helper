export function cellValue(notice, key) {
  return typeof notice[key] === "string" ? notice[key] : "";
}

export function detailUrl(value) {
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

export function noticeLink(value, label) {
  const url = detailUrl(value);
  if (!url) return null;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function csvCell(value) {
  const plain = String(value ?? "");
  // 외부에서 받은 문자열을 Excel이 수식으로 해석하지 않도록 한다.
  const text = /^[=+\-@＝＋－＠]/u.test(plain.trimStart()) ? "'" + plain : plain;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function saveCsv(filename, columns, rows) {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(","));
  const file = new Blob(["\uFEFF", lines.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
