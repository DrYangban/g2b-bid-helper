let snapshotTime;
let manifest;

export function setAttachmentSnapshot({ collectedAt }) {
  snapshotTime = collectedAt;
  manifest = undefined;
}

export function officialAttachmentUrl(source) {
  if (typeof source !== "string" || !/^[\x21-\x7e]+$/.test(source)) return "";
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || !["g2b.go.kr", "www.g2b.go.kr"].includes(url.hostname) ||
        url.username || url.password || url.hash || url.port ||
        [...url.searchParams.keys()].some((key) => /service.?key|api.?key|token|password|credential|signature|authorization/i.test(key)) ||
        decodeURIComponent(source).includes("\\")) return "";
    return url.href;
  } catch {
    return "";
  }
}

export async function loadAttachments(notice) {
  if (!manifest) {
    const time = snapshotTime;
    const request = fetch("./data/attachments.json", { cache: "no-cache", signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw Error("attachment_index_unavailable");
        const index = await response.json();
        if (index.collectedAt !== time || index.status !== "available" || !index.notices || Array.isArray(index.notices)) {
          throw Error("attachment_index_unavailable");
        }
        return index.notices;
      }).catch(() => {
        if (manifest === request) manifest = undefined;
        throw Error("attachment_index_unavailable");
      });
    manifest = request;
  }
  const files = (await manifest)[notice.noticeId + ":" + notice.revision];
  return Array.isArray(files) ? files : [];
}
