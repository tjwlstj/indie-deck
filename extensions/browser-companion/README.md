# IndieDeck Browser Companion

상태: **CURRENT source / browser activation unverified**.
공식 상품 페이지에서 확장 버튼을 누르고 내용을 검토하면
`indiedeck-store-link.indiedeck-link.json` 연결 파일을 저장한다.
연결 정보를 클립보드로 복사해 IndieDeck에 붙여넣거나, 연결 파일을 스토어 연결
화면으로 끌어다 놓거나 파일 선택기로 가져온다. 내용을 검토한 뒤 설치된 게임이나
관리 상품을 명시적으로 골라 연결한다.

대표 이미지도 선택적으로 포함할 수 있다. 상품 페이지에서 별도의 읽기 동작으로
이미지 메타데이터 후보를 얻고, 포함을 선택한 연결 정보만 내보낸다. 확장 자체는
원격 이미지를 내려받거나 미리보기하지 않는다. 실제 이미지 다운로드·미리보기와
게임 표지 적용은 IndieDeck에서 각각 명시적으로 요청한다.

로그인과 게임 다운로드는 사용자의 개인 브라우저에서 진행한다. 이 확장은
로그인 성공·구매·게임 파일 설치를 확인하지 않으며 계정 연결 토큰을 만들지 않는다.
실제 브라우저의 설치·사용자 계정 로그인·실제 상품 다운로드는 이번 소스 검증에서
수행하지 않았다. 브라우저에 이미 설치된 다른 확장은 변경하지 않는다.

## 지원 범위

- Chrome / Edge / Whale: `manifest.json`의 Manifest V3 companion 소스.
- Firefox 140 이상: 별도 `manifest.firefox.json`. IndieDeck이 내보낸 확장 폴더에는
  Firefox용 manifest로 구성된 `firefox/` 폴더가 함께 제공된다. 저장소 소스를 직접
  시험한다면 `manifest.firefox.json`을 `manifest.json`으로 복사한 별도 폴더를 만든다.
  정식 배포에는 Firefox 서명이 필요하며 스토어 심사·서명은 아직 수행하지 않았다.
- 공식 public 상품 경로: Steam, Epic Games Store, GOG, itch.io, BOOTH, DLsite.
- DMM/FANZA, 구매 목록·다운로드·주문·로그인 페이지는 상품 정보 내보내기 대상이 아니다.
- 지원하지 않는 경로·언어 prefix는 버튼을 활성화하지 않는다. Epic과 GOG의 언어 경로는
  `store-link.js`의 명시적 목록으로 제한하며 필요한 경로는 검증 후 추가한다.

## 개발용 설치

대표 이미지 가져오기는 런처와 확장 모두 v0.1.18 이상이 필요하다. 런처 업데이트만으로
브라우저에 이미 불러온 구버전 확장 폴더가 교체되지는 않는다. 런처에서 새 버전의
확장 폴더를 내보낸 뒤 아래 방법으로 다시 불러온다. 기존 버전 폴더를 사용한 확장은
브라우저의 확장 관리에서 제거하고 새 `chromium/` 폴더를 불러오면 중복을 피할 수 있다.
이 제거는 확장 관리 UI에서 사용자가 선택하며 다른 확장에는 적용하지 않는다.

IndieDeck에서 **브라우저 확장 프로그램 폴더 열기**를 눌렀다면 열린 버전 폴더의
**`chromium/` 하위 폴더**를 Chrome·Edge·Whale에 불러온다. 버전 폴더 자체에는
manifest가 없다. Firefox는 **`firefox/manifest.json`**을 선택한다.
저장소의 `extensions/browser-companion/` 소스를 직접 사용하는 경우에는 이 소스
폴더 자체에 Chromium manifest가 있으므로 해당 폴더를 불러온다.

1. 사용할 확장 폴더를 고정된 로컬 위치에 둔다.
2. Chrome `chrome://extensions`, Edge `edge://extensions`, Whale `whale://extensions`에서
   개발자 모드를 켜고 **압축 해제된 확장 프로그램 로드**로 위에서 구분한 폴더를 고른다.
3. 지원 공식 상품 페이지를 연 뒤 확장 아이콘을 누른다.
4. 스토어·상품 식별자·공식 상품 링크를 확인하고 선택적인 상품명을 편집한다.
   대표 이미지가 필요하면 읽기 버튼을 직접 눌러 후보를 확인하고 포함 여부를 선택한다.
   후보가 없거나 지원하지 않는 주소면 상품 정보만 계속 가져올 수 있다.
5. **연결 정보 복사**를 누른 뒤 IndieDeck의 **스토어·브라우저 연계**에 붙여넣는다.
   브라우저가 복사를 허용하지 않으면 **연결 파일 저장**을 누르고 저장 완료를 확인한
   뒤 해당 JSON 파일을 같은 화면에 끌어다 놓는다. 기존 파일 선택기도 사용할 수 있다.
6. **가져온 정보 확인**으로 연결 정보 미리보기를 보고 표시 이름을 편집한다.
   이미지도 가져왔다면 대상 설치 게임을 이름과 경로로 선택한 뒤 이미지 미리보기를
   직접 요청하고, 별도의 적용 동작으로 표지를 저장한다. 상품 연결을 저장하는
   것만으로 이미지를 요청하거나 기존 표지를 바꾸지 않는다.
7. 설치된 게임이나 관리 상품에 대한 상품 참조를 저장하려면 **연결 저장**을 누른다.
   게임 상세의 **이 게임에 상품 연결**을 사용하면 그 게임이 미리 선택된다.

확장 없이도 공식 상품 URL을 같은 화면에 붙여넣을 수 있다. 붙여넣기와 파일 drop은
저장이나 게임 실행을 자동으로 수행하지 않는다. 입력은 최대 8 KiB이며 지원하는
공개 상품 URL 또는 제한된 연결 JSON 한 개만 받는다.
일반 상품 URL만 붙여넣으면 이미지 메타데이터는 생기지 않는다. 대표 이미지를
포함한 JSON은 schema v2를 처리하는 새 런처와 함께 사용해야 하며, v0.1.17 이하
런처에는 대표 이미지가 없는 기존 v1 연결 정보를 사용한다.

개발자 모드 활성화·폴더 로드는 브라우저가 요구하는 사용자 동작이다.
이 README의 절차가 실행됐다는 뜻은 아니다. 자동 설치·정책 강제 설치·개인 프로필
수정 스크립트는 제공하지 않는다. Firefox의 임시 확장은 `about:debugging` →
**이 Firefox** → **임시 부가 기능 로드**에서 내보낸 `firefox/manifest.json`을 선택한다.

## 권한과 데이터

브라우저 API 권한은 `activeTab`·`scripting`이다. 사용자가 확장 아이콘을 누르면 현재 탭의 URL과
제목을 읽고, 공개 상품 경로에서 provider와 productId를 구한다. 표시되는 제목은
수정하거나 비울 수 있다. 다른 탭·방문 기록·프로필 파일을 순회하지 않는다.
대표 이미지 읽기를 직접 요청할 때만 현재 탭의 최상위 문서에서 `og:image`와
`twitter:image` 메타데이터를 제한적으로 읽는다. 결과 문서의 상품 식별자를 다시
검사하고, 다른 상품으로 이동한 탭의 결과를 이전 상품에 붙이지 않는다.

이미지가 없는 기존 연결 파일은 아래 값만 포함한다.

```json
{
  "schemaVersion": 1,
  "kind": "indiedeck-store-link",
  "provider": "steam",
  "productId": "12345",
  "title": "Optional display title"
}
```

이미지 후보 포함을 선택하면 schema v2의 같은 상품 필드에
`artwork: { "url": "검증 대상인 공식 이미지 주소" }`이 추가된다. 페이지가 제안한
후보를 런처에서 다시 검사하므로 이미지 주소 자체가 원격 요청 권한이 되지 않는다.
IndieDeck의 이미지 미리보기 버튼을 눌러야 공급자별 허용 호스트에서 내려받으며,
형식·용량·픽셀 크기를 검사한 결과만 별도의 표지 적용에 사용할 수 있다.
표지는 런처 전용 수동 이미지 사본으로 저장해 다음 실행에도 유지한다.

상품 페이지 URL의 query와 fragment는 파일에 포함되지 않는다. 쿠키·인증 헤더·비밀번호·
서명된 다운로드 주소·referrer·로컬 파일 경로도 전달하지 않는다. 대표 이미지용으로
지정된 메타 태그를 제외한 본문·폼·HTML 전체는 읽지 않는다. `cookies`, `downloads`,
`tabs`, `<all_urls>`, 상시 host 권한이나 백그라운드 감시를 요청하지 않는다.
확장에서는 외부 네트워크 요청을 하지 않는다. 이미지 CDN 요청은 런처의 명시적인
미리보기 동작이며 브라우저의 로그인 세션을 복제하거나 인증 쿠키를 전달하지 않는다.
JSON은 popup의 Blob 및 다운로드 anchor로 저장을 요청하므로 브라우저의 저장
완료 여부는 사용자에게 브라우저에서 확인하도록 안내한다.
클립보드 복사는 사용자의 버튼 클릭 때 검토한 연결 JSON을 쓰는 동작만 수행한다.
클립보드 읽기 권한이나 지속적인 클립보드 감시는 추가하지 않았다. 브라우저가 쓰기를
거절하면 파일 저장 안내를 표시하며 자동으로 다른 전송을 시도하지 않는다.

Firefox manifest에는 별도로 `browsingActivity`·`websiteContent` 데이터 전송 동의를
명시한다. 사용자가 고른 상품 식별자·제목과 선택적 이미지 주소를 확장 바깥의 로컬 JSON 파일로
보내기 때문이다. 네트워크 업로드나 지속적인 방문 기록 수집을 뜻하지 않는다.
Firefox 140부터 제공되는 내장 동의 화면을 사용하며, 이전 Firefox용 사용자 동의
대체 화면은 구현하지 않았다.

IndieDeck main도 가져온 파일의 schema와 provider별 productId를 별도로 검사한다.
상품명이나 이 연결 파일은 구매 증명·인증 토큰·공식 최신 버전의 증거가 아니다.
현재는 연결 파일과 실제 ZIP 파일을 사용자가 각각 선택한다.
대표 이미지가 지원되는 상품 경로여도 메타데이터·CDN 주소 변경이나 접근 제한 때문에
해당 이미지가 없을 수 있다. 이 경로의 추출·검증 테스트와 실제 개인 브라우저에서의
활성화·이미지 적용 성공은 구분한다. 모든 공급자에서 실제 연속 동작을 확인한 것은 아니다.

## 후속 연동

Native Messaging은 Chrome·Edge·Firefox의 공식 기능이지만, 별도 native host와
설치/제거·허용 확장 ID 검증이 필요하다. Whale의 정확한 host 발견 경로는 별도
검증 대상으로 남긴다. 현재 버전은 native host나 localhost 서버를 등록하지 않는다.
개인 브라우저의 기본 프로필에 원격 디버깅을 켜거나 로그인 데이터를 복사하지 않는다.

공식 근거:

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Firefox executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Firefox Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Firefox 내장 데이터 전송 동의](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Whale API 호환성](https://developers.whale.naver.com/api/)
- [Whale Manifest V3](https://developers.whale.naver.com/tutorials/mv3-migration/)
- [Chrome 기본 프로필 원격 디버깅 제한](https://developer.chrome.com/blog/remote-debugging-port)
- [IETF 네이티브 앱 OAuth](https://datatracker.ietf.org/doc/html/rfc8252)
