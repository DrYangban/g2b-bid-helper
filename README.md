# 나라장터 AI 입찰 도우미

브라우저에서 최근 3일의 나라장터 용역 입찰공고를 검색하고 CSV로 저장할 수 있습니다. GitHub Actions가 공고를 수집하고, GitHub Pages가 웹 화면과 공고 데이터 파일을 게시합니다. 사이트를 열 때는 주소만 있으면 됩니다.

## GitHub에 처음 올리기

### 1. 저장소를 만들고 파일 올리기

1. GitHub에 로그인하고 **New repository**를 누릅니다. 이름은 예를 들어 `g2b-bid-helper`로 입력합니다. 무료 GitHub 계정에서 Pages를 쓰려면 **Public**을 선택합니다. 이 경우 올리는 파일과 웹사이트가 공개됩니다. **Add README**를 켠 뒤 **Create repository**를 누릅니다. [GitHub Pages 이용 조건](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
2. 제공받은 업로드용 ZIP을 마우스 오른쪽 버튼으로 클릭해 **모두 압축 풀기**를 누릅니다. 풀린 폴더를 열어 그 안에 있는 파일과 폴더를 모두 선택합니다.
3. GitHub 저장소의 **Code → Add file → Upload files**에서 선택한 항목을 업로드 화면으로 끌어 놓고 **Commit changes**를 누릅니다. 업로드 뒤 저장소 첫 화면에 `site`와 `.github`가 나란히 보이는지 확인합니다. `.github`를 열면 `workflows/pages.yml`이 있어야 합니다. [브라우저에서 파일과 폴더를 올리는 방법](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)

### 2. API 인증키 저장하기

1. 공공데이터포털의 **마이페이지 → 데이터 활용 → Open API**에서 승인된 서비스의 **일반 인증키(Decoding)**를 복사합니다. [조달청_나라장터 입찰공고정보서비스](https://www.data.go.kr/data/15129394/openapi.do)
2. GitHub 저장소의 **Settings → Secrets and variables → Actions → New repository secret**을 누릅니다.
3. **Name**에 `G2B_SERVICE_KEY`를 입력합니다. **Secret** 칸에 복사한 키를 붙여 넣고 **Add secret**을 누릅니다. 실제 키를 붙여 넣는 곳은 이 칸입니다. [GitHub Secrets 공식 안내](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository)

### 3. Pages 켜고 처음 실행하기

1. 저장소의 **Settings → Pages**로 이동합니다. **Build and deployment** 아래 **Source**에서 **GitHub Actions**를 선택합니다. 올려 둔 배포 설정이 있으므로 템플릿 선택은 건너뜁니다. [GitHub Pages 게시 방식 설정](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
2. 저장소 상단 **Actions** 탭에서 **나라장터 공고 갱신 및 사이트 배포**를 고릅니다. **Run workflow**를 누르고 기본 브랜치(보통 **main**)를 선택한 뒤, 확인 창의 **Run workflow**를 한 번 더 누릅니다.
3. 새 실행을 열어 초록색 체크가 떴는지 확인합니다. 수집 단계에 **나라장터 API 조회 성공**과 공고 건수가 표시되면 실제 요청이 성공한 것입니다. **Settings → Pages → Visit site**를 눌러 사이트를 엽니다.
4. 사이트의 **마지막 수집** 시각과 공고 표를 확인하세요. 기간 안에 등록된 공고가 0건이면 빈 결과 안내가 표시됩니다.

### 평소 이용과 오류 확인

- 공고는 한국시간 **00:17, 06:17, 12:17, 18:17**에 수집을 시작하도록 설정했습니다. GitHub가 실행을 늦게 시작할 수 있습니다. 바로 갱신하려면 **Actions → Run workflow**를 다시 누르세요. 공개 저장소에 60일 동안 활동이 없어 예약 실행이 꺼지면 Actions 화면에서 다시 켤 수 있습니다. [예약 실행 안내](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- 실행에 빨간색 표시가 나면 **Actions**에서 해당 실행의 **collect → Collect public bid notices**를 엽니다. 인증 오류라면 서비스 활용 승인과 Secret 이름을 확인합니다. 연결 오류라면 다시 실행해 보세요. 수집에 실패하면 이전에 성공한 사이트가 계속 표시됩니다.
- 사이트에서 **공고명 키워드**에 원하는 단어를 넣으면 바로 검색됩니다. 쉼표나 공백으로 여러 단어를 구분할 수 있습니다. **검색 결과 CSV 저장**은 화면에서 여러 페이지로 나뉜 결과도 모두 저장합니다.

## 기존 Streamlit 버전

컴퓨터에서 기존 Streamlit 앱을 실행할 때 사용하는 안내입니다. 이 프로젝트 폴더에 `.venv`가 준비되어 있다면 1단계의 2번을 따라 PowerShell을 연 뒤 인증키 설정으로 넘어가세요.

### 1. 처음 한 번 준비하기

1. Python이 없다면 Python 3.13의 **Windows installer (64-bit)**를 받아 설치하세요. 설치 창에 **Add python.exe to PATH**가 나오면 체크하세요. Python 3.12가 이미 설치되어 있으면 그대로 사용해도 됩니다. [Python 공식 윈도우 다운로드 페이지](https://www.python.org/downloads/windows/)
2. 파일 탐색기에서 `README.md`와 `app.py`가 있는 프로젝트 폴더를 엽니다. 위쪽 주소 표시줄을 클릭하고 `powershell`을 입력한 뒤 Enter를 누릅니다.
3. 열린 PowerShell 창에 아래 명령을 한 줄씩 붙여 넣고 Enter를 누릅니다. 첫 줄에서 Python 버전이 표시되면 다음 줄로 진행하세요. Python 설치 직후 버전이 나오지 않으면 PowerShell 창을 닫고 2번부터 다시 시작하세요.

```powershell
python --version
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. 인증키 설정하기

공공데이터포털에 로그인합니다. **마이페이지 → 데이터 활용 → Open API**에서 승인된 서비스의 **일반 인증키(Decoding)**를 복사합니다. [조달청_나라장터 입찰공고정보서비스](https://www.data.go.kr/data/15129394/openapi.do)

#### 지금 프로젝트처럼 Dropbox에 있는 폴더에서 실행할 때

PowerShell에 아래 명령을 붙여 넣고 Enter를 누르세요. **일반 인증키를 붙여 넣으세요**라는 메시지가 나오면 복사한 키를 붙여 넣고 Enter를 누르세요. 입력은 별표로 표시됩니다.

```powershell
$env:G2B_SERVICE_KEY = [System.Net.NetworkCredential]::new('', (Read-Host '일반 인증키를 붙여 넣으세요' -AsSecureString)).Password
```

키는 이 PowerShell 창이 열려 있는 동안 사용할 수 있습니다. 같은 창에서 바로 3단계 실행 명령을 입력하세요. 새 PowerShell 창에서 앱을 실행할 때는 이 단계도 다시 진행합니다.

#### 동기화하지 않는 폴더에서 파일로 저장할 때

프로젝트 폴더에서 아래 두 줄을 한 줄씩 실행합니다. 첫 줄은 `.env` 파일이 없을 때만 견본을 복사합니다. 둘째 줄은 메모장으로 파일을 엽니다.

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
notepad .env
```

메모장에서 `G2B_SERVICE_KEY=`의 등호 바로 뒤에 복사한 키를 붙여 넣습니다. **Ctrl+S**로 저장하고 메모장을 닫습니다.

인증키는 채팅, 화면 캡처, GitHub에 공유하지 마세요. 프로젝트의 `.gitignore`에는 `.env`를 제외하는 설정이 있습니다. 환경변수와 `.env`에 모두 키가 있으면 환경변수의 값을 먼저 사용합니다.

### 3. 앱 열기

프로젝트 폴더를 연 PowerShell 창에서 아래 한 줄을 실행합니다.

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py --server.address 127.0.0.1 --browser.gatherUsageStats false
```

앱을 열 때는 브라우저에서 아래 주소로 접속하세요. PowerShell에 다른 포트 번호가 표시되면 창에 나온 주소를 브라우저에 입력하세요. 앱을 끄려면 PowerShell 창에서 **Ctrl+C**를 누릅니다. [내 컴퓨터에서 앱 열기](http://127.0.0.1:8501)

### 4. 공고 조회하고 저장하기

1. **최근 3일 공고 조회**를 누릅니다. 한국시간으로 오늘과 앞선 이틀에 등록된 용역 공고를 가져옵니다. 등록일시 기준이므로 입찰마감일이 이미 지난 공고도 포함될 수 있습니다.
2. **공고명 키워드** 칸에 `콘텐츠, 영상, 홍보, SNS, 디자인`처럼 원하는 단어를 넣고 Enter를 누릅니다. 쉼표나 공백으로 나눈 단어 중 하나라도 제목에 있으면 표시됩니다. 칸을 비우면 전체 공고가 다시 표시됩니다.
3. **공고 보기**를 눌러 원문을 엽니다. 제공되지 않은 항목은 표와 CSV에서 빈칸으로 표시됩니다.
4. **표에 표시된 공고를 CSV로 저장**을 누릅니다. 저장한 파일을 Excel로 열 수 있습니다.

### 오류가 나면

- **인증키를 설정해 달라는 안내가 나올 때**는 키를 설정한 PowerShell 창에서 앱을 실행했는지 확인하세요. 파일로 설정했다면 `.env`가 `app.py`와 같은 폴더에 있는지, 파일 이름이 `.env.txt`로 끝나지 않는지 확인하고 브라우저를 새로고침하세요.
- **인증에 실패했다고 나올 때**는 공공데이터포털에서 이 서비스의 활용 승인 상태와 키를 확인하세요.
- **키워드에 맞는 공고가 없을 때**는 검색어를 지우고 Enter를 눌러 전체를 확인하세요.
- **연결 오류가 나올 때**는 인터넷 연결을 확인하고 **최근 3일 공고 조회**를 다시 누르세요.

## API 참고 자료

첨부된 `조달청_OpenAPI참고자료_나라장터_입찰공고정보서비스_1.3_261110.docx`의 용역조회 명세를 우선 참고했습니다. 두 버전은 공공데이터포털의 HTTPS 주소로 `getBidPblancListInfoServc02`를 호출하는 코드를 함께 사용합니다. 각 페이지에 같은 최근 3일의 등록일시 범위를 전달해 7일 조회 제한을 지킵니다. 표의 발주기관에는 수요기관명을 우선 표시하고, 수요기관명이 비어 있으면 공고기관명을 표시합니다. [공공데이터포털의 공식 서비스 페이지](https://www.data.go.kr/data/15129394/openapi.do)
