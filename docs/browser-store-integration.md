# 개인 브라우저·스토어·공식 런처 연계

기본 연계 조사일: 2026-11-02. 대표 이미지 확장 검토·소스 갱신: 2026-11-10.
초기 연결 기능은 v0.1.7에서 시작했으며, 현재 배포 버전은
[GitHub 릴리즈](https://github.com/tjwlstj/indie-deck/releases/latest)를 따른다.
상태는 **CURRENT: 브라우저/런처 인계와 상품 링크**,
**PLANNED: 직접 계정 인증·다운로드 provider**다. 작업과 검증은 C에서 진행하며
사용자의 브라우저 프로필·로그인 데이터와 D드라이브를 조사 대상으로 읽지 않는다.

## 현재 사용할 연결 방식

설정의 **스토어·브라우저 연계**에서 공식 사이트, 확인된 로그인·구매 라이브러리,
공식 런처 다운로드 페이지를 기본 브라우저로 연다. 브라우저가 기존 로그인 상태와
프로필을 선택한다. IndieDeck은 어느 계정으로 로그인됐는지 확인하거나 해당 세션을
자체 로그인으로 복제하지 않는다. 따라서 UI는 **로그인·구매 여부 미확인**으로 표시한다.

문서화한 일부 공식 클라이언트 URI도 제공한다. 반환한 `opened`는 OS에 인계를
요청했다는 의미이며, 클라이언트의 로그인·다운로드·설치 완료를 확인한 결과가 아니다.
기존 스토어가 관리하는 게임 파일·DB·설치 소유권도 변경하지 않는다.

| 공급자 | 현재 연결 범위 | 공식 근거와 제한 |
| --- | --- | --- |
| Steam | 공식 사이트·로그인·클라이언트 안내, 저장 상품의 숫자 AppID 설치 인계 | [Steamworks 안내](https://partner.steamgames.com/doc/steamhardware/loadgames)의 원본 HTML에 `steam://install/943760`가 있다. [클라이언트 안내](https://store.steampowered.com/about/)와 [로그인](https://store.steampowered.com/login/)도 확인했다. 썸네일 AppID가 구매 권한은 아니다. |
| Epic | 공식 사이트·클라이언트 안내, 상품 slug의 공식 런처 상품 페이지 | [공식 호스팅 protocol 문서](https://assets-unreal2-epic-prod-us2.s3.dualstack.us-east-1.amazonaws.com/original/4X/f/c/4/fc4342c50e1a0abf34943e019ee90bacccc62950.pdf)가 상품 deep link를 문서화한다. 설치·업데이트 action은 별도 식별자·클라이언트 검증 대상으로 남긴다. [다운로드 안내](https://store.epicgames.com/download). |
| GOG | 공식 사이트·웹 계정 라이브러리·Galaxy 안내 | [공식 설명](https://docs.gog.com/introduction/)은 Galaxy와 offline installer를 구분한다. `goggalaxy://`의 공개 공식 계약은 이번 조사에서 확인하지 못해 호출하지 않는다. [Galaxy 안내](https://www.gog.com/galaxy). |
| itch.io | 공식 사이트·웹 로그인·클라이언트 안내, 공식 앱 라이브러리 인계 | [공식 protocol 문서](https://itch.io/docs/itch/integrating/protocol-urls.html)의 `itch://library`를 쓴다. 상품 연결 파일은 웹 URL의 creator/slug이며 숫자 game ID를 추측하지 않는다. [앱 안내](https://itch.io/app). |
| BOOTH | 공식 사이트·웹 로그인·구매 라이브러리, 상품 연결 | [공식 다운로드 도움말](https://booth.pixiv.help/hc/ja/articles/231598787)이 `accounts.booth.pm/orders`와 `/library`를 연결한다. 비로그인 요청은 `/users/sign_in`으로 이동했다. |
| DLsite | 공식 사이트와 공개 상품 연결 | Nest·도움말 본문은 이번 환경에서 접근에 실패했다. 현재 Nest 인증·범용 다운로드 API가 검증됐다는 의미로 확대하지 않는다. |
| DMM/FANZA | 공식 사이트, DMM PLAYER 안내 | [공식 PLAYER 사용법](https://support.dmm.com/dlsoft/article/46078)은 PLAYER 로그인·activation code·마이게임 절차를 안내한다. [PLAYER 안내](https://player.games.dmm.com/). 상품 연결 파일은 현재 DMM/FANZA 경로를 지원하지 않는다. |

## 개인 브라우저 확장 프로그램

현재 확장 프로그램은 사용자가 상품 페이지에서 누를 때 해당 탭의 URL·제목을 보고,
지원하는 공개 상품 주소를 작은 연결 파일로 저장하거나 복사하도록 요청한다.
대표 이미지 읽기를 별도로 누르면 `activeTab`과 `scripting`으로 해당 탭의 최상위
문서에서 `og:image`·`twitter:image` 메타데이터만 제한적으로 읽는다. 지속적인
content script, background 수집, 본문·폼·쿠키·비밀번호·브라우저 기록 접근,
다운로드 감시, Native Messaging과 localhost 서버는 사용하지 않는다.

[Chrome activeTab 설명](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)은
사용자의 확장 프로그램 실행을 계기로 현재 탭에 임시 접근을 허용하는 방식을 설명한다.
이미지 메타데이터 읽기는 [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)과
[Firefox executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)의
일회성 함수 주입을 사용하며, 모든 사이트에 대한 상시 host 권한은 추가하지 않는다.
읽은 문서의 상품 식별자를 다시 확인하므로 탭이 다른 상품으로 이동한 응답을 이전
상품의 이미지로 채택하지 않는다. 다운로드 버튼의 서명 URL, 계정 페이지의 비공개
정보, HTML 전체는 파일에 넣지 않는다. 확장에서 원격 이미지를 요청하지 않는다.

이미지가 없는 기존 파일 형식은 다음과 같다. `provider`에 맞는 제한된 `productId`를
저장하며, 다운로드 주소·헤더·토큰·실행 명령·파일 경로 필드는 받지 않는다.

```json
{
  "schemaVersion": 1,
  "kind": "indiedeck-store-link",
  "provider": "steam",
  "productId": "12345",
  "title": "Example game"
}
```

대표 이미지 후보를 포함하기로 선택한 경우에는 `schemaVersion: 2`와
`artwork: { "url": "검증 대상인 공식 이미지 주소" }`을 사용한다. v1도 계속
받으며, v2 처리가 없는 v0.1.17 이하 런처는 이미지 포함 파일을 처리하지 못한다.
이미지 주소는 임의 URL을 열 수 있는 권한이 아니다. main이 공급자·호스트·경로와
상품 식별자 규칙을 다시 검사하고, renderer에는 해당 후보의 opaque ID를 발급한다.

사용 순서:

1. 설정에서 **브라우저 확장 프로그램 폴더 열기**를 누른다. 번들 파일을 사용자가
   불러올 수 있는 위치에 준비하고 폴더를 연다. 브라우저에 자동 설치하지 않는다.
2. 함께 있는 `README.md`를 따라 확장 프로그램을 불러온다. 내보낸 폴더의
   `chromium/`을 Chrome·Edge·Whale에서 압축 해제된 확장 프로그램으로 불러온다.
   Firefox 140 이상은 `about:debugging`에서 **이 Firefox → 임시 부가 기능 로드**로
   `firefox/manifest.json`을 선택한다. 이 임시 로드는 서명된 일반 배포와 다르다.
3. 지원하는 상품 페이지에서 확장 프로그램을 연다. 대표 이미지가 필요하면 읽기
   버튼을 직접 누르고 후보를 포함할지 선택한 뒤 **연결 정보 복사**를 선택한다.
   브라우저가 클립보드 쓰기를 거부하면 연결 파일 저장을 요청하고 다운로드 결과를
   확인한다. 읽기·감시 권한은 추가하지 않으며 실패 시 자동 전송하지 않는다.
4. IndieDeck의 스토어 연결 화면에 복사한 JSON 또는 공식 상품 URL을 붙여넣고
   **가져온 정보 확인**을 누르거나, 연결 JSON 파일 하나를 해당 영역에 끌어다 놓는다.
   기존 **상품 연결 파일 선택**도 유지한다. 미리보기에서 표시 이름을 편집할 수 있다.
5. 대표 이미지를 적용하려면 이름과 경로로 대상 설치 게임을 선택하고, 이미지
   미리보기를 명시적으로 요청한 뒤 별도의 적용 동작으로 저장한다. 이 시점에만
   런처가 허용된 이미지 CDN에 요청하며, 확장의 쿠키·세션·referrer를 전달하지 않는다.
   다운로드는 리다이렉트·용량·시간·이미지 형식·픽셀 크기 검사로 제한한다.
6. 상품 참조도 저장하려면 설치된 게임 또는 관리 상품을 고르고 **연결 저장**을
   누른다. 게임 상세의 **이 게임에 상품 연결** 버튼은 해당 게임을 미리 선택한다.
   상품 연결 저장과 표지 적용은 별도 동작이며, 이미지 실패가 상품 연결을 막지 않는다.

연결은 상품 참조다. M1 게임 설치본·사용 버전·본체 관리자·번역기 영수증을 합치거나
스토어 소유권을 부여하지 않는다. 파일을 받았다면 기존 ZIP 설치 화면에서 별도로
검사한다. 저장한 연결 제거도 게임 파일이나 브라우저 로그인 상태를 제거하지 않는다.
일반 설치 게임과 관리 게임의 상세 화면에서도 명시적으로 연결한 스토어 페이지를
열 수 있다. 같은 제목의 다른 상품·에디션에 연결한 페이지를 자동 표시하지 않는다.

2026-11-10 소스의 붙여넣기와 drop 추가는 클립보드 자동 읽기·구매 목록 수집·게임
다운로드를 의미하지 않는다. main이 URL/JSON을 다시 제한된 상품 식별자로 검사하고,
저장할 때 현재 등록된 게임 또는 관리 상품인지 확인한다. 외부 URL의 query·fragment는
상품 참조에 보관하지 않는다. 확장의 복사 버튼과 실패 fallback, URL/JSON 파서 및
일반 게임 연결의 영속화는 합성 테스트로 검사하며, 실제 개인 브라우저 활성화는
별도 검증 대상이다.

대표 이미지 경로도 같은 원칙을 따른다. 연결 JSON을 가져오거나 상품 연결을 저장하는
것만으로 이미지 요청·기존 표지 교체를 수행하지 않는다. 미리보기의 검증된 bytes를
사용자가 선택한 설치 게임의 런처 전용 수동 표지로 적용한다. 메타데이터는 페이지가
제안하는 후보이므로 공식 이미지 호스트라는 사실만으로 상품과 이미지의 일치를
보증하지 않는다. 적용 전에 사용자가 이미지를 확인한다. 원시 CDN 주소·서명 query를
오류 메시지에 표시하지 않는다.

2026-11-10 공개 페이지의 읽기 전용 요청으로 Steam·GOG·BOOTH의 대표 이미지
메타데이터와 CDN 예시를 확인했다. Epic·itch.io·DLsite의 전체 이미지 가져오기는
접근 제한 또는 요청 실패로 실제 성공을 확인하지 못했다. 이는 사이트 우회를
구현했다는 뜻이 아니며, 메타데이터·CDN 변경으로 후보가 없으면 상품 정보만 가져온다.
각 공급자의 허용 규칙·실패 동작에 대한 합성 검증과 실제 브라우저 사용 결과는 구분한다.

브라우저 호환성은 다음처럼 구분한다.

- Chrome/Edge: Chromium Manifest V3 popup을 구현 대상으로 한다. 사용자의 실제
  프로필 설치·로그인·스토어 다운로드 성공은 오프라인 코드 검사와 구분한다.
- Whale: [공식 API](https://developers.whale.naver.com/api/)와
  [Manifest V3 안내](https://developers.whale.naver.com/tutorials/mv3-migration/)를
  바탕으로 동일한 popup 방식의 호환을 목표로 한다. 실제 Whale 프로필 설치 결과를
  확인했다고 주장하지 않는다.
- Firefox: 별도 manifest를 제공하며 최소 버전은 140이다. 브라우저 API 권한은
  `activeTab`·`scripting`이며, 선택한 상품 정보와 선택적 이미지 주소의 로컬 파일 내보내기도 확장 밖으로의
  데이터 전달이므로 [Firefox 내장 데이터 동의 선언](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
  에 `browsingActivity`와 `websiteContent`를 명시한다. 이는 백그라운드 방문 기록
  수집이나 원격 telemetry 기능이라는 뜻은 아니다. 실제 프로필 설치·동의 화면은
  코드 검사와 구분한다.

## Native Messaging과 원격 디버깅을 조사한 결과

Native Messaging은 브라우저 확장과 설치한 로컬 host가 통신하는 공식 경로다.
[Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)과
[Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)는
host manifest의 `allowed_origins`와 확장 ID를 지정하고, Windows에서는 host 등록도
필요하다. [Firefox](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)는
`allowed_extensions`와 자체 등록 규칙을 사용한다. Whale의 정확한 native-host 검색
규칙은 공식 원문으로 확인하지 못했다.

이 경로는 후속 선택지다. 현재는 별도 host·registry 등록 없이 파일 미리보기로
연결한다. 후속 구현에서는 정확한 확장 ID allowlist, 메시지 크기·schema, 사용자
요청 상관관계, host 설치·제거와 브라우저별 회귀 검사가 필요하다.

기존 개인 브라우저를 디버깅 포트로 제어하는 경로는 적용하지 않았다.
[Chrome 변경 안내](https://developer.chrome.com/blog/remote-debugging-port)는 Chrome 136부터
기본 데이터 디렉터리에 대한 remote-debugging port/pipe 사용을 제한하고 별도
데이터 디렉터리를 요구한다. 개인 프로필의 로그인 상태를 그대로 가져오는 범용
연동 방식으로 가정할 수 없다.

## 직접 로그인 엔진의 후속 조건

[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)는 네이티브 앱의 OAuth에
외부 사용자 에이전트를 권장한다. [itch.io 공식 butlerd 런처 안내](https://itch.io/docs/butler/launcher-integration.html)는
OAuth 앱 등록과 client ID, 제어하는 redirect URI, PKCE S256, 무작위 state 검증,
`Profile.LoginWithOAuthCode` 교환을 설명한다. 사용자-facing launcher의 직접 인증에는
이 경로를 우선한다. 웹 로그인 버튼을 열었다는 응답을 OAuth 연결 성공으로 표시하지 않는다.

현재 구현에는 OAuth 앱 등록·callback 수신·butlerd 인증·토큰 저장·실제 다운로드가
없다. 후속 provider는 공식 바이너리/API 버전 고정, 별도 DB·설치 위치와 daemon
수명 관리, 인증정보 보호, 오프라인 재시작·로그아웃·취소 검증을 갖춘 뒤 연결한다.

## 코드와 검증 경계

- `packages/desktop/src/store-connections.ts`: 고정 provider·정규 상품 주소·허용 action,
  제한된 JSON 파일과 저장 catalog, 연결 생성·제거.
- `main.ts`/`preload.cjs`: 시스템 파일 picker의 opaque 후보 ID와 기존 연결 ID만
  privileged 작업에 전달한다. 지원 URI는 main에서 생성하며 임의 URI를 받지 않는다.
- `renderer/panels/stores.js`/`store-model.js`: 파일 미리보기·관리 상품 선택·확인 저장,
  외부 인계 상태, catalog revision과 요청 token에 따른 오래된 응답 차단.
- `extensions/browser-companion/`: 명시적 popup 동작, 일회성 이미지 메타데이터 읽기와 작은 상품 연결 파일.

현재 renderer 상태 테스트는 저장 후 오래된 목록/오류가 도착한 경우, 손상된
catalog 읽기 오류의 보존과 쓰기 차단, 삭제된 관리 상품 선택 거절, 인계 결과가
인증/구매 성공으로 변하지 않는 경우를 확인한다. backend·확장 프로그램 검사와
한국어·영어 Electron 흐름으로 OS picker → 검토 → 관리 상품 연결 → 외부 호출 →
reload → 제거를 확인했다. 외부 브라우저·공식 런처·폴더 열기는 격리된 테스트에서
호출 기록으로 대체한다. 실제 개인 브라우저·계정·구매 파일을 검사한 것으로
해석하지 않는다.

2026-11-02 Windows C 작업본의 전체 테스트는 **396개 중 394 통과, 0 실패,
2 파일 심볼릭 링크 권한 제한으로 건너뜀**이다. 새 연계 관련 시나리오 27개를
포함한다. 실행 폴더 패키지의 필수 파일 48개와 주요 runtime 56개 SHA-256이
현재 빌드와 일치했다. 실제 Electron ASAR 안의 확장 파일을 읽어 Chromium·Firefox
폴더로 내보내고 별도 테스트 프로필에서 화면을 렌더링한 것도 확인했다.
이는 실제 브라우저에 확장을 활성화하거나 OAuth 로그인한 결과를 대신하지 않는다.
새 Windows·Linux/Node 22·24 및 배포 파일 검사는 해당 릴리스 CI 결과를 따른다.
