# 개인 브라우저·스토어·공식 런처 연계

조사일: 2026-11-02. 아래 연결 기능의 구현 버전은 v0.1.7이다.
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
지원하는 공개 상품 주소만 작은 연결 파일로 저장하도록 요청한다. `activeTab` 권한만
사용하고 background 수집, DOM 스크래핑, 쿠키·비밀번호·브라우저 기록 접근,
다운로드 감시, 외부 네트워크 전송, Native Messaging과 localhost 서버는 사용하지 않는다.

[Chrome activeTab 설명](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)은
사용자의 확장 프로그램 실행을 계기로 현재 탭에 임시 접근을 허용하는 방식을 설명한다.
이 제품에서는 이 범위를 상품 URL·제목 읽기에만 사용한다. 다운로드 버튼의 서명 URL,
계정 페이지의 비공개 정보, HTML 전체는 파일에 넣지 않는다.

파일 형식은 다음과 같다. `provider`에 맞는 제한된 `productId`를 저장하며, 임의 URL·
다운로드 주소·헤더·토큰·실행 명령·파일 경로 필드는 받지 않는다.

```json
{
  "schemaVersion": 1,
  "kind": "indiedeck-store-link",
  "provider": "steam",
  "productId": "12345",
  "title": "Example game"
}
```

사용 순서:

1. 설정에서 **브라우저 확장 프로그램 폴더 열기**를 누른다. 번들 파일을 사용자가
   불러올 수 있는 위치에 준비하고 폴더를 연다. 브라우저에 자동 설치하지 않는다.
2. 함께 있는 `README.md`를 따라 확장 프로그램을 불러온다. 내보낸 폴더의
   `chromium/`을 Chrome·Edge·Whale에서 압축 해제된 확장 프로그램으로 불러온다.
   Firefox 140 이상은 `about:debugging`에서 **이 Firefox → 임시 부가 기능 로드**로
   `firefox/manifest.json`을 선택한다. 이 임시 로드는 서명된 일반 배포와 다르다.
3. 지원하는 상품 페이지에서 확장 프로그램을 눌러 연결 파일 저장을 요청한다.
   브라우저가 실제로 저장했는지는 사용자가 다운로드 결과를 확인한다.
4. IndieDeck의 **상품 연결 파일 선택**으로 파일을 고르고 미리보기를 확인한다.
5. 원하면 관리 중인 게임을 명시적으로 고르고 **연결 저장**을 누른다.

연결은 상품 참조다. M1 게임 설치본·사용 버전·본체 관리자·번역기 영수증을 합치거나
스토어 소유권을 부여하지 않는다. 파일을 받았다면 기존 ZIP 설치 화면에서 별도로
검사한다. 저장한 연결 제거도 게임 파일이나 브라우저 로그인 상태를 제거하지 않는다.
관리 게임의 상세 화면에서도 해당 상품 ID에 명시적으로 연결한 스토어 페이지를
열 수 있다. 같은 제목의 다른 상품·에디션에 연결한 페이지를 자동 표시하지 않는다.

브라우저 호환성은 다음처럼 구분한다.

- Chrome/Edge: Chromium Manifest V3 popup을 구현 대상으로 한다. 사용자의 실제
  프로필 설치·로그인·스토어 다운로드 성공은 오프라인 코드 검사와 구분한다.
- Whale: [공식 API](https://developers.whale.naver.com/api/)와
  [Manifest V3 안내](https://developers.whale.naver.com/tutorials/mv3-migration/)를
  바탕으로 동일한 popup 방식의 호환을 목표로 한다. 실제 Whale 프로필 설치 결과를
  확인했다고 주장하지 않는다.
- Firefox: 별도 manifest를 제공하며 최소 버전은 140이다. 브라우저 API 권한은
  `activeTab`뿐이지만, 선택한 상품 정보의 로컬 파일 내보내기도 확장 밖으로의
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
- `extensions/browser-companion/`: 명시적 popup 동작과 작은 상품 연결 파일.

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
