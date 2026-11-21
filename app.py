import streamlit as st

from g2b import (
    COLUMNS,
    BidApiError,
    fetch_notices,
    filter_notices,
    load_service_key,
    make_csv,
    recent_window,
)


def main() -> None:
    st.set_page_config(page_title="나라장터 AI 입찰 도우미", layout="wide")
    st.title("나라장터 AI 입찰 도우미")
    st.caption("한국시간으로 오늘과 앞선 이틀에 등록된 용역 입찰공고를 조회합니다.")

    try:
        service_key = load_service_key()
    except BidApiError as error:
        st.error(str(error))
        return

    if not service_key:
        st.warning("API 인증키를 설정해 주세요. 프로젝트 폴더의 README에서 설정 방법을 확인할 수 있습니다.")
        return

    if st.button("최근 3일 공고 조회", type="primary"):
        start, end = recent_window()
        with st.spinner("나라장터 용역 입찰공고를 불러오는 중입니다…"):
            try:
                notices = fetch_notices(service_key, start, end)
            except BidApiError as error:
                st.session_state.pop("bid_results", None)
                st.error(str(error))
                return
        st.session_state["bid_results"] = (start, end, notices)

    results = st.session_state.get("bid_results")
    if results is None:
        return

    start, end, notices = results
    st.caption(f"등록일시 범위　{start:%Y-%m-%d %H:%M} ~ {end:%Y-%m-%d %H:%M} (한국시간)")
    if not notices:
        st.info("이 기간에 등록된 용역 입찰공고가 없습니다.")
        return

    keywords = st.text_input(
        "공고명 키워드",
        key="bid_keywords",
        placeholder="콘텐츠, 영상, 홍보, SNS, 디자인",
        help="쉼표나 공백으로 구분한 키워드 중 하나라도 공고명에 있으면 표시합니다. 비워 두면 전체가 표시됩니다.",
    )
    matches = filter_notices(notices, keywords)
    if not matches:
        st.info(f"조회한 {len(notices):,}건 중 키워드에 맞는 공고가 없습니다. 키워드를 지우면 전체가 표시됩니다.")
        return

    st.caption(f"전체 {len(notices):,}건 중 {len(matches):,}건 표시")
    table = {
        column: [notice[column] for notice in matches]
        for column in COLUMNS
    }
    table["추정가격(원)"] = [
        f"{int(price):,}" if price is not None else None
        for price in table["추정가격(원)"]
    ]
    st.dataframe(
        table,
        hide_index=True,
        column_config={
            "공고명": st.column_config.TextColumn(width="large"),
            "발주기관": st.column_config.TextColumn(width="medium"),
            "공고 상세 링크": st.column_config.LinkColumn(display_text="공고 보기"),
        },
    )
    st.download_button(
        "표에 표시된 공고를 CSV로 저장",
        data=make_csv(matches),
        file_name=f"나라장터_용역입찰공고_{end:%Y%m%d}.csv",
        mime="text/csv",
        on_click="ignore",
    )


if __name__ == "__main__":
    main()
