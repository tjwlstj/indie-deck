# 구매 게임 설치·업데이트 연동 조사와 구현 준비

작성·공식 자료 확인: 2026-11-02. 조사 시작 코드 기준: `v0.1.5`, `34e5349`.
M1의 구현 버전은 v0.1.6이며, v0.1.7에서 기본 브라우저·일부 공식 런처 인계와
상품 연결 파일을 추가했다. 후자의 최신 범위와 공식 근거는
[브라우저·스토어 연계](browser-store-integration.md)를 따른다.

상태: **PARTIAL / CURRENT M1 v0.1.6 + browser handoffs v0.1.7 + PLANNED direct providers**. 내려받은 Classic ZIP의
상품·릴리즈·설치 관계, 활성 버전 선택과 중단 복구를 현재 소스에 연결했다.
IndieDeck 내부의 스토어 인증·직접 다운로드·설치 완료 관찰·추가 압축 형식·세이브
이전은 여전히 계획이다. 브라우저에서 로그인 화면을 연 것과 앱 내부 인증 성공은
구분한다. 실제 구매 파일 대신 합성 fixture로 검증하며 기존 런처 DB는
변경하지 않는다. 작업 위치는 C의 프로젝트이며 D는 접근하지 않는다.

M1은 `v0.1.6`부터의 기능이다. GitHub 공개 여부와 CI 결과는 실제 릴리즈 실행 결과로
별도 확인한다. 세부 구현과 현재 검증 범위는 마지막의 **현재 M1 구현**을 따른다.
아래 공급자 비교·전체 데이터
모델은 후속 단계까지 포함한 설계이므로 모두 구현됐다는 뜻이 아니다.

## 1. 권장 방향

IndieDeck의 목록과 번역·호환성 화면은 하나로 유지하고, 게임 본체의 설치 방식은
배포 형태에 맞게 선택한다.

| 방식 | IndieDeck의 역할 | 적합한 대상 |
| --- | --- | --- |
| 로컬 패키지 관리 | 사용자가 받은 파일 검사, 상품 연결, 새 버전 별도 설치, 활성 설치본 선택 | 독립 실행 ZIP/폴더, BOOTH 등의 다운로드 파일 |
| 설치 프로그램·공식 런처 연계 | 해당 프로그램 열기, 사용자 작업 이후 설치 상태 재확인 | GOG offline installer, Steam/Epic/Galaxy/GAME PLAYER 관리본 |
| 공식 다운로드 엔진 연동 | 문서화된 인증·라이브러리·설치·업데이트 API를 adapter로 연결 | 후속 itch.io `butlerd` provider |

한 사이트라도 ZIP과 인증형 설치 프로그램을 함께 제공할 수 있다. 사이트 이름만으로
관리 방식을 확정하지 않고 **받은 파일 형식 + 상품/에디션 + 본체 설치 관리자**를 함께 본다.
공식 런처를 열었다는 응답과 설치·업데이트를 확인했다는 결과는 다르게 표시한다.

첫 구현은 로컬 패키지 관리다. v0.1.7은 확인된 공식 페이지와 일부 런처 인계를
추가하며, 설치 완료 관찰과 공식 통합 경로가 있는 itch.io provider는 후속이다.
모든 스토어의 로그인·다운로드 체계를 한 번에 대체하지 않는다.

## 2. 사이트별 확인 결과

다음의 확인된 사실과 IndieDeck 적용 판단은 별개다. 특정 파일이 독립 실행 가능하다는
사실이 모든 상품의 DRM·온라인 기능·세이브 호환성을 보장하지는 않는다.

| 사이트 | 공식 자료에서 확인한 사실 | 설치·업데이트 준비 방향 |
| --- | --- | --- |
| Steam | 클라이언트 기반 업데이트 운영과 선택적인 Steam DRM wrapper를 문서화한다. 소유 게임 목록 API는 게임 파일 다운로드 권한과 다르다. [업데이트](https://partner.steamgames.com/doc/store/updates), [DRM](https://partner.steamgames.com/doc/features/drm), [소유 목록 API](https://partner.steamgames.com/doc/webapi/IPlayerService?language=english) | AppID와 설치 기록을 확인하고 공식 클라이언트로 위임. 관리 중인 본체를 ZIP 패치 대상으로 삼지 않는다. 직접 EXE 실행 가능 여부는 게임별 확인이다. |
| Epic Games Store | 공식 런처의 게임별 자동 업데이트가 있으며, Epic 호스팅 문서에 URI activation 동작이 있다. [업데이트](https://www.epicgames.com/help/c-32735058/c-31292734/a12539006?lang=en-US), [protocol 문서](https://assets-unreal2-epic-prod-us2.s3.dualstack.us-east-1.amazonaws.com/original/4X/f/c/4/fc4342c50e1a0abf34943e019ee90bacccc62950.pdf) | 1차는 런처/상품 페이지 열기와 완료 후 재감지. 문서의 installer/updatecheck action은 대상 클라이언트 버전에서 검증한 뒤 사용한다. |
| GOG | Galaxy는 선택 사항이고 offline installer·DLC로 클라이언트 없이 설치·업데이트할 수 있다. [GOG 설명](https://docs.gog.com/introduction/), [구매 파일 설치 안내](https://support.gog.com/hc/en-us/articles/213148105-How-do-I-download-my-purchased-items) | 받은 setup 및 필요한 분할 BIN을 묶어 기록하고 설치 프로그램을 사용자에게 인계. Galaxy가 관리하는 설치는 Galaxy 소유로 유지한다. |
| itch.io | 공식 앱 URI와 서드파티 런처용 butlerd 연동을 모두 문서화한다. [공식 앱 연계](https://itch.io/docs/itch/integrating/protocol-urls.html), [독립 런처 연동](https://itch.io/docs/butler/launcher-integration.html) | 받은 ZIP은 로컬 관리, 기존 공식 앱 설치는 인계. 별도 DB·설치 위치를 사용하는 butlerd provider를 후속 후보로 둔다. |
| BOOTH | 구매 파일을 재다운로드할 수 있으나 판매자가 삭제한 파일은 받을 수 없다. 판매자는 새 파일로 교체할 수 있다. [재다운로드](https://booth.pixiv.help/hc/ja/articles/360009206893), [파일 교체](https://booth.pixiv.help/hc/ja/articles/115003627093) | 받은 파일을 상품에 연결해 버전별 보존. 구매 페이지에서 받은 새 파일을 업데이트 후보로 추가한다. 공개 소비자 다운로드 API는 이번 조사에서 확인하지 못했다. |
| DMM/FANZA 일반 다운로드 | DMM의 PC 다운로드 안내에는 분할 SFX/ZIP 결합 방식이 있고, 인증 형식도 상품에 따라 다르다. FANZA에는 작품별 업데이트 메일 설정이 있다. [분할 배포](https://dlsoft.dmm.com/info/divide), [인증 형식](https://support.dmm.com/dlsoft/article/38102), [업데이트 알림](https://support.fanza.jp/doujin/article/48333) | 로컬 ZIP과 vendor installer/patch를 구분. 분할 조각을 보존하고 자동으로 SFX·배치를 실행하지 않는다. 알림 수신을 새 버전 설치 완료로 표시하지 않는다. |
| DMM GAME PLAYER 대응 상품 | activation code를 공식 PLAYER에서 등록하고 마이게임에서 실행하는 절차가 있다. [공식 사용법](https://support.dmm.com/dlsoft/article/46078) | 인증·설치는 공식 PLAYER에 맡긴다. IndieDeck은 등록/설치 화면 인계와 결과 재확인을 담당한다. |
| DLsite/Nest | 이번 환경에서는 플랫폼 공식 도움말과 Nest 페이지 본문을 확인하지 못했다. 한 개발사 매뉴얼에는 해당 작품의 Nest 업데이트/재다운로드 및 세이브 이전이 안내돼 있다. [개발사 매뉴얼: 해당 작품 한정](https://kurogamestudio.com/2020/08/03/craft-onlinemanual/) | 받은 일반 파일 관리부터 지원할 수 있다. Nest의 현행 규격·범용 자동 업데이트·인증 정책은 **공식 원문 재확인 필요**로 남긴다. |

BOOTH의 [플랫폼 DRM 안내](https://booth.pixiv.help/hc/ja/articles/231284508-DRM%E6%A9%9F%E8%83%BD-%E3%83%87%E3%82%B8%E3%82%BF%E3%83%AB%E4%BD%9C%E5%93%81%E4%BF%9D%E8%AD%B7%E6%A9%9F%E8%83%BD-%E3%81%AF%E3%81%82%E3%82%8A%E3%81%BE%E3%81%99%E3%81%8B)는
플랫폼 자체 기능에 관한 설명이다. 개별 제작자가 넣은 보호 기능까지 없다는 뜻은 아니다.

DMM GAME PLAYER의 [지원 환경](https://support.dmm.com/games/article/44796)은
Windows 11/macOS 14 이상을 안내하고 외장 HDD에서의 기동 등을 지원 대상 밖으로 둔다.
이는 PLAYER의 조건이며, 모든 개별 게임의 외장 설치 가능성을 단정하는 근거로 쓰지 않는다.
현재 세션은 외장 D 접근을 중단한 상태이므로 실제 설치 위치 확인도 C에서만 준비한다.

DLsite 재확인용 공식 링크는 [Nest](https://www.dlsite.com/home/guide/dlnest),
[다운로드](https://cs.dlsite.com/hc/ja/articles/10077048450713),
[압축 해제](https://cs.dlsite.com/hc/ja/articles/360063207033),
[PlayDRM](https://cs.dlsite.com/hc/ja/articles/1500003131062)다.
이번 조사에서는 본문 접근 실패로 그 내용·최신 버전을 사실로 인용하지 않았다.

## 3. 기존 런처와의 관계

[Playnite 공식 FAQ](https://api.playnite.link/docs/manual/gettingStarted/helpAndTroubleshooting/faq.html)는
기존 클라이언트를 보완하는 통합 목록의 역할을 설명한다. 이 모델은 초기 스토어 인계에
적합하다. [Heroic 공식 위키](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/wiki)는
Epic·GOG·Amazon을 각각 Legendary·gogdl·Nile로 연결하는 구조를 설명한다.
후자는 provider 분리의 참고이며, 해당 도구가 스토어의 공식 소비자 API라는 뜻은 아니다.

**권고: 화면은 통합하고, 게임 본체에 대한 쓰기 소유자는 설치본마다 하나로 둔다.**

- IndieDeck 관리본: 새로운 디렉터리에 설치하고 활성 버전을 선택한다.
- Steam/Epic/Galaxy/공식 itch 앱/PLAYER 관리본: 본체 교체·삭제는 해당 관리자에 위임한다.
- 번역기·모드 overlay의 파일 영수증은 본체 관리자와 별개다. 기존 번역기 설치 기능을
  없애지 않되, 외부 업데이트 중에는 같은 게임에 대한 추가 쓰기를 대기시킨다.
- 외부 업데이트 후에는 엔진·실행파일·변경 해시·기존 영수증을 다시 감사한다.
  달라진 원본 파일의 이전 백업을 새 게임의 정상 원본으로 자동 승격하지 않는다.
- 같은 작품의 Steam판과 BOOTH판, 본편과 DLC, 체험판과 제품판은 자동 병합하지 않는다.

### itch.io 별도 검토

공식 앱의 `itch://install?game_id=...`는 사용자 확인용 설치 화면을 여는 경로다.
독립 provider는 butlerd가 제공하는 인증·설치·업데이트 흐름을 검토할 수 있다.
공식 사양과 실제 사용할 바이너리 버전의 API 호환성은 구현 시 고정해 검증한다.

2026-11-02에 [공식 v15.32.0 릴리즈](https://github.com/itchio/butler/releases/tag/v15.32.0),
[Windows 배포 채널](https://broth.itch.zone/butler/windows-amd64/LATEST),
[해당 태그의 메서드 등록](https://github.com/itchio/butler/blob/v15.32.0/butlerd/messages/messages.go)을
확인했다. 문서의 OAuth 로그인, 소유 파일 조회, 설치 queue/plan/perform와 업데이트 메서드가
릴리즈 소스에 있으며 배포 채널 버전도 일치했다. **바이너리 다운로드·실행은 하지 않았다.**
실제 OAuth/설치/업데이트 호환성은 다음 단계에서 검증해야 한다. 해당 태그의
[라이선스](https://github.com/itchio/butler/blob/v15.32.0/LICENSE)는 MIT이고, 배포 전에는
필요한 고지와 함께 묶을 종속 구성요소도 확인한다.

후속 provider는 OAuth+PKCE, 별도 DB와 설치 위치, daemon 인증 및 종료 수명 관리를
설계한다. 공식 앱 DB를 동시에 공유하지 않는다. 일회성 noCave 추출을 선택하면
provider의 업데이트 관리 대상이 되지 않으므로 버전 관리 용도로 쓰지 않는다.
토큰/로컬 daemon secret은 UI·일반 로그·URL에 노출하지 않으며 DB의 보호 방식도 검토한다.
바이너리 실행 호환성·업데이트 경로·종속 구성요소 고지를 확인한 뒤 묶음 배포 여부를 정한다.

### URI와 외부 설치 프로그램

URI는 main이 검증한 상품 식별자로 생성한다. renderer에서 전체 URI·실행파일 경로·
설치 인수·다운로드 URL을 받지 않는다. Steam의 AppID 기반 인계를 우선 조사·검증한다.
Epic protocol의 세 ID 형식과 오래된 단일 ID 형식을 혼동하지 않고, 설치·업데이트 action은
실제 지원 클라이언트에서 별도 확인한다. 문서가 없는 공급자는 공식 페이지를 여는 단계로 둔다.

EXE/MSI/SFX는 이름만으로 압축파일이나 완전한 게임을 확정하지 않는다. 사용자가 선택한
공식 설치 프로그램은 그대로 사용자에게 실행을 인계하고 결과를 다시 확인한다.
일반적인 무인 설치 옵션을 추측하지 않으며, 프로세스 종료 코드 0만으로 설치 경로·
완료·롤백 가능성을 보장하지 않는다. vendor patch도 대상 버전 확인 없는 범용 실행 대상이 아니다.

## 4. 현재 코드에서 재사용할 부분과 실제 공백

| 항목 | 조사 시작 당시 v0.1.5 | 설계한 후속 작업 |
| --- | --- | --- |
| Classic ZIP | source SHA·CRC·크기/경로 검증, 격리 stage, 단일 알려진 엔진+EXE 확인, UUID 폴더 게시 | 기존 executor를 설치 job에 연결 |
| 버전 | 별도 폴더/라벨/파일명 버전 추정 | 안정적인 상품 그룹, 릴리즈 관계, 활성 설치본 |
| 형식 | 7z/RAR 식별만; ZIP64·분할·암호화·레거시 비 ASCII ZIP명 거절 | 일본어 CP932 및 대용량·분할 자료를 검증형 extractor로 단계 확장 |
| 상태 | 라이브러리 원자 저장·revision, renderer reload 복구 | 앱/OS 종료 이후 복구 가능한 디스크 journal |
| 작업 큐 | main이 파일 쓰기와 런처 재시작을 제어 | install/update job 및 외부 관리자 상태 관찰 |
| 번역 환경 | 게임별 탐지·계획·파일 영수증 | 새 빌드에서 재탐지, 새 계획과 새 영수증 |
| 스토어 | Steam 썸네일 식별, 일반 게임 파일 감지 | 구매/설치/업데이트 provider는 미구현 |

구현 근거 파일:

- `packages/desktop/src/game-archives.ts`: 검사, streaming ZIP 추출, stage/publish, 원본 보존.
- `packages/desktop/src/main.ts`: OS picker, opaque id, 작업 큐, root/라이브러리 등록.
- `packages/core/src/library/index.ts`: 원자 저장과 단일 게임 갱신.
- `packages/core/src/install/transaction.ts`: 프로세스 내 실패 rollback. 디스크 journal은 아니다.
- `packages/desktop/src/operations.ts`: renderer reload 상태. OS 재시작 복구는 아니다.
- `packages/desktop/src/launcher-updates.ts`: IndieDeck 자체 GitHub/NSIS 업데이트 전용이다.
  게임 업데이트에는 busy/restart gate 패턴만 참고한다.

`core/src/install/sevenzip.ts`는 폰트 등 지정 릴리즈 추출용이다. 일반 게임 archive의
전체 엔트리·링크·출력 크기 검증과 동일하다고 가정해 연결하지 않는다.

## 5. 데이터 계약 초안

아래는 후속 단계까지 포함한 목표 모델이며 현재 저장 파일 형식과 동일하지 않다.
M1은 로컬 ZIP에 필요한 상품·릴리즈·설치·작업을 별도 catalog로 구현한다.

| 모델 | 주요 필드 | 구분 이유 |
| --- | --- | --- |
| Product | 내부 UUID, provider와 외부 상품 ID, 에디션/플랫폼, 연결 근거, activeInstallationId | 현재 경로 기반 gameId와 분리. 크로스스토어 묶음은 표시용 관계로만 연결 |
| AcquiredArtifact | opaque ID, 종류, 모든 분할 구성요소, 크기·파일 SHA-256, 원본명, 정규 상품 페이지 URL, versionEvidence | 파일의 정체성과 상품 소유권/공식성은 다르다. 폴더 사본은 별도 트리 manifest/hash가 필요. 서명된 다운로드 URL·요청 헤더는 저장하지 않음 |
| Release | productId, provider build/upload ID 또는 사용자 라벨, 언어/OS/arch/channel, artifact 관계 | 파일명 버전 추정으로 실제 최신 버전을 확정하지 않음 |
| Installation | productId/releaseId/artifactId, 본체 관리자, root, 실행 대상, 상태, 이전 설치 관계 | 한 상품의 여러 버전과 외부 관리 설치본을 함께 표현 |
| InstallJob | planId, 원본/대상 설치 ID, phase, journalRevision, 오류/복구 결과 | payload 게시와 목록 등록 실패를 별도 복구 |
| ProviderCapabilities | acquisition/install/update 방식, 인증 방식, 문서 근거, 검증된 client/API 버전 | 사이트 하나에 가능한 여러 배포 방식을 설명 |

버전 근거는 `provider-build`, `publisher-declared`, `user-label`, `filename-hint`,
`unknown`처럼 보존한다. 숫자 문자열이 더 크다는 이유만으로 다른 채널·에디션을
새 버전으로 판정하지 않는다. SHA가 다르면 파일이 달라졌다는 증거이며 최신 버전의 증거는 아니다.

설치 소유권 값은 최소 `indiedeck`, `vendor-installer`, `official-client`, `butlerd`를
구분한다. 구매 증명/권한 정보와 썸네일의 스토어 AppID 선택은 연결 근거가 서로 다르다.
현재 썸네일 AppID를 설치 권한이나 상품 확정 값으로 자동 승격하지 않는다.

## 6. 로컬 설치와 업데이트 흐름

1. 사용자가 파일과 상품을 선택한다. 전체 패키지·설치 프로그램·패치·불명확을 구분한다.
   M1은 기존 Classic ZIP을 대상으로 하며, 이미 풀린 폴더의 새 사본 설치는 후속이다.
2. main이 source snapshot과 파일 SHA, 같은 상품/에디션 여부, 설치 위치·여유 공간을 확인한다.
3. 원본과 기존 설치를 유지한 채 대상과 같은 볼륨의 숨김 stage에 새 payload를 만든다.
4. 경로/링크/크기·파일 목록과 게임 실행 대상을 검증한다. 미지원 엔진은 실패 또는 수동 등록
   후보로 표시하며, 기존 엔진 탐지의 실패를 빈 정상 설치로 바꾸지 않는다.
5. M1은 세이브·설정을 자동 이전하지 않는다. 후속 이전 기능에서 승인된 버전 내부 데이터
   복사가 필요하면 호환성 근거와 계획을 먼저 보여주고, 활성화 전에 stage 안에서 완료한다.
6. payload를 `publish`하고 최종 경로의 실행 대상·엔진/번역 호환성을 다시 확인해 `register`한다.
7. 상품의 활성 설치 참조를 `activate`로 바꾼다. 이전 설치와 원본 파일은 보관한다.

AppData 등 공용 세이브 경로의 변경은 위 stage 복사에 포함하지 않는다. 별도 백업·계획과
사용자 확인이 필요한 후속 job이며, M1 완료 조건에 포함하지 않는다. 설치·업데이트 시
게임을 자동 실행하지 않고 결과 화면에서 사용자가 실행을 선택한다.

새 패키지는 기본적으로 기존 게임 위에 덮어쓰지 않는다. 설치 위치의 원자적 rename만으로
앱 DB·설정·여러 볼륨 전체가 한 번에 반영된다고 주장하지 않는다.

### journal과 중단 복구

`prepared → staging → payload-verified → published → registered → activated` 및
`cancelled / failed / recovery-required`를 디스크에 기록한다. payload 게시 후 목록 저장이
실패하면 재시작 시 게시한 디렉터리를 찾아 등록을 재시도할 수 있어야 한다. 활성 버전 변경은
상품 레코드의 원자 갱신으로 처리하고, 이전 참조와 설치는 복구가 끝날 때까지 남긴다.

드라이브 분리·공간 부족·source 교체 시 이전 활성 설치와 목록을 유지한다. 볼륨이
돌아왔다고 곧바로 경로가 같은 다른 디스크에 쓰지 않도록 볼륨 식별도 다시 확인한다.
commit이 시작된 뒤 취소를 성공한 것처럼 표시하지 않고 저장·복구 상태를 구분한다.
남은 stage 정리는 journal의 UUID·소유 marker·현재 볼륨과 관리 root가 모두 일치할 때만
허용한다. 이름이 비슷한 폴더나 원본 패키지는 자동 정리 대상이 아니다.

## 7. 세이브·번역기·모드와 패치

- 세이브는 게임 내부, AppData, Documents, 클라우드 등 위치가 다르다. 엔진 이름만으로
  모든 게임의 저장 경로와 신구 버전 호환성을 확정하지 않는다.
- 아카이브가 임의 AppData/세이브 목적지를 지정하게 하지 않는다. 검증된 게임별 규칙과
  사용자가 선택한 경로만 이전 계획에 사용한다. 이전 세이브는 먼저 보존한다.
- 사용 중인 게임의 저장 데이터가 복사 도중 바뀌면 이전을 중단하고 다시 확인한다.
- BepInEx/번역기 DLL·MTool 결과·모드·`.indiedeck` 영수증 전체를 신버전에 일괄 복사하지
  않는다. 새 게임을 다시 감지해 맞는 로더/번역기 계획을 만들고, 설정은 의미가 확인된 항목만 이전한다.
- 차분 패치는 완전한 게임 파일과 다르다. 대상 릴리즈·필수 원본 해시·삭제 목록이 검증된
  패치 계획이나 공급자 엔진을 사용할 때만 적용한다. 변경된 번역/모드 파일이 있는 본체에는
  패치를 억지로 대입하지 않고 새 전체 패키지 또는 공식 복구를 안내한다.
- EXE/SFX/결합 배치는 추출 단계에서 실행하지 않는다. 사용자가 실행을 선택하는 인계와
  검증 가능한 archive 해제는 다른 executor로 둔다.

## 8. 구현 파일·IPC·사용 화면

후속 계층 분리를 위한 예정 파일(이 경로 구조로 생성한 것은 아님):

```text
packages/core/src/acquisition/
  types.ts       Product/Release/Artifact/Installation/Job
  artifacts.ts   로컬 source 검사와 분할 구성요소
  plans.ts       읽기 전용 설치·이전 미리보기
  journal.ts     영속 상태와 재시작 복구
packages/desktop/src/store-handoff.ts
packages/desktop/renderer/panels/installations.js
```

기존 ZIP executor를 감싸고, 안정성이 확인된 뒤 필요 부분만 core로 이동한다.
renderer에는 `artifactId`, `productId`, `planId`, `jobId`만 전달한다. 예정 IPC는
`artifacts:pick`, `products:linkArtifact`, `installations:preview/start/current/activate`,
`stores:handoff`다. 경로·인수·URL 결정은 main/provider가 담당한다.

화면은 `다운로드 파일 추가 → 상품/버전 확인 → 설치 계획 → 진행 → 활성 버전 선택`으로
시작한다. 업데이트 항목은 다음과 같이 표시한다.

- 로컬 관리: **새 파일로 업데이트 / 버전 비교 / 이전 버전 선택**.
- 외부 관리: **공식 런처에서 계속 / 작업 후 다시 확인**.
- 버전 근거 불충분: **업데이트 여부 확인 불가 / 새 파일 검사**.
- 외부 작업은 실행 요청·작업 중·설치 확인·확인 필요를 구분한다.

추후 다운로드 폴더 감시는 사용자가 고른 폴더에서만 한다. 다운로드 중인 임시 파일과
완성된 분할 파일을 구별하고 안정된 구성요소 전체를 다시 검사한다. 자동 감지는 후보를
추가하는 단계이며, 곧바로 설치하거나 새 버전이라고 확정하는 단계가 아니다.

## 9. 개발 순서와 완료 조건

| 순서 | 범위 | 완료 조건 |
| --- | --- | --- |
| M1, CURRENT v0.1.6 | 상품 그룹·릴리즈·활성 설치본·영속 journal + 기존 Classic ZIP 연결 | 새 버전 설치/활성화/이전 버전 선택, 재시작 복구, 이전 데이터 보존을 fixture로 확인 |
| M2 | 선택한 다운로드 폴더의 새 파일 후보 + 검증형 archive/풀린 폴더 사본 확장 | CP932/ZIP64/7z/RAR/분할/폴더 트리 각각 경로·링크·용량·충돌·취소 검증, 지원하지 않는 형식은 명시 |
| M3, PARTIAL v0.1.7 | 확인된 공식 페이지·일부 런처 인계·상품 연결 파일은 구현. 로컬 installer 인계와 완료 관찰은 후속 | 검증한 상품 ID만 사용, 인계와 실제 완료 구분, 외부 업데이트와 overlay 쓰기 충돌 방지 |
| M4 | 별도 itch.io butlerd provider | API/바이너리·배포 조건 고정, OAuth/state·DB·daemon 수명·진행/취소·업데이트를 실제 허가된 샘플로 확인 |
| 후속 | 검증된 vendor patch·추가 스토어 API | 플랫폼 공식 경로/조건과 제품별 원본 검증이 갖춰진 provider부터 확장 |

M1의 핵심 실패 검사는 원본 변경, 잘못된 상품 연결, 파일명 버전 오인, 공간 부족/디스크 분리,
취소, publish 후 register 실패, 활성 참조 저장 실패, 재실행 시 중복 설치 방지다.
압축 확장은 경로 탈출·링크·대소문자/인코딩 충돌·Windows 예약명·압축 폭탄·누락 분할을 포함한다.
UI는 오래된 진행 응답이 다른 게임이나 더 최신 상태를 덮지 않도록 기존 revision 경계를 유지한다.

## 10. 구현 전 남은 확인

- DLsite/Nest의 현재 공식 본문·연동 규격·인증별 동작.
- 실제 구매 파일의 형식별 비중. 사용자 파일 대신 합성 fixture로 먼저 구현하며,
  이후 사용자가 고른 비공개 샘플로만 호환성을 검증한다.
- 설치 위치와 source 보관 위치 정책. 현재는 C 안에서 준비하고 D 접근은 재개하지 않는다.
- 게임별 세이브 이전과 vendor patch 범위. 일반 규칙이 없는 경우 수동 경로로 둔다.
- itch.io OAuth 앱 등록, 고정 butler 바이너리의 실제 실행과 API 호환성, 종속 구성요소 고지.
  문서/태그/배포 채널 확인과 별개로 지금은 앱 등록·계정 인증·바이너리 실행을 하지 않는다.
- 서명된 다운로드 URL은 경로에도 토큰을 담을 수 있다. 일시적 전송 정보는 별도 민감 상태로
  취급하고 일반 artifact 레코드·로그에 URL 전체나 요청 헤더를 남기지 않는다.
- Steam/Epic/GOG의 개발자 배포 SDK·메타데이터 API를 소비자 구매 파일 다운로드 API로
  오해하지 않는다. 이번 조사에서 이 셋의 범용 소비자 직접 다운로드 계약은 확인하지 못했다.

## 11. 현재 M1 구현

다음은 이번 C 작업본에 구현한 범위다. 문서의 모든 스토어 통합이나 압축 형식이
지원된다는 의미로 확대하지 않는다.

- `packages/desktop/src/game-installations.ts`: 로컬 상품·릴리즈·설치·작업 catalog,
  활성 설치 참조, 원자 저장과 설치 중단 복구. renderer가 주는 경로를 저장 대상으로
  사용하지 않는다.
- `packages/desktop/src/game-archives.ts`: 기존 검증형 ZIP executor에 main이 예약한
  설치 UUID와 영속 checkpoint를 연결한다. `.staging-<UUID>` 정리는 journal의 UUID,
  소유 marker, 보통 경로의 조상과 저장 장치 식별이 일치할 때만 한다.
- `packages/desktop/src/main.ts`와 `preload.cjs`: 파일 picker 후보·상품·설치 ID만 받는
  기존 archive IPC를 확장한다. 설치·등록·복구·활성 변경은 같은 mutation gate를 쓴다.
- `packages/desktop/renderer/panels/archives.js`: 새 상품 또는 기존 상품의 추가 버전,
  같은 작품·에디션의 전체 패키지 확인, 버전별 상태·활성 전환·복구 재시도.
  관리 게임의 상세 화면에서도 다른 버전을 보고 선택할 수 있다.

첫 설치는 활성으로 등록한다. 같은 상품의 후속 설치는 기존 활성본을 유지하고,
사용자가 **이 버전 사용**을 눌러야 활성 참조를 바꾼다. 라이브러리는 물리적인
설치본을 모두 표시하므로, 비활성 버전도 직접 열어 확인할 수 있다. 활성 전환은
게임 파일 덮어쓰기·기존본 삭제·자동 실행이 아니다.

같은 제목·파일명·썸네일 ID로 상품을 자동 합치지 않는다. 사용자가 같은 상품으로
연결했더라도 엔진 이름만으로 신구 데이터의 호환성을 보장하지 않는다. ZIP 안의
내용만 새 폴더에 설치하며, 이전본의 세이브·설정·모드·번역기 파일·영수증은 복사하지
않는다. 게임이 AppData 등의 공용 세이브를 쓴다면 폴더 분리만으로 그 저장 데이터가
격리되는 것은 아니다.

publish 후 라이브러리 등록이 실패한 설치는 게시한 파일을 유지하고 복구 대상으로
남긴다. 다음 실행 또는 사용자의 복구 재시도에서 검증된 설치 기록을 다시 확인해
등록한다. 잘못된 소유권·손상된 catalog·사라진 저장 장치를 성공으로 처리하지 않는다.
실제 정전·USB 분리 실험이나 실제 구매 게임의 번역 실행은 별도 검증 대상이다.

검증 근거는 `packages/core/test/game-installations.test.ts`의 합성 ZIP/catalog
fixture와 기존 archive 안전성 검사, `scripts/check-desktop-flow.mjs` 및 main의
오프라인 한국어·영어 화면 흐름이다. 상품 연결·활성본 유지·새 버전 선택·reload·
이전본 복귀, source 없이 등록 복구, 반복 복구, 활성 참조 원자 저장 실패,
다른 저장 장치·용량 부족·잘못된 marker·junction을 다룬다. 이를 실제 게임의
세이브 호환성이나 스토어 인증 성공으로 해석하지 않는다.

2026-11-02 C 작업본의 Windows 로컬 확인 결과:

- `npm run build`, 레지스트리 자체 검사 통과.
- 전체 테스트 **369개: 367 통과, 0 실패, 2 건너뜀**. 건너뛴 두 검사는
  이 계정의 파일 심볼릭 링크 권한 제한이다. 새 설치 관리 테스트 11개와
  renderer 상태 테스트 4개를 포함한다.
- 한국어·영어 Electron 오프라인 흐름 통과. 상품 연결, 활성 버전 변경,
  화면 reload 후 유지와 이전 버전 복귀를 실제 IPC/UI로 확인했다.
- 버전 증가 전의 Windows 실행 폴더 패키징 통과. ASAR의 필수 파일 36개와
  당시 빌드의 주요 runtime 44개 SHA-256 일치를 확인했다. 이는 v0.1.6 배포물의
  검증 결과가 아니다. v0.1.6의 Windows/Linux·Node 22/24 검사, NSIS·portable·
  updater feed 및 설치/제거 검사는 별도 릴리즈 CI에서 확인한다.
- 검증 환경은 Windows, Node 25.8.2, Electron 43.8.6이다. 새 변경의 Linux
  실행 및 실제 스토어/구매 게임 설치 결과는 이 로컬 확인으로 대체하지 않는다.

스토어 로그인 화면·공식 페이지·일부 클라이언트 호출은 v0.1.7의
[브라우저·스토어 연계](browser-store-integration.md)에서 다룬다. IndieDeck 내부 OAuth
인증·구매 파일 직접 다운로드·공식 클라이언트 자동 업데이트 완료 관찰은 아직 구현하지
않았다. 앞의 공식 자료는 이 후속 경계를 정하는 근거이며 해당 실행 증거가 아니다.
