# IndieDeck Browser Companion

상태: **CURRENT source**. 격리된 Chromium의 자동 패널 검증은 CI 결과를 참조한다.
개인 브라우저의 설치·로그인·실제 구매 및 모든 브라우저별 동작은 별도 검증 범위다.
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

런처 v0.1.20부터 내보내기 경로는 **`browser-companion/current`**로 고정된다.
확장은 런처와 독립된 버전(현재 0.2.0)을 사용한다. 런처가 시작할 때 소유 마커와
파일 해시가 확인된 사본만 갱신하며, 확장 파일이 같으면 런처 버전만 바뀌어도 다시
쓰지 않는다. 사용자 수정·추가 파일·링크가 있으면 보존하고 갱신을 중단한다.

기존 숫자 버전 폴더를 불러왔다면 이번 한 번만 고정 폴더로 바꾼다. 이전 IndieDeck
확장은 확장 관리에서 제거하고 새 경로를 불러오면 중복을 피할 수 있다. 다른 확장이나
개인 프로필은 변경하지 않는다. 이후 확장 코드가 바뀌면 같은 경로에서 확장의
**확장 업데이트 적용 / 새로고침** 버튼 또는 브라우저 확장 관리의 Reload를 사용한다.
파일 갱신만으로 이미 실행 중인 브라우저 코드까지 바뀌는 것은 아니다.

IndieDeck에서 **브라우저 확장 프로그램 폴더 열기**를 누르면 열린 `current`의
**`chromium/` 하위 폴더**를 Chrome·Edge·Whale에 불러온다. `current` 자체에는
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

## 큰 화면과 자동 패널

확장 팝업은 너비 600px, 본문 14px 이상으로 표시한다. 지원하는 상품 페이지에서
**이 사이트에서 자동으로 열기**를 누르고 브라우저의 사이트 접근 요청을 허용하면,
다음 상품 페이지부터 큰 패널이 자동으로 열린다. 기본값은 꺼짐이며 사이트별로 켠다.
로그인·주문·구매 목록 페이지와 하위 프레임에서는 상품 패널을 표시하지 않는다.

패널의 **접기** 또는 **숨기기**는 작은 다시 열기 버튼을 남긴다. 이 상태는 같은
사이트의 다음 상품에서도 유지되며 버튼을 누르면 다시 펼친다. 사이트 자동 표시를
끄거나 팝업에서 전체 자동 표시를 끌 수도 있다. 끈 사이트의 자동 스크립트 등록은
해제하지만 브라우저에 허용했던 사이트 권한 자체를 취소하려면 확장 관리에서 바꾼다.
패널이 열려도 연결 파일 저장이나 이미지 읽기는 사용자의 버튼 클릭을 기다린다.

확장 코드가 갱신되면 팝업의 **확장 업데이트 적용 / 새로고침**을 누른 뒤 상품
페이지를 새로고침한다. Firefox의 임시 부가 기능은 브라우저를 재시작하면 다시
불러와야 한다. 고정 폴더는 이 브라우저 자체의 제한을 없애지 않는다.

## 권한과 데이터

브라우저 API 권한은 `activeTab`·`scripting`·`storage`다. 사용자가 확장 아이콘을 누르면 현재 탭의 URL과
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
`tabs`, `history`, `<all_urls>` 권한은 요청하지 않는다. 자동 패널을 켤 때만 지원
사이트의 선택적 호스트 접근 권한을 요청하며, 허용된 사이트 주소와 접힘 상태만 저장한다.
background는 설치·시작·권한·설정 변경 이벤트에서 등록된 스크립트를 맞춘다.
탭이나 방문 기록을 주기적으로 순회하지 않는다.
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
