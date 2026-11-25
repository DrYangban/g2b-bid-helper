import { businessRegions, industries, workFields } from "./industry-catalog.js";
import { prepareNotices, priceRange, rankNotices, splitPreferences } from "./recommendation-engine.js";
import { cellValue, detailUrl, noticeLink, saveCsv } from "./bid-ui.js";
import { attachmentButton } from "./attachment-view.js?v=5b1";
import { hasPublishedRequirements, requirementButton } from "./requirement-view.js?v=5b1";
import { aiReportButton } from "./ai-report.js?v=7b1";

const storageKey = "g2b-bid-helper:company-profile:v1";
const textFields = ["company", "region", "district", "customFields", "keywords", "min", "max", "licenses", "experience"];
const blankProfile = () => ({ ...Object.fromEntries(textFields.map((name) => [name, ""])), industries: [], fields: [] });
const fieldLabels = new Map(workFields.map((field) => [field.id, field.label]));
const numberFormat = new Intl.NumberFormat("ko-KR");
const pageSize = 12;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function textList(items, emptyMessage) {
  const list = document.createElement("ul");
  for (const item of items.length ? items : [emptyMessage]) list.append(element("li", item));
  return list;
}

function checkbox(name, id, label, checked) {
  const wrapper = element("label", "", "check-option");
  const input = document.createElement("input");
  Object.assign(input, { name, type: "checkbox", value: id, checked });
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}

function fillOptions(select, values) {
  for (const [value, label] of values) {
    const option = element("option", label);
    option.value = value;
    select.append(option);
  }
}

function readStoredProfile() {
  try {
    const profile = blankProfile();
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!saved || typeof saved !== "object") return { profile, message: "" };
    for (const name of textFields) {
      if (typeof saved[name] === "string") profile[name] = saved[name];
    }
    if (!businessRegions.some(([name]) => profile.region === name)) profile.region = "";
    if (Array.isArray(saved.industries)) profile.industries = industries.map(({ id }) => id).filter((id) => saved.industries.includes(id));
    if (Array.isArray(saved.fields)) profile.fields = workFields.map(({ id }) => id).filter((id) => saved.fields.includes(id));
    return { profile, message: "이 브라우저에 저장된 프로필을 불러왔습니다." };
  } catch {
    return { profile: blankProfile(), message: "브라우저에 저장된 프로필을 불러오지 못했습니다." };
  }
}

function reasonText(factor) {
  return factor.label + " " + factor.points + "/" + factor.max + "점 · " + factor.note;
}

function recommendationCard(result) {
  const { notice, factors, price, score, excluded, eligibility, checks } = result;
  const card = element("article", "", "recommendation-card");
  const header = element("div", "", "card-header");
  header.append(element("h4", cellValue(notice, "공고명") || "제목 미제공"), element("p", score + "점", "score"));
  const metadata = element("dl", "", "card-metadata");
  const list = [
    ["발주기관", cellValue(notice, "발주기관") || "확인 필요"],
    ["입찰마감일", cellValue(notice, "입찰마감일") || "확인 필요"],
    [price.value === null ? "입찰금액" : price.label, price.value === null ? "확인 필요" : numberFormat.format(price.value) + "원"],
  ];
  for (const [label, content] of list) {
    const value = document.createElement("div");
    value.append(element("dt", label), element("dd", content));
    metadata.append(value);
  }
  const condition = element("div", "", "card-actions");
  condition.append(element("p", "참가 자격 · " + eligibility, excluded || eligibility.includes("불일치") ? "eligibility caution" : "eligibility"));
  const originalLink = noticeLink(cellValue(notice, "공고 상세 링크"), "공고 원문 열기");
  if (originalLink) condition.append(originalLink);
  condition.append(requirementButton(notice), aiReportButton(notice), attachmentButton(notice));
  const details = document.createElement("details");
  details.append(
    element("summary", "추천 이유 및 조건 확인"),
    element("h5", "추천 이유"),
    textList(factors.filter((factor) => factor.points > 0).map(reasonText), "부여된 점수가 없습니다."),
    element("h5", "감점·제외 이유 및 확인 필요"),
    textList(factors.filter((factor) => factor.points < factor.max).map(reasonText), "배점 항목이 모두 일치합니다."),
    element("h5", "API에서 제공한 조건"),
    textList(checks, "표시할 세부 조건이 없습니다. 공고 원문을 확인하세요."),
  );
  card.append(header, metadata, condition, details);
  return card;
}

export function mountRecommendations() {
  const byId = (id) => document.getElementById(id);
  const form = byId("company-profile");
  const saveStatus = byId("profile-save-status");
  const suggested = byId("suggested-fields");
  const others = byId("other-fields");
  const list = byId("recommendation-list");
  const status = byId("recommendation-status");
  const more = byId("more-recommendations");
  const download = byId("recommendations-download");
  const filters = {
    field: byId("recommendation-field"), sort: byId("recommendation-sort"),
    min: byId("recommendation-min"), max: byId("recommendation-max"), excludeClosed: byId("exclude-closed"),
    preprocessed: byId("recommendation-preprocessed"),
  };
  const saved = readStoredProfile();
  let profile = saved.profile;
  let snapshot = null;
  let entries = [];
  let ranked = [];
  let rendered = 0;
  let failed = false;

  fillOptions(byId("company-region"), businessRegions.map(([name]) => [name, name]));
  fillOptions(filters.field, workFields.map(({ id, label }) => [id, label]));

  function showSelectedFields() {
    const selected = profile.fields.map((id) => fieldLabels.get(id));
    byId("selected-fields").textContent = selected.length ?
      "선택한 분야 · " + selected.join(", ") :
      "주요 업종을 고르면 관련 업무가 여기에 표시됩니다.";
  }

  function updateFieldSuggestions() {
    const suggestedFields = workFields.filter((field) => profile.industries.includes(field.industry));
    suggested.replaceChildren(...suggestedFields.map(({ id, label }) => checkbox("fields", id, label, profile.fields.includes(id))));
    others.replaceChildren();
    for (const industry of industries.filter(({ id, fields }) => fields.length && !profile.industries.includes(id))) {
      const group = element("fieldset", "", "other-field-group");
      const options = element("div", "", "check-options");
      options.append(...industry.fields.map(([id, label]) => checkbox("fields", id, label, profile.fields.includes(id))));
      group.append(element("legend", industry.label), options);
      others.append(group);
    }
    const otherDetails = others.closest("details");
    otherDetails.hidden = !others.childElementCount;
    showSelectedFields();
  }

  function fillProfile() {
    for (const name of textFields) form.elements[name].value = profile[name];
    byId("industry-options").replaceChildren(...industries.map(({ id, label }) =>
      checkbox("industries", id, label, profile.industries.includes(id))));
    updateFieldSuggestions();
  }

  function appendPage() {
    const batch = ranked.slice(rendered, rendered + pageSize);
    list.append(...batch.map(recommendationCard));
    rendered += batch.length;
    more.hidden = rendered >= ranked.length;
  }

  function render() {
    list.replaceChildren();
    ranked = [];
    rendered = 0;
    more.hidden = true;
    download.disabled = true;

    if (!snapshot) {
      status.textContent = failed ? "공고 데이터를 불러오지 못했습니다. 새로고침해 주세요." : "공고 데이터를 불러오는 중입니다.";
      return;
    }
    if (!priceRange(profile.min, profile.max).valid || !priceRange(filters.min.value, filters.max.value).valid) {
      status.textContent = "금액을 0 이상의 원 단위 숫자로 입력하고 최소 금액이 최대 금액 이하인지 확인하세요.";
      return;
    }
    if (!profile.industries.some((id) => id !== "other") && !profile.fields.length &&
        !splitPreferences(profile.keywords).length && !splitPreferences(profile.customFields).length) {
      status.textContent = "주요 업종, 관심 업무 또는 키워드를 하나 이상 입력하면 추천 공고가 표시됩니다.";
      return;
    }
    ranked = rankNotices(entries, profile, {
      field: filters.field.value, sort: filters.sort.value, min: filters.min.value, max: filters.max.value,
      excludeClosed: filters.excludeClosed.checked,
    });
    if (!filters.preprocessed.disabled && filters.preprocessed.checked) {
      ranked = ranked.filter(({ notice }) => hasPublishedRequirements(notice));
    }
    status.textContent = ranked.length ?
      "추천 공고 " + numberFormat.format(ranked.length) + "건" :
      "조건에 맞는 추천 공고가 없습니다. 업무 분야나 금액 범위를 바꿔 보세요.";
    download.disabled = !ranked.length;
    appendPage();
  }

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", (event) => {
    const data = new FormData(form);
    for (const name of textFields) profile[name] = String(data.get(name) ?? "");
    profile.industries = data.getAll("industries");
    profile.fields = data.getAll("fields");
    if (event.target.name === "industries") updateFieldSuggestions();
    else if (event.target.name === "fields") showSelectedFields();
    try {
      localStorage.setItem(storageKey, JSON.stringify(profile));
      saveStatus.textContent = "이 브라우저에 저장했습니다.";
    } catch {
      saveStatus.textContent = "브라우저가 저장을 허용하지 않아 이번 화면에서만 프로필을 사용합니다.";
    }
    render();
  });

  byId("reset-profile").addEventListener("click", () => {
    profile = blankProfile();
    fillProfile();
    try {
      localStorage.removeItem(storageKey);
      saveStatus.textContent = "이 브라우저에서 프로필을 삭제했습니다.";
    } catch {
      saveStatus.textContent = "화면을 초기화했습니다. 저장 데이터는 브라우저 설정에서 확인하세요.";
    }
    render();
  });
  for (const input of Object.values(filters)) input.addEventListener("input", render);
  more.addEventListener("click", appendPage);
  download.addEventListener("click", () => {
    const columns = ["적합도", "공고명", "발주기관", "입찰마감일", "금액 종류", "금액(원)", "참가 자격 확인 상태",
      "추천 이유", "감점·제외 이유", "API 조건", "공고 원문 링크"];
    const rows = ranked.map(({ score, notice, price, eligibility, factors, checks }) => [
      score, cellValue(notice, "공고명"), cellValue(notice, "발주기관"), cellValue(notice, "입찰마감일"),
      price.label, price.value, eligibility, factors.filter((factor) => factor.points > 0).map(reasonText).join(" | "),
      factors.filter((factor) => factor.points < factor.max).map(reasonText).join(" | "),
      checks.join(" | "), detailUrl(cellValue(notice, "공고 상세 링크")),
    ]);
    saveCsv("나라장터_맞춤추천_" + snapshot.collectedAt.slice(0, 10).replaceAll("-", "") + ".csv", columns, rows);
  });

  function showView(recommendations) {
    byId("search-view").hidden = recommendations;
    byId("recommendation-view").hidden = !recommendations;
    byId("search-view-button").setAttribute("aria-pressed", String(!recommendations));
    byId("recommendation-view-button").setAttribute("aria-pressed", String(recommendations));
    if (recommendations) render();
  }
  byId("search-view-button").addEventListener("click", () => showView(false));
  byId("recommendation-view-button").addEventListener("click", () => showView(true));
  fillProfile();
  saveStatus.textContent = saved.message;

  return {
    updateRequirementIndex(available) {
      filters.preprocessed.disabled = !available;
      render();
    },
    setSnapshot(data) {
      snapshot = data;
      entries = prepareNotices(data.notices);
      const needsCheck = [["regions", "참가 가능 지역"], ["licenses", "면허·업종 제한"]]
        .filter(([id]) => data.conditionCoverage?.[id]?.status !== "available")
        .map(([, label]) => label);
      const coverage = byId("recommendation-coverage");
      coverage.hidden = !needsCheck.length;
      coverage.textContent = needsCheck.length ? needsCheck.join(" 및 ") + " 부가 자료를 확인할 수 없어 해당 조건은 원문에서 확인해야 합니다." : "";
      render();
    },
    loadError() {
      failed = true;
      render();
    },
  };
}
