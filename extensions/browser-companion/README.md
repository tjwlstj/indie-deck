# IndieDeck Browser Companion

상태: **CURRENT source / browser activation unverified**, 0.1.7.
공식 상품 페이지에서 확장 버튼을 누르고 내용을 검토하면
`indiedeck-store-link.indiedeck-link.json` 연결 파일을 저장한다.
IndieDeck의 스토어 연결 화면에서 이 파일을 선택해 가져온다.

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
5. **연결 파일 저장**을 누르고, 브라우저에서 저장 완료를 확인한다.
6. IndieDeck의 스토어 연결 화면에서 JSON 파일을 가져온다.

개발자 모드 활성화·폴더 로드는 브라우저가 요구하는 사용자 동작이다.
이 README의 절차가 실행됐다는 뜻은 아니다. 자동 설치·정책 강제 설치·개인 프로필
수정 스크립트는 제공하지 않는다. Firefox의 임시 확장은 `about:debugging` →
**이 Firefox** → **임시 부가 기능 로드**에서 내보낸 `firefox/manifest.json`을 선택한다.

## 권한과 데이터

유일한 브라우저 API 권한은 `activeTab`이다. 사용자가 확장 아이콘을 누르면 현재 탭의 URL과
제목을 읽고, 공개 상품 경로에서 provider와 productId를 구한다. 표시되는 제목은
수정하거나 비울 수 있다. 다른 탭·방문 기록·프로필 파일을 순회하지 않는다.

연결 파일은 아래 값만 포함한다.

```json
{
  "schemaVersion": 1,
  "kind": "indiedeck-store-link",
  "provider": "steam",
  "productId": "12345",
  "title": "Optional display title"
}
```

원래 URL의 query와 fragment는 파일에 포함되지 않는다. 쿠키·인증 헤더·비밀번호·
서명된 다운로드 주소·referrer·로컬 파일 경로도 전달하지 않는다. 사이트 DOM·
본문은 읽지 않는다. `cookies`, `downloads`, `tabs`, `scripting`, `<all_urls>`,
host 권한이나 백그라운드 감시를 요청하지 않는다. 외부 네트워크 요청도 하지 않는다.
JSON은 popup의 Blob 및 다운로드 anchor로 저장을 요청하므로 브라우저의 저장
완료 여부는 사용자에게 브라우저에서 확인하도록 안내한다.

Firefox manifest에는 별도로 `browsingActivity`·`websiteContent` 데이터 전송 동의를
명시한다. 사용자가 고른 상품 식별자와 제목을 확장 바깥의 로컬 JSON 파일로
보내기 때문이다. 네트워크 업로드나 지속적인 방문 기록 수집을 뜻하지 않는다.
Firefox 140부터 제공되는 내장 동의 화면을 사용하며, 이전 Firefox용 사용자 동의
대체 화면은 구현하지 않았다.

IndieDeck main도 가져온 파일의 schema와 provider별 productId를 별도로 검사한다.
상품명이나 이 연결 파일은 구매 증명·인증 토큰·공식 최신 버전의 증거가 아니다.
현재는 연결 파일과 실제 ZIP 파일을 사용자가 각각 선택한다.

## 후속 연동

Native Messaging은 Chrome·Edge·Firefox의 공식 기능이지만, 별도 native host와
설치/제거·허용 확장 ID 검증이 필요하다. Whale의 정확한 host 발견 경로는 별도
검증 대상으로 남긴다. 현재 버전은 native host나 localhost 서버를 등록하지 않는다.
개인 브라우저의 기본 프로필에 원격 디버깅을 켜거나 로그인 데이터를 복사하지 않는다.

공식 근거:

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Firefox Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Firefox 내장 데이터 전송 동의](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Whale API 호환성](https://developers.whale.naver.com/api/)
- [Whale Manifest V3](https://developers.whale.naver.com/tutorials/mv3-migration/)
- [Chrome 기본 프로필 원격 디버깅 제한](https://developer.chrome.com/blog/remote-debugging-port)
- [IETF 네이티브 앱 OAuth](https://datatracker.ietf.org/doc/html/rfc8252)
