# IndieDeck 런처 설치·복구 UX 구현 가이드

> 문서 상태: **PARTIAL** — 구현과 후속 설계가 함께 있는 가이드
>
> 최신 확인: 2026-10-05, v0.1.2(`b37a6d0`) 이후 작업 브랜치
>
> §3은 실제 구현 상태이며, 나머지 절의 원자적 maintenance·업데이트·복구
> 계약은 완료되지 않은 설계도 포함한다. 구현한 범위를 §3.1에 기록한다.

## 1. 목적

이 가이드는 런처에서 번역기를 설치하고 관리할 때 사용자가 다음 결과를
얻도록 하는 구현 방향을 정한다.

1. 설치 버튼을 누르는 즉시 로딩 바와 현재 단계가 보인다.
2. 설치·업데이트·복구가 끝나면 상세 화면, 게임 목록, 상태 배지, 감사
   결과와 통계가 수동 스캔 없이 동시에 최신 상태로 바뀐다.
3. 런처의 상단 바에는 매번 쓰는 기능만 남고, 전역 기본값과 라이브러리
   관리는 별도 설정 페이지에서 다룬다.
4. 기존 번역기가 오래됐거나, 실제 파일과 기록의 버전이 다르거나, 여러
   변형이 중복 설치된 경우에도 런처 안에서 안전한 해결 절차를 제시한다.
5. 게임 상세 내용을 아래로 스크롤해도 **게임 실행**과 **폴더 열기**가
   계속 보인다.

가장 중요한 원칙은 편의성 때문에 기존 안전 경계를 약화하지 않는 것이다.
인식하지 못한 사용자 파일을 자동으로 삭제하거나, 기존 설치 영수증을
덮어쓴 뒤 복구할 수 없는 상태를 만들면 안 된다.

## 2. 상태 표기

이 문서에서는 구현 성숙도를 다음처럼 구분한다.

| 표기 | 의미 |
| --- | --- |
| **CURRENT** | 현재 코드에서 동작과 안전성이 확인되는 기능 |
| **PARTIAL** | 기반은 있으나 사용자 요구를 완전히 만족하지 못하는 기능 |
| **PLANNED** | 이 가이드가 제안하며 아직 구현되지 않은 기능 |
| **RESEARCH** | 도구별 소유권·보존 경계를 검증해야 하며 아직 자동 동작을 약속하지 않는 영역 |

로딩 바, 설정 페이지, 설치·제거 후 단일 게임 인덱스 갱신과 고정 액션
바는 구현됐다. 설치 상태 조정 계획, 원자적 업데이트·복구·중복 정리,
프로세스 종료 후 journal 복구는 **PLANNED**다.

## 3. 현재 기준선

| 영역 | 현재 상태 | 근거와 한계 |
| --- | --- | --- |
| 게임 폴더 파일 롤백 기반 | **CURRENT** | FileTransaction 안에서 수행된 게임 폴더 write·extract가 잡힌 프로세스 내 오류를 만나면 journal을 거꾸로 적용해 복원을 시도한다. crash 복구나 설치 전체 commit을 뜻하지 않는다. |
| 설치·영수증 전체 원자성 | **PARTIAL** | 파일 commit 뒤 영수증을 기록한다. 기록 실패는 committed 파일과 receiptStatus를 보존한 실패 outcome으로 표시한다. toolsDir 쓰기와 crash 복구는 게임 transaction 밖이며 완전 복원으로 표시하지 않는다. |
| IPC 신뢰 경계 | **CURRENT** | 게임 상세·설치·실행 대상은 렌더러가 경로나 계획 객체를 보내지 않고 main이 발급한 gameId와 planId로 지정한다. |
| 다운로드 바이트 진행 | **CURRENT** | requestId·operationId·sequence·gameId를 갖는 단계 이벤트와 실제 progress 요소를 사용한다. 자산별 바이트와 단계 수를 분리하고 크기를 모르면 불확정 바를 사용한다. |
| 설치 로그 | **CURRENT** | 상태 기반 작업 카드의 접는 로그이며 화면 전환·재렌더에도 유지된다. 로그는 보조 정보이고 terminal outcome이 완료를 결정한다. |
| 설치·제거 직후 상세 갱신 | **CURRENT** | 실패·복원 이후에도 deep 재감지하며 상세·감사·receipt·mods·redacted config를 함께 반환한다. 선택 token과 gameRevision이 늦은 응답을 거른다. |
| 설치·제거 직후 목록 갱신 | **CURRENT** | refreshLibraryGame이 해당 항목만 교체/제거하고 revision을 원자 저장한다. postState의 목록·감사·통계를 함께 병합한다. 다른 게임을 선택해도 설치 대상의 목록 갱신은 반영된다. |
| 오래된 번역기 탐지 | **PARTIAL** | 게임별 호환 목표 버전 비교는 구현됐다. 안전한 update·repair 실행과 연결하는 maintenance 조정 계획은 남아 있다. |
| 중복 번역기 탐지 | **CURRENT** | `packages/core/src/health`가 변형·DLL 버전·영수증 증거를 개별 수집하고 duplicate-variants, multiple-versions, managed-drift 등을 분류한다. 단위 테스트는 `packages/core/test/health.test.ts`(§13.3 fixture 12종). 정리 동작 자체는 여전히 **PLANNED**다. |
| 재설치 안전성 | **PARTIAL** | desktop은 기존 managed component 영수증 재설치와 중복·drift·다른 변형 덮어쓰기를 차단하고 사유를 먼저 표시한다. core/CLI의 일반 applyPlan은 maintenance가 아니며 update·repair·정리 버튼으로 승격하지 않는다. |
| 설치 후 사용자 수정 보호 | **PARTIAL** | create·modify의 설치 후 hash 변경은 보존한다. post hash가 없는 snapshot은 baseline과 다르면 보존하고, 미해결 entry의 receipt를 남긴다. 변경 미리보기와 receipt v3의 원자 계승은 남아 있다. |
| 상단 바 | **CURRENT** | 브랜드(버전 표기 포함), 검색, 새로고침, 설정만 남았다. 언어·엔드포인트 기본값과 폴더 관리는 설정 페이지가 소유한다. |
| 게임 액션 | **CURRENT** | 게임 실행과 폴더 열기가 상세 화면의 sticky 영역에 고정되어 스크롤 중에도 보인다. 작업 중에는 실행이 비활성화되고 이유가 인접 문구로 안내된다. 제거 동작은 계획 섹션으로 옮겨져 고정 영역 밖이다. |
| 추천 TMP 폰트 | **CURRENT** | 감지한 Unity·TMP·대상 언어와 등록 범위로 추천하며, 번역기 동시 설치 선택과 기존 호환 XUnity의 폰트 단독 추가·폴백 연결을 제공한다. 등록/추정 범위와 실제 게임 출력 미검증을 표시한다. |
| RPG Maker 로컬 MTool 연계 | **CURRENT** | MV/MZ·RGSS 상세 카드와 설정의 기존 MTool 연결, 게임 실행 파일 단일 인수 전달·도구만 열기·위치 열기·적용 후 갱신을 제공한다. 복사 설치·자동 번역이 아니며, 실제 자동 선택과 번역 동작은 미검증이다. Wolf RPG는 제외한다. |

### 3.1 이번 구현 범위와 검증 근거

- core의 `ApplyProgress`와 다운로드 lifecycle은 자유 로그와 분리한다.
  캐시 적중·크기 미상·복수 자산·rollback/receipt 실패는
  `apply-progress.test.ts`, `download.test.ts`, `transaction.test.ts`로 검증한다.
- main의 `OperationManager`는 즉시 시작 응답, 전역 한 작업, 단조 sequence,
  snapshot, ACK 전 outcome 보관을 제공한다. 미확인 결과가 10개가 되면
  다음 시작을 거부해 결과를 잃지 않고 보관량을 제한한다.
  `desktop-operations.test.ts`가 작업 수명과 reload 복구 경계를 검증한다.
- desktop 제거는 `readSafeRemovalReceipts`로 읽은 동일 객체만 적용한다.
  canonical v2·operation·hash·backup 범위를 검증하고 실행 파일 및 이를
  포함하는 디렉터리, symlink/junction 경로를 차단한다. v1 자동 제거는
  증거 부족으로 중단한다. `desktop-receipts.test.ts`가 이 경계를 검증하며,
  검증 이후 외부 프로세스의 target 교체까지 원자적으로 막는 것은 아니다.
- 폰트·단일 파일 모드 복사도 설치 후 hash를 기록한다. 정상적인 한글·공백
  모드 이름은 안전한 단일 파일명 규칙으로 허용하며, directory copy는
  파일별 소유권 기록 없이 수행하지 않는다. 추출·복사·hash 실패는
  rollback 경로로 전달하고, 7z 준비 도구가 없을 때만 수동 안내로 남긴다.
- renderer는 앱 수명 listener를 하나씩 등록하고 작업을 상태로 렌더링한다.
  실제 바, 단계, 바이트, 접는 로그, 추가 작업·부분 복원·갱신 실패 카드,
  대상 목록 배지와 설정 화면의 상단 작업 버튼을 제공한다.
- `library.test.ts`와 `renderer-state.test.ts`는 targeted 저장, revision,
  A→B→A 선택 역순 응답, postState 병합과 오래된 작업 이벤트를 검증한다.
- `node scripts/check-desktop-flow.mjs ko` 및 `en`은 일회용 게임과 가짜
  다운로드로 실제 Electron/IPC/core 설치→설정 이동→renderer reload→
  즉시 목록 갱신→작은 창 sticky 액션→제거 흐름을 검증한다. 실제 번역기
  실행이나 실제 GitHub 다운로드 성공을 증명하는 테스트는 아니다.
- 취소 UI, durable journal, 프로세스/OS crash 이후 복구, 증분 hash cache,
  손상 인덱스의 엄격한 재구성은 남아 있다. 단일 게임 저장 revision은
  디스크에 유지되고, gameRevision은 현재 main 프로세스의 snapshot token이다.
- 이번 이벤트는 `maintenance:start({kind,gameId,planId?,requestId})`와
  `maintenance:current/outcome/acknowledge`다. §5의 actionId 기반 원자적
  maintenance 계획은 후속 계약이며, 현재 설치·제거에만 이 수명 모델을 적용한다.

### 3.2 현재 재설치를 업데이트로 사용하면 안 되는 이유

현재 영수증 파일 이름은 kind와 componentId 조합으로 고정된다. 같은
번역기를 다시 적용하면 새 영수증이 이전 영수증을 대체할 수 있고, 새
트랜잭션이 백업하는 기준은 “IndieDeck 설치 전 원본”이 아니라 “직전
번역기 버전”이 될 수 있다. 그 결과 나중에 제거할 때 최초 상태가 아니라
이전 번역기 버전으로 돌아가거나, 과거 파일의 소유권 정보를 잃을 수 있다.

따라서 업데이트·복구·중복 정리는 기존 uninstall과 install을 단순히
연속 호출해서도 안 된다. 하나의 복구 가능한 조정 트랜잭션과 영수증
계승 규칙이 먼저 필요하다.

## 4. 목표 화면 구조

### 4.1 라이브러리 화면

    ┌──────────────────────────────────────────────────────────────┐
    │ IndieDeck   [ 게임 검색........................ ]  [새로고침] [설정] │
    ├──────────┬────────────────┬─────────────────────────────────┤
    │ 필터     │ 게임 목록       │ 게임명             [실행] [폴더 열기] │
    │          │                │ ─ 고정 액션 바 ───────────────── │
    │          │                │ 설치 상태 / 감사 / 번역기 계획     │
    │          │                │ [설치·업데이트 진행 바]             │
    │          │                │ 설정 / 모드 / 로그                  │
    └──────────┴────────────────┴─────────────────────────────────┘

상단 바에는 다음만 유지한다.

- IndieDeck 브랜드
- 게임 검색
- 간결한 라이브러리 새로고침 버튼
- 설정 페이지 버튼

진행 중인 작업이 있을 때만 검색 오른쪽에 작은 작업 상태를 임시로 표시할
수 있다. 이는 영구 설정 컨트롤이 아니라 현재 설치를 놓치지 않게 하는
상태 표시다.

“폴더 추가”는 빈 라이브러리 안내와 설정의 라이브러리 섹션에서 제공한다.
원문 언어, 번역 언어, 엔드포인트와 UI 언어는 설정 페이지로 이동한다.

### 4.2 설정 페이지

설정 버튼은 앱 수준의 별도 페이지를 연다. 게임 상세 패널 안의 번역기별
설정과 전역 설정을 섞지 않는다.

    설정
    ├─ 일반
    │  └─ UI 언어
    ├─ 번역 기본값
    │  ├─ 기본 원문 언어
    │  ├─ 기본 번역 언어
    │  └─ 기본 엔드포인트
    ├─ 외부 도구
    │  └─ 기존 MTool 폴더 연결 / 연결 해제 / 도구만 열기
    └─ 라이브러리
       ├─ 등록 폴더 목록
       ├─ 폴더 추가 / 제거
       ├─ 스캔 깊이
       └─ 전체 다시 스캔

게임별 AutoTranslator 설정, 자격 증명 입력, 모드 관리 등은 계속 선택한
게임의 상세 화면에 둔다.

## 5. 설치 로딩 바와 진행 상태

### 5.1 사용자 경험 계약

설치, 업데이트, 복구 또는 중복 정리 버튼을 누르면 같은 렌더 프레임 안에
다음 변화가 나타나야 한다.

- 누른 버튼이 중복 클릭되지 않도록 비활성화된다.
- 해당 게임의 작업 카드와 상세 고정 영역에 로딩 바가 나타난다.
- “다운로드 중”, “무결성 확인 중”, “기존 설치 백업 중”처럼 현재 단계를
  현재 UI 언어로 보여 준다. 한국어 UI에서는 한국어 문구를 사용한다.
- 가능한 경우 받은 바이트와 전체 바이트를 함께 표시한다.
- 상세 로그는 접을 수 있는 보조 정보로 유지한다.
- 게임 실행과 다른 파일 변경 동작은 설치가 끝날 때까지 비활성화한다.
  폴더 열기는 유지할 수 있지만, 작업 중 파일을 수정하면 복구 판정이 달라질
  수 있다는 점을 안내한다.

성공 시 로딩 바를 즉시 없애지 말고 잠깐 완료 상태를 보여 준 뒤 최신
게임 상태 카드로 전환한다. 실패 시 오류 단계와 “변경 사항을 되돌렸는지”
여부를 분리해 보여 주고 재시도 동작을 제공한다.
pendingUserActions가 하나라도 남았다면 complete가 아니라
needs-user-action으로 끝내고, 남은 절차를 사용자가 확인하기 전까지 주의
카드를 유지한다.

### 5.2 구조화된 진행 이벤트

자유 문자열 로그를 퍼센트 계산에 사용하지 않는다. main이 다음과 같은
구조화 이벤트를 발행하고, preload는 고정 채널만 노출한다.

    InstallProgressEvent {
      requestId
      operationId
      sequence
      gameId
      actionId
      planId?
      phase
      stepIndex
      stepCount
      assetId?
      received?
      total?
      fromCache?
      messageKey
      messageParams?
    }

권장 phase는 다음과 같다.

| phase | 의미 | 표시 방식 |
| --- | --- | --- |
| queued | main의 mutation queue에서 실행 대기 | 대기 순서가 아닌 “대기 중” |
| preflight | 대상과 현재 설치를 다시 검증 | 불확정 또는 단계 수 |
| download | 자산 다운로드 | total이 있으면 확정 바, 없으면 불확정 바 |
| verify | 해시·무결성 확인 | 불확정 |
| backup | 원본과 기존 설치 백업 | 단계 수 |
| cleanup | 이전·중복 payload 정리 | 단계 수 |
| extract | 압축 해제·복사 | 단계 수 |
| configure | 설정 보존·패치 | 단계 수 |
| redetect | 해당 게임 재감지 | 불확정 |
| audit | 호환성·설치 상태 재검증 | 불확정 |
| rollback | 실패한 변경 복원 중 | 경고색 불확정 |

rollback이 progress phase와 MutationOutcome의 rollbackStatus 양쪽에 존재하는 것은
의도적 중복이다. 진행 이벤트의 rollback은 "복원이 지금 진행되고 있다"는 실시간
표시만 담당하고, rollbackStatus(complete, partial, not-run)만이 작업 종료 시점의
최종 판정을 담당한다. 어느 한쪽을 제거하면 "복원을 시도했다"와 "모든 것을 복원했다"
의 구분이 무너지므로 renderer는 두 경로를 하나의 흐름으로 연결해서 처리한다.

handshake 전에는 requestId가 provisional 작업과 일치하고 sequence가
lastAppliedSequence보다 큰 이벤트만 반영한다. handshake 뒤에는 requestId와
operationId가 모두 일치하고 sequence가 더 큰 이벤트만 반영한다. main의
파일 변경 큐가 작업을 직렬화하더라도 이 식별자는 필요하다. 선택한 게임을
바꾸거나 빠르게 다시 렌더링할 때 이전 이벤트가 새 카드에 들어가는 것을
막기 때문이다. 이 phase 목록은 진행 중 상태만 나타내며 terminal 결과와
100% 표시는 아래 MutationOutcome만 결정한다.

### 5.3 작업 시작·큐·종료 계약

첫 구현은 **전역 maintenance 작업을 한 번에 하나만** 허용한다. 현재
main의 mutation queue와 일치하는 가장 단순한 규칙이며, 변조된 renderer가
두 번째 요청을 보내도 main이 거부해야 한다. 다른 종류의 선행 mutation을
기다리는 동안에는 queued로 표시한다. 추후 여러 작업을 허용할 때는
Map을 gameId가 아니라 operationId로 만들고 activeByGame을 별도로 둔다.

클릭 즉시 로딩 바를 그리면서 첫 이벤트도 놓치지 않도록 시작 API는
두 단계 handshake를 사용한다.

1. renderer가 권한 의미가 없는 짧은 requestId를 만들고 같은 프레임에
   starting 상태를 렌더링한다.
2. maintenance:start(gameId, actionId, requestId)를 호출한다.
3. main은 actionId와 대상, 전역 작업 슬롯을 검증하고 자체 operationId를
   발급한 뒤 작업 완료를 기다리지 않고 requestId와 operationId를
   응답한다.
4. main은 이후 작업을 mutation queue에서 수행하며 모든 이벤트에 두 id를
   함께 싣는다.
5. renderer는 응답 전 이벤트도 requestId로 연결하고, 응답 뒤에는
   operationId까지 일치하는지 검증한다. requestId는 권한이나 파일 대상
   결정에 절대 사용하지 않는다.

main은 작업 슬롯을 예약할 때 pending mutation 수를 먼저 올리고 terminal
outcome 뒤에만 내린다. start 응답이 빨리 돌아온다는 이유로 설치 중 앱
종료 보호가 비는 시간이 생기면 안 된다.
handshake가 거부되면 renderer는 provisional starting 상태를 정리하고
버튼을 다시 활성화하며, 거부 이유를 해당 카드에 표시한다.

maintenance는 일반 IPC 오류 문자열로 끝내지 않고 정확히 한 번의 구조화된
terminal outcome을 보낸다.

    MutationOutcome {
      requestId
      operationId
      sequence
      gameId
      status
      mutationStatus
      refreshStatus
      applyResult?
      error?
      refreshError?
      rollbackStatus?
      rollbackFailures[]
      postState?
    }

권장 status는 success, needs-user-action, failed-rolled-back,
failed-rollback-incomplete다. mutationStatus는 committed, rolled-back,
partial 중 하나이며, rollbackStatus는 complete, partial, not-run 중
하나다. refreshStatus는 complete 또는 failed로 별도 표현한다.
“rollback()을 호출함”과 “모든 복원을 확인함”을 구분한다.

| outcome status | 최종 표시 |
| --- | --- |
| success | postState 병합 뒤 100%와 완료 |
| needs-user-action | 완료색 대신 남은 절차가 있는 주의 카드 |
| failed-rolled-back | 실패 단계와 완전 복원 확인 |
| failed-rollback-incomplete | 복원하지 못한 항목을 숨기지 않는 오류 카드 |

어떤 status든 refreshStatus가 failed라면 파일 outcome과 별도로 “실제 상태
새로고침 실패”와 재시도 동작을 함께 표시한다.

현재 generic handle은 error 객체의 applyResult를 버리고 문자열만
renderer에 전달한다. maintenance 경로는 core 오류를 main에서 잡아
실패 단계·복원 실패 목록·사후 재감지 결과를 MutationOutcome으로
정규화해야 한다. postState 저장과 구성이 끝나기 전에 success/complete를
보내지 않으며, refresh만 실패하면 committed 설치를 실패나 rollback으로
표시하지 않는다. core rollback도 복원 오류를 warn 후 삼키지 말고
rollbackFailures를 반환해야 한다.

refreshStatus가 complete인 outcome에는 postState가 필수다.
mutationStatus가 committed인 success와 needs-user-action은 자동 단계에서
바뀐 실제 디스크 상태를 포함한다. rolled-back 또는 partial도 복원 뒤
재감지한 postState를 포함하며, 이를 만들지 못한 경우에만 refreshStatus를
failed로 둔다. postState가 없다는 사실을 “변경 없음”으로 해석하지 않는다.

일반 progress event는 terminal 권위가 아니다. renderer는 정확히 한 번
도착한 MutationOutcome을 병합한 뒤에만 complete 또는 최종 오류로
전환하고, success outcome의 postState와 complete 표시는 같은
libraryRevision을 사용한다.

### 5.4 퍼센트 규칙

- total이 알려진 현재 자산은 received / total을 사용한다.
- total을 모르면 불확정 애니메이션을 사용하고 퍼센트를 만들어 내지 않는다.
- 여러 자산의 바이트를 단순 합산하려면 각 자산의 예상 크기가 모두 있어야
  한다. 하나라도 없으면 “2/4 단계”와 현재 자산 진행률을 분리한다.
- 캐시 적중도 start와 complete 이벤트를 보내 “아무 일도 없었던 것”처럼
  보이지 않게 한다.
- 검증·압축 해제 시간을 다운로드 바이트로 위장하지 않는다.
- success MutationOutcome의 postState를 병합하기 전에 100%를 표시하지
  않는다.

첫 구현에서는 “단계 N/M”과 “현재 다운로드 바이트”의 두 정보가 가장
정직하다. 실제 소요 시간 예측이나 가중치 기반 전체 퍼센트는 측정 근거가
생긴 뒤 별도 작업으로 다룬다.

### 5.5 렌더러 상태

현재 전역 busy boolean은 첫 구현에서 다음 단일 작업 구조로 바꾼다.

    state.operation = {
      requestId,
      operationId?,
      sequence,
      gameId,
      kind,
      actionId,
      planId?,
      phase,
      stepIndex,
      stepCount,
      received,
      total,
      log,
      error,
      rollback
    }

작업 DOM을 installPlan에서 임시 append하지 말고 state로부터 렌더링한다.
현재 renderDetail이 replaceChildren을 사용하므로 임시 DOM은 상세
재렌더링 때 사라질 수 있다. 상태 기반 렌더링은 화면 전환과 자동
새로고침 중에도 진행 표시를 유지한다. 다른 게임을 선택했을 때도 원래
대상의 게임 목록 행에는 작업 아이콘을 남기고, 설정 화면이나 현재 필터
밖에서도 실행 중인 작업이 있음을 상단의 임시 상태로 확인할 수 있어야
한다. 구조화 progress 구독은 앱 수명 동안 정확히 하나만 등록하고 이벤트를
현재 operation으로 분배한다. 작업 종료 때 listener를 제거·재등록하지
말고 operation 상태만 정리하여 연속 실행에서 중복 이벤트가 생기지 않게
한다.

일회성 event만으로 작업 수명을 관리하지 않는다. main은 active operation
snapshot과 마지막 terminal outcome을 renderer가 ACK할 때까지 보존하고
다음 고정 API를 제공한다.

    maintenance:getCurrent()
    maintenance:getOutcome(operationId)
    maintenance:ackOutcome(operationId)

renderer boot는 listener를 먼저 하나 등록한 뒤 getCurrent를 호출하고,
event와 snapshot의 sequence가 더 최신인 쪽을 적용한다. renderer reload나
crash로 event를 놓쳐도 진행 상태와 결과를 복구할 수 있어야 한다. durable
journal에서 startup recovery 중인 작업도 같은 조회 API에 recovering
상태로 나타나며, renderer가 outcome을 실제 적용하기 전에는 ACK하지 않는다.

## 6. 설치 후 즉시 반영

### 6.1 목표

설치·업데이트·복구·제거가 끝나면 사용자가 스캔 버튼을 누르지 않아도
다음 값이 같은 상태 커밋에서 바뀌어야 한다.

- 상세 화면의 설치된 번역기, 변형과 버전
- 설치 계획의 CTA와 호환성 결과
- 영수증과 제거 가능 여부
- 게임 목록의 번역기 배지와 건강 상태 점
- “번역기 있음”, “문제 있음” 필터 결과
- 사이드바 문제 개수와 라이브러리 통계
- 번역기 설정 패널의 버전·스키마 판정

### 6.2 전체 스캔 대신 단일 게임 갱신

작업 성공 후 renderer가 library:load와 game:detail을 따로 호출하는 현재
흐름을 다음처럼 바꾼다.

1. main의 mutation queue 안에서 설치 또는 복구 트랜잭션을 완료한다.
2. 같은 gameId의 경로를 main 내부 테이블에서 다시 해석한다.
3. detectGame을 deep 모드로 실행한다.
4. 영수증, 설치 건강 상태, 감사, 호환 계획, 모드와 설정 컨텍스트를 다시
   계산한다.
5. 저장된 library.json의 해당 경로 한 항목만 새 GameProfile로 교체하고
   원자적으로 저장한다.
6. 최신 게임 목록 행, 감사, 통계와 상세 데이터를 하나의 postState로
   반환한다.
7. 렌더러가 postState를 메모리 상태에 한 번에 병합하고 library와 detail을
   한 번 렌더링한다.

권장 반환 개념은 다음과 같다.

    PostMutationState {
      operationId
      libraryRevision
      gameRevision
      game
      detail
      audit: GameAudit | null
      stats
      translatorConfig: RedactedTranslatorConfig | null
    }

libraryRevision은 library.json에 함께 저장되는 단조 증가 정수다. 모든
library:load, scan과 postState 응답이 이를 포함하며 renderer는 현재보다
낮은 revision의 늦은 응답을 버린다. persistedAt 같은 벽시계는 정렬
토큰으로 사용하지 않는다. gameRevision은 해당 게임 상세의 최신성을
비교하며, audit의 null은 “감사 데이터 생략”이 아니라 기존 audit 항목을
명시적으로 삭제하라는 뜻이다.
일반 game:detail 응답도 gameRevision을 포함하고, main은 targeted redetect
때 해당 revision을 올린다. 요청이 maintenance 전에 시작됐더라도 응답의
revision이 renderer가 이미 적용한 값보다 낮으면 선택 token과 무관하게
버린다. translatorConfig를 별도 IPC로 읽는 구현은 같은 gameRevision과
configRevision을 응답에 포함한다. renderer는 게임별 최신 revision을
보관한다.

main은 상세 snapshot을 만들기 직전 startRevision을 읽고 profile, receipt,
mods와 config 구성이 끝난 뒤 endRevision을 다시 확인한다. 둘이 다르면
전체 snapshot을 다시 만들거나 stale 응답으로 표시한다. 오래된 profile에
응답 시점의 새 revision만 붙이는 것은 금지한다.

기존 library.json처럼 revision 필드가 없는 인덱스는 revision 0으로
migration하고, 첫 성공 저장에서 증가시킨다.

손상되거나 손으로 편집된 library.json은 corrupt 영수증과 같은 신뢰
경계로 다룬다. 파싱 실패, 알 수 없는 스키마 필드, 경로가 등록 루트 밖인
항목과 중복 gameId는 조용히 버리지 말고 감사 로그에 남기고 유효 항목만으로
인덱스를 재구성한다. 전혀 해석되지 않으면 등록된 루트의 재스캔으로
초기화하되 이 경우에도 게임 폴더 자체는 건드리지 않는다. renderer는
“인덱스가 재구성됨”을 통계나 상태 배지로 확인할 수 있어야 한다.

deep detect와 audit 재계산은 큰 게임 폴더에서 수 초에서 수십 초까지 걸릴 수
있고, postState 구성이 끝나기 전에 success를 보내지 않는 계약(§5.3)과 결합하면
큰 폴더일수록 완료 표시가 늦어진다. 따라서 파일 해시에 증분 캐시를 적용한다.
size와 mtime이 이전 감지 때와 같으면 저장된 해시를 재사용하고, 하나라도 다르면
그 파일만 다시 해시한다. mtime만 바뀐 오탐을 허용 비용으로 받아들이는 것으로
첫 구현은 충분하다. redetect가 임계 시간을 넘기면 postState 구성을 생략하는 대신
progress 이벤트로 redetect 단계를 계속 보고하고 success는 늦게 보낸다.

translatorConfig는 기존 config:read와 같은 redaction을 거친 공개 데이터다.
자격 증명 원문을 postState에 넣지 않는다. 이를 postState에 포함하지 않는
구현을 택한다면 번역기 설정 패널은 같은 커밋이 아니라 별도 revision
검증 IPC로 갱신된다고 범위와 수용 기준을 낮춰야 한다.

전체 라이브러리 스캔은 폴더 추가, 외부에서 여러 게임을 바꾼 뒤의 수동
재스캔 등 실제로 필요한 경우에만 사용한다.

### 6.3 실패와 새로고침 오류

- 설치 단계가 실패하면 롤백 후에도 한 번 재감지하여 실제 파일 상태를
  보여 준다.
- 파일 트랜잭션은 성공했지만 사후 감지나 UI 데이터 구성만 실패한 경우,
  이미 완료된 설치를 실패로 표시하거나 되돌리지 않는다.
- 이 경우 “설치는 완료됐지만 화면 갱신에 실패함”을 보여 주고 해당 게임
  새로고침 버튼을 제공한다.
- postState.game의 목록 행, audit와 stats는 libraryRevision이 최신이면
  현재 선택과 관계없이 병합한다. 설치 대상 A를 처리하는 동안 사용자가
  B를 선택했어도 A의 라이브러리 갱신을 버리면 안 된다.
- postState.detail은 state.selected가 postState.game.id와 같고
  gameRevision이 현재 상세보다 새로울 때만 적용한다. operationId 불일치는
  현재 작업 카드의 terminal 상태를 바꾸지 못하게 하지만, 더 최신인
  revision 기반 라이브러리 데이터까지 버리는 이유가 되지는 않는다.
- selectGame 호출마다 단조 증가하는 selectionRequestToken을 발급하고,
  응답 시 해당 token과 요청 gameId가 아직 최신일 때만 state.detail에
  대입한다. A → B 또는 A → B → A의 역순 응답이 최신 상세를 덮으면 안
  된다.
- 선택 게임과 스크롤 위치는 유지한다. 첫 구현은 단순 scrollTop 복원으로
  충분하다. “현재 섹션 id + 섹션 안의 오프셋” 복원은 섹션 추가·제거로
  높이가 달라져도 정확하지만 구현 복잡도가 높으므로 후속 최적화로
  미룬다.

### 6.4 외부 변경 감지

이 요구의 첫 범위는 **IndieDeck이 수행한 변경의 즉시 반영**이다. 게임
폴더를 계속 감시하는 파일 시스템 watcher는 별도 후속 기능이다.

추후 watcher를 추가한다면 게임별 debounce, IndieDeck mutation 중 감시
중지, 대규모 압축 해제 이벤트 합치기, 앱이 포커스를 되찾을 때의 보조
재감지가 필요하다. watcher가 없다는 이유로 설치 완료 후의 targeted
refresh를 미뤄서는 안 된다.

## 7. 상단 바와 설정 페이지

### 7.1 상단 바에 남길 것

| 항목 | 위치 | 이유 |
| --- | --- | --- |
| 브랜드 | 왼쪽 | 앱 정체성 |
| 검색 | 중앙의 가변 영역 | 라이브러리에서 가장 빈번한 전역 동작 |
| 새로고침 | 오른쪽 아이콘 | 외부 변경을 확인하는 명시적 동작 |
| 설정 | 오른쪽 아이콘 | 저빈도 전역 옵션 진입점 |

새로고침 버튼은 짧은 툴팁과 접근 가능한 이름을 갖는다. “저장된 인덱스
다시 읽기”와 “디스크 전체 재스캔”이 혼동되지 않도록 기본 클릭의 의미를
명확히 정한다. 권장 기본은 등록 루트 재스캔이며, 작업 중에는 비활성화한다.

### 7.2 설정으로 옮길 것

| 현재 상단 항목 | 새 위치 | 적용 방식 |
| --- | --- | --- |
| UI 언어 | 설정 > 일반 | 선택 즉시 적용하고 카탈로그를 다시 읽음 |
| 기본 원문 언어 | 설정 > 번역 기본값 | 저장 시 이후 계획과 선택 게임 상세를 재계산 |
| 기본 번역 언어 | 설정 > 번역 기본값 | 저장 시 이후 계획과 선택 게임 상세를 재계산 |
| 기본 엔드포인트 | 설정 > 번역 기본값 | 저장 시 호환성 감사와 계획을 재계산 |
| 폴더 추가 | 설정 > 라이브러리, 빈 상태 CTA | 반드시 main의 OS 폴더 선택기를 통해 추가 |
| 루트 제거 | 설정 > 라이브러리 | 현재 roots API와 신뢰 경계 유지 |
| 스캔 깊이 | 설정 > 라이브러리 | 저장 후 다음 전체 스캔부터 적용 |

현재 사이드바의 루트 목록을 남긴다면 읽기 전용 요약으로 축소하고, 추가와
제거 같은 관리 동작은 설정 페이지 한 곳에서만 제공한다.

상단 select 요소가 사라지면 현재 store.resolveOptions가 DOM id를 직접
읽는 방식은 깨진다. resolveOptions는 state.config.defaults를 읽도록
바꾸고, 설정 페이지의 입력 요소 존재 여부에 의존하지 않게 해야 한다.
현재 boot도 endpoint, targetLanguage, sourceLanguage, uiLocale과 addRoot
요소를 즉시 찾아 옵션을 채우고 listener를 건다. 이 초기화는 각 설정
컴포넌트와 빈 라이브러리 CTA의 mount 함수로 옮겨야 하며, 앱 bootstrap은
설정 DOM이 아직 없더라도 완료되어야 한다.

scanDepth는 현재 config:set이 저장하는 필드가 아니므로 UI만 먼저 추가하지
않는다. main의 bounded config API가 정수 최소·최대 범위를 검증하고
LauncherConfig에 저장하도록 확장해야 한다. roots는 계속 별도 pick/remove
API로만 바꾸며 일반 config round-trip에 섞지 않는다.

### 7.3 설정 페이지 상태와 저장

- state.view를 library 또는 settings로 명시한다.
- 별도 settings.html로 이동하지 말고 현재 문서 안에서 앱 뷰를 전환한다.
  기존 창의 navigation 차단과 CSP·IPC 경계를 그대로 유지하기 위해서다.
- 설정 페이지를 닫아도 선택 게임과 상세 스크롤 앵커를 보존한다.
- maintenance 중에도 설정 페이지는 열어 볼 수 있지만, 새 config·root·scan
  mutation을 뒤에 몰래 대기시키지 않도록 저장·추가·제거·스캔 동작은
  terminal outcome까지 비활성화한다.
- 번역 기본값은 임시 편집 상태와 저장된 config를 구분한다.
- UI 언어는 즉시 적용해도 되지만, 번역 기본값은 “저장” 시 한 번만 상세
  계획을 다시 계산하여 불필요한 IPC 호출을 줄인다.
- 루트 추가는 렌더러가 경로 문자열을 제출하지 않고 기존 root:pick을
  계속 사용한다.
- 저장 성공, 저장 중, 오류를 설정 페이지 안에서도 보여 준다.
- 저장된 scanDepth는 앱 재시작 뒤 전체 스캔에서 실제로 사용되고, 음수,
  소수와 과도한 값은 main이 거부하거나 문서화된 범위로 제한한다.
- 작은 창에서는 검색 폭을 먼저 줄이고, 버튼은 아이콘과 툴팁으로 유지한다.

## 8. 기존 번역기 버전 불일치와 중복 설치

### 8.1 설치 건강 상태 모델

현재의 “설치됨/설치 안 됨”만으로는 업데이트와 복구 CTA를 안전하게
결정할 수 없다. 다음 상태를 core가 증거와 함께 계산해야 한다.

| 상태 | 의미 | 기본 CTA |
| --- | --- | --- |
| absent | 인식된 번역기 흔적 없음 | 설치 |
| healthy | 실제 payload, 변형, 버전과 관리 기록이 목표 상태와 일치 | 설치됨, 보조 메뉴에 재설치 |
| update-available | 현재 게임에서 호환되는 더 높은 권장 버전이 있음 | 업데이트 |
| version-conflict | 실제 버전이 게임·백엔드·엔드포인트 조건과 맞지 않음 | 복구 설치 |
| duplicate-variants | 같은 번역기의 여러 로더 변형 payload가 공존 | 정리 후 재설치 |
| multiple-versions | 서로 다른 DLL 경로에서 여러 버전이 감지됨 | 정리 후 재설치 |
| orphaned | payload를 실행할 호환 로더가 없음 | 로더 포함 복구 |
| unmanaged | 인식된 파일은 있으나 IndieDeck 영수증이 없음 | 유지 또는 검토 후 백업 교체 |
| managed-drift | 영수증의 의도 버전·해시와 실제 파일이 다름 | 변경 내역 검토 후 복구 |
| corrupt-receipt | 영수증이 손상됐거나 안전하게 해석되지 않음 | 자동 변경 차단, 복구 검토 |
| newer-than-registry | 실제 버전이 레지스트리 최신보다 높음 | 유지가 기본, 자동 다운그레이드 금지 |
| version-unknown | 흔적은 있으나 권위 있는 버전을 알 수 없음 | 검토 필요, 자동 교체 금지 |

이 상태들은 상호배타적인 단일 enum이 아니다. 한 설치에
duplicate-variants, orphaned, managed-drift와 update-available이 함께
있을 수 있으므로 core는 healthIssues[]를 모두 보존하고 별도의
primaryStatus와 typed CTA를 반환한다. 권장 우선순위는 corrupt-receipt,
duplicate·drift, orphaned·version-conflict, update, healthy·absent다.
renderer가 자체 우선순위를 다시 추측하지 않는다.

“최신”은 레지스트리의 가장 큰 버전 문자열이 아니라 해당 게임의 엔진,
백엔드, 아키텍처, 설치 로더와 선택 엔드포인트에 대해 resolver가 만든
가장 높은 viable 권장 계획을 뜻해야 한다.

### 8.2 증거를 합치지 말고 보존할 것

각 설치 후보에 다음 증거를 개별로 유지한다.

    TranslatorInstallEvidence {
      translatorId
      primaryStatus
      healthIssues[]
      ownership
      uninstallable
      variantHits[]
      payloadPaths[]
      assemblyVersions[{ path, version }]
      receipts[{
        storageId,
        id,
        version,
        variant?,
        status,
        fingerprint?
      }]
      receiptIssues[{ name, code }]
      configTagVersion?
      ownedPaths[]
      modifiedOwnedPaths[]
      unknownPaths[]
    }

receipt status는 active, superseded, observed, invalid를 구분한다. chain 안의
서로 다른 version·variant를 단일 receiptVersion으로 합치지 않는다.

증거의 역할은 다르다.

- loader와 variant 규칙상 로드 후보인 경로의 실제 on-disk 파일 버전은
  해당 payload 버전의 권위 있는 증거다. 실제 프로세스가 그 파일을
  로드했다는 사실은 runtime trace가 없으면 추론으로 표시한다.
- 영수증 버전은 IndieDeck이 설치하려 했던 버전과 **소유권**의 증거다.
- 설정의 Migrations 태그 등은 보조 힌트다.
- installed marker는 존재 증거이지 단독 버전 증거가 아니다.
- 읽을 수 없는 영수증도 조용히 버리지 말고 손상 증거로 보존하되, 사용자
  화면에는 게임 루트 기준의 안전한 이름과 원인만 노출한다. maintenance용
  reader는 validReceipts와 receiptIssues를 함께 반환하고 parse-error,
  schema-error, unsafe-entry, missing-active, multiple-active, chain-cycle,
  missing-baseline, missing-backup과 unsafe-storage-id를 구분한다. schema,
  kind, component, operation과 모든 상대 경로·storage id를 엄격히
  검증한다.

receipt 5.6.1과 실제 DLL 5.5.2처럼 서로 다르면 한쪽을 조용히 우선하지
말고 managed-drift로 보고한다. 알 수 없는 상태를 불일치라고 단정하지도
않는다. 현재 config version detection처럼 receipt를 먼저 찾았다는 이유로
실제 DLL 증거를 건너뛰면 drift를 숨길 수 있으므로, 건강 상태 판정은 모든
출처를 수집한 뒤 서로 비교해야 한다.

### 8.3 실행 가능한 유지보수 계획

audit의 fix 문구만 보여 주는 대신 main이 불변의 MaintenancePlan을 만들고
opaque actionId를 발급한다. 렌더러는 경로, 삭제 목록 또는 임의 계획을
main에 보내지 않는다.

    MaintenancePlan {
      actionId
      gameId
      mode
      targetTranslator
      targetVariant
      targetVersion
      gameEvidenceHash
      registryRevision
      configRevision
      resolveOptionsHash
      remove[]
      preserve[]
      write[]
      warnings[]
      requiresConfirmation
    }

권장 mode는 install, update, repair, replace, consolidate다.

계획 카드에는 실행 전 다음을 보여 준다.

- 유지할 번역기와 변형·버전
- 제거할 것으로 인식된 payload
- 유지할 설정, 번역 캐시, 사용자 사전과 수동 수정 파일
- 추가하거나 교체할 로더
- 관리되지 않은 파일 또는 버전 불명으로 인해 자동 판단하지 않은 항목
- 실패 시 롤백 범위

### 8.4 자동 선택 규칙

- 현재 게임의 backend, engine, arch와 설치 로더를 기준으로 유일한 viable
  변형이 있을 때만 중복 중 유지 대상을 자동 추천한다.
- duplicate-variants는 서로 다른 물리 payload root 또는 서로 다른 loader
  계열의 흔적이 동시에 있을 때만 확정한다. BepInEx Mono/IL2CPP처럼 같은
  marker와 config 경로를 공유하는 논리 variant는 game backend로
  disambiguate하고, config 파일 하나만으로 중복을 확정하지 않는다.
- 두 개 이상의 viable 후보가 남으면 사용자에게 변형을 선택하게 한다.
- 서로 다른 translatorId가 함께 있다는 사실만으로 중복으로 판정하지
  않는다. registry가 동일 역할의 충돌을 명시했거나 같은 translator의
  중복 payload임이 증명된 경우만 자동 정리 후보가 된다.
- 레지스트리보다 새 버전은 자동 다운그레이드하지 않는다.
- 버전 불명 또는 관리되지 않은 설치는 확인 없이 제거하지 않는다.
- unmanaged 설치의 첫 등록은 ownership: observed, uninstallable: false인
  비소유 inventory다. 자동 제거 가능한 관리 상태로 바꾸려면 replace
  transaction이 기존 수동 설치를 baseline으로 snapshot해야 한다. 기본
  최종 제거는 그 수동 baseline을 복원하며, 완전 제거는 별도 명시 선택이다.
- detect-only 도구는 IndieDeck이 설치 가능한 것처럼 표시하지 않는다.
  공식 설치 경로 안내와 외부 설치 후 다시 감지를 제공한다.

### 8.5 원자적 조정 트랜잭션

업데이트·복구·중복 정리는 다음 불변 조건을 만족해야 한다.

1. 사전 검사를 시작한 뒤 대상 파일이 바뀌면 실행을 중단하고 계획을 다시
   만든다. 파일뿐 아니라 game engine·backend·arch 증거, registry revision,
   launcher config revision과 source/target language·endpoint 옵션 hash도
   action 생성 시 snapshot과 같아야 한다.
2. 대상 translator의 기존 payload 정리, 새 payload 적용과 설정 보존을
   하나의 롤백 가능한 작업으로 수행한다. loader 제거는 별도 의존성 규칙을
   통과한 경우만 포함한다.
3. 기존 영수증은 새 payload와 새 영수증이 모두 성공하기 전에 삭제하거나
   덮어쓰지 않는다.
4. 잡힌 프로세스 내 실패에서는 작업 시작 직전의 게임 폴더와 그 안의
   .indiedeck 상태를 byte-identical하게 복원한다. 전역 download cache,
   게임 밖 toolsDir와 앱 로그는 이 보장 범위가 아니다.
5. 성공 후 같은 번역기에는 하나의 활성 관리 상태가 남는다.
6. 여러 번 업데이트한 뒤 최종 제거해도 최초 IndieDeck 설치 전 상태로
   돌아간다.
7. create 항목에만 적용되는 현재 hash guard를 replace, remove와 baseline
   restore 후보 전체로 확장한다. 설치 후 달라진 파일은 삭제하거나 backup으로
   덮기 전에 modifiedOwnedPaths로 분류하고 보존·병합·명시 확인 중 하나를
   거친다.

preflight는 대상 payload 파일의 쓰기 잠금도 조기 검사한다. Windows에서 실행
중인 게임이나 백신·백업 소프트웨어가 연 DLL은 extract 마지막 단계에야 쓰기
실패로 드러난다. 다운로드와 백업을 모두 끝낸 뒤의 실패는 롤백 비용과 사용자
시간만 키우므로, preflight에서 대상 파일을 배타적으로 열어 잠금을 조기
발견하고 발견하면 어떤 변경도 적용하기 전에 “파일 사용 중” 결과로 종료한다.
이 검사는 예방이 아니라 조기 발견이므로 이후 단계의 sharing violation은
계속 fail-closed rollback으로 처리한다(§9.2).

현재 FileTransaction에는 안전한 “삭제 후 필요 시 복원” 동작이 없다.
중복 정리를 자동화하려면 백업을 동반한 delete/remove journal 연산이
필요하다. 영수증도 다음 중 하나로 확장해야 한다.

- receipt v3에 replacesReceiptIds와 최초 baseline 소유권·백업을 계승하거나,
- 버전별 영수증을 보존하고 하나의 active pointer로 적용 순서를 명시한다.

어느 방식을 택하든 같은 componentId 영수증을 단순 overwrite하는 현재
방식은 업데이트·복구 경로에서 사용하지 않는다.

프로세스 crash나 전원 손실 뒤에도 “원자적”이라고 부르려면 메모리 journal로
충분하지 않다. .indiedeck/transactions/<operationId>/ 아래에 durable
journal과 상태(prepared, applied, activated)를 먼저 기록하고, 앱 시작 시
미완료 transaction을 라이브러리 사용 전에 복구하거나 안전한 재개 화면으로
보내야 한다. durable recovery를 구현하지 않은 단계는 잡힌 프로세스 내
오류에 대해서만 **PARTIAL** 원자성으로 표기한다.

durable journal은 같은 게임 폴더를 둘째 IndieDeck 프로세스가 동시에
만지지 않는다는 전제 위에서만 안전하다. 설치판과 포터블 빌드가 한 PC에
공존할 수 있으므로 journal보다 먼저 앱 수준 단일 인스턴스 잠금을
확정한다. Electron requestSingleInstanceLock 또는 데이터 디렉터리의
잠금 파일 중 선택하되, 잠금을 얻지 못한 인스턴스는 읽기 전용으로
제한하거나 시작을 거부한다. startup recovery는 잠금을 가진 프로세스만
수행한다.

영수증과 active pointer의 commit 순서는 다음 계약을 지킨다.

1. 기존 영수증과 baseline backup은 그대로 둔다.
2. 새 payload와 새 영수증을 임시 storage id로 stage한다.
3. 새 영수증과 journal을 flush한 뒤 active pointer를 원자적 rename으로
   전환한다.
4. activation 성공을 기록한 뒤에만 이전 active 영수증을 superseded로
   표시하고, 복원에 필요 없는 자료를 정리한다.
5. receipt write, flush, rename 또는 activation 확인이 실패하면 이전
   pointer와 payload로 복원한다.

versioned receipt를 사용하면 실제 storage id와 파일 이름을 record에
보존한다. 현재처럼 kind와 componentId로 제거 대상 영수증 이름을 다시
계산하지 않는다. 기존 schema v1·v2는 읽기·제거가 계속 가능하도록 migration
규칙과 fixture를 유지한다.

loader는 다른 mod나 translator가 사용할 수 있으므로 target translator
정리의 부산물로 자동 제거하지 않는다. loader 제거는 IndieDeck 소유
영수증이 있고, dependency graph의 다른 참조가 0이며, 사용자가 별도로
확인한 경우에만 maintenance plan에 들어간다.

### 8.6 보존 규칙

설정 파일, 번역 캐시, 사용자 사전, 사용자가 만든 번역문과 로그를 실행
payload와 같은 방식으로 재귀 삭제하면 안 된다.

- registry에 각 번역기·변형의 정확한 payload 경로와 preserve 경로를
  선언한다.
- 관리 영수증이 있는 파일은 operation 종류와 관계없이 기록된 활성
  payload 해시와 현재 해시를 비교한다. 해시가 기록되지 않은 항목은
  “변경 없음”으로 추정하지 않고 unknown으로 다룬다.
- 관리되지 않은 설치는 registry가 정확히 식별한 payload 파일만 후보로
  삼고, 상위 디렉터리를 통째로 삭제하지 않는다.
- modifiedOwnedPaths와 unknownPaths는 미리보기에서 별도 경고하고 명시적
  확인 없이는 그대로 둔다.
- 설정 패치는 기존 config manager처럼 알려지지 않은 키, 주석과 줄바꿈을
  보존한다.

번역기마다 payload와 사용자 데이터 경계가 다르므로 자동 정리 지원표는
초기에 **RESEARCH**로 관리한다. 검증된 경로·보존 규칙·롤백 fixture가 있는
번역기와 변형만 **CURRENT** 자동 정리 대상으로 승격한다. 게임 폴더 밖의
별도 도구 설치는 게임 내부 payload 조정과 소유권 모델이 다르므로 같은
정리 동작에 섞지 않는다.

## 9. 스크롤 중 게임 실행·폴더 열기 유지

### 9.1 동작

상세 패널 맨 위에 detail-sticky 영역을 두고 다음을 포함한다.

- 게임 제목
- 실행 파일이 탐지된 경우 게임 실행
- 폴더 열기
- 현재 설치·복구가 진행 중이면 간결한 작업 상태

실행 파일이 없으면 Play를 숨기거나 비활성화하고 인접한 설명으로 이유를
알린다. 게임을 선택하지 않은 빈 상세이나 설정 화면에는 이 sticky 영역을
표시하지 않는다.

경로 전체, 제거, 재설치, 위험한 정리 동작은 고정 영역에 넣지 않는다.
고정 영역은 자주 쓰는 안전한 동작만 유지해 시각적 무게를 줄인다.

스크롤 전에는 제목과 액션을 넉넉하게 보여 주고, 아래로 스크롤하면 제목을
한 줄로 줄인 compact 상태로 바꿀 수 있다. 그러나 첫 구현은 단순한
position: sticky만으로 충분하다.

### 9.2 구현 주의점

- 현재 detail 자체가 overflow-y: auto인 스크롤 컨테이너이므로 그 안의
  첫 자식 wrapper에 position: sticky와 top: 0을 적용한다.
- 배경색, 하단 경계선과 충분한 z-index를 지정해 아래 콘텐츠가 비치지
  않게 한다.
- detail의 기존 padding과 sticky wrapper의 폭이 어긋나지 않도록 wrapper
  전용 padding 또는 음수 margin을 한 곳에서 관리한다.
- 상위 요소의 transform이나 중첩 overflow로 sticky가 깨지지 않는지
  확인한다.
- renderHeader가 h1, path, actions를 각각 바로 append하지 말고 하나의
  wrapper를 만든다.
- 설치 중에는 Play를 비활성화한다. disabled button은 focus를 받지 않으므로
  title만 쓰지 말고 focus 가능한 wrapper 또는 인접 상태 문구를
  aria-describedby로 연결해 이유를 전달한다.
- renderer 비활성화만 신뢰하지 않는다. main의 game:launch도 같은 gameId에
  active maintenance가 있으면 요청을 거부하고 terminal outcome 뒤에만
  다시 허용한다.
- maintenance preflight는 main이 IndieDeck에서 시작해 추적 중인 해당
  게임이 실행 중이면 거부한다. 외부에서 실행한 프로세스를 확실히 판별할
  수 없는 첫 구현은 “게임이 종료됨” 확인을 요구하고, 파일 sharing
  violation이나 잠금 오류가 나면 cleanup을 계속하지 않고 fail-closed
  rollback한다. 더 강한 실행 상태 추적은 GameSession과 별도 검증한다.
- 키보드 Tab 순서가 제목 뒤 Play, Open folder 순으로 유지되어야 한다.
- 좁은 폭에서는 버튼 라벨을 줄이더라도 접근 가능한 이름은 유지한다.

이 항목은 현재 game:launch를 더 잘 노출하는 UI 계약이다. 실행 중 상태,
플레이 시간, beforeLaunch·afterLaunch hook과 세션 백업을 제공한다는 뜻은
아니며 roadmap의 GameSession은 계속 **PLANNED**다.

## 10. IPC와 신뢰 경계

새 기능도 현재의 “렌더러를 신뢰하지 않는다” 원칙을 유지한다.

- renderer → main: gameId, main이 발급한 planId 또는 actionId, 제한된 옵션
- main → renderer: 구조화 진행 이벤트, 미리보기, postState
- maintenance/install mutation API에서 금지: renderer가 임의 파일 경로,
  executable, remove 목록, 자산 URL 또는 MaintenancePlan 전체를 제출하는
  형태. 기존의 HTTPS 전용 외부 문서 열기 API는 별도 경계로 유지한다.
- 실행 직전 main이 gameId를 다시 path로 해석하고, 설치 흔적과 파일
  fingerprint, game evidence, registry revision, config revision과
  resolveOptionsHash를 재검증한다.
- 오래된 planId 또는 actionId는 거부하고 상세를 새로 불러오도록 한다.
- 진행 이벤트의 messageKey와 params를 함께 보내 언어 변경 후 다시
  번역할 수 있게 한다.

현재 main의 handleMutation 큐는 파일 변경을 직렬화하고 앱 종료를
보류한다. 새 maintenance 동작도 반드시 같은 큐를 사용한다.

## 11. 권장 파일별 변경 지도

이 표는 구현 위치를 찾기 위한 가이드이며, 이 문서 변경 자체에는 아래
코드 수정이 포함되지 않는다.

| 파일 또는 영역 | 계획된 역할 |
| --- | --- |
| packages/core/src/detect/index.ts | 변형별 payload와 모든 DLL 버전 증거 수집 |
| packages/core/src/types.ts | 설치 증거, 건강 상태, maintenance 계획과 진행 이벤트 타입 |
| packages/core/src/audit/index.ts | duplicate, drift, unmanaged, newer/unknown 상태를 증거와 함께 감사 |
| packages/core/src/resolve/index.ts 또는 새 maintenance 모듈 | 현재 게임에 맞는 목표 상태와 실행 계획 생성 |
| packages/core/src/install/transaction.ts | 백업을 동반한 안전한 remove, rollback 결과와 durable journal |
| packages/core/src/install/apply.ts | 원자적 reconcile, stage/activate와 영수증 계승·교체 |
| packages/core/src/library/index.ts | gameId 경로 한 항목 재감지, revision과 원자적 index 저장 |
| packages/desktop/src/main.ts | 단일 인스턴스 잠금, actionId 캐시, start handshake, 구조화 진행·outcome, revisioned postState |
| packages/desktop/preload.cjs | 최소 고정 progress/outcome 구독, start·조회·ACK 호출 |
| packages/desktop/renderer/store.js | DOM 독립 defaults, 단일 maintenance operation, revision과 settings view 상태 |
| packages/desktop/renderer/app.js | 상태 기반 진행 UI, postState 원자 병합, 설정 라우팅 |
| packages/desktop/renderer/panels/detail.js | 상황별 CTA, sticky action wrapper, 복구 미리보기 |
| packages/desktop/renderer/panels/settings.js | 별도 설정 페이지 |
| packages/desktop/renderer/index.html | 간소화한 상단 바와 설정 진입점 |
| packages/desktop/renderer/style.css | 로딩 바, sticky 액션, 설정 레이아웃과 반응형 규칙 |
| locales/en.json, locales/ko.json | 단계, 상태, CTA, 경고와 접근성 문자열 |

## 12. 구현 순서

UI부터 Update 버튼을 붙이지 말고 안전한 상태·조정 모델부터 만든다.

1. **설치 증거와 건강 상태** — 완료(2026-08-23): `packages/core/src/health`,
   `packages/core/test/fixtures.ts`, `packages/core/test/health.test.ts`
   - 모든 변형·DLL 버전·영수증·수정 파일을 보존하는 탐지 모델
   - 상태 분류와 resolver 기반 목표 버전
   - 단위 테스트와 audit 문구(공유 fixture 모듈을 먼저 구축한다)
2. **원자적 maintenance**
   - 미리보기 가능한 계획
   - 안전한 remove와 durable journal·startup recovery
   - 영수증 v3 또는 versioned receipt/active pointer의 stage/activate
   - 고장 주입 롤백 테스트
3. **구조화 진행 이벤트** — **PARTIAL**(2026-10-05): 설치·제거 진행과
   renderer reload 복구는 구현, 원자적 maintenance/durable recovery는 남음
   - core 단계 콜백
   - requestId/operationId start handshake와 terminal outcome
   - preload 고정 채널
   - 로딩 바와 접근 가능한 단계 표시
4. **단일 게임 post-mutation refresh** — **PARTIAL**(2026-10-05): 대상 저장과
   revision·postState 병합 구현, 손상 인덱스 재구성·증분 cache는 남음
   - deep detect
   - library.json 한 항목 교체·저장
   - 감사·통계·상세 postState
   - renderer 단일 상태 커밋
5. **상황별 CTA와 복구 화면**
   - 설치, 업데이트, 복구 설치, 정리 후 재설치
   - preserve/remove/write 미리보기
6. **상단 바·설정·sticky 액션** — 완료(2026-08-23, scanDepth는 §7.2의
   main 확장과 함께 별도로 남김)
   - 전역 기본값을 설정 페이지로 이동
   - DOM 독립 resolveOptions
   - Play/Open folder 고정
7. **패키지 smoke와 수동 UX 검증**
   - 한국어·영어
   - 작은 창
   - 실제 설치 성공·실패·복구

각 단계는 독립적인 완료 조건을 가진다.

| 단계 | 완료 조건(DoD) |
| --- | --- |
| 1 | TranslatorInstallEvidence와 healthIssues[] 타입이 정의되고 §13.3 fixture 전부가 단위 테스트로 통과한다 |
| 2 | 영수증 commit 순서 주입을 포함한 §13.4 고장 주입 테스트가 통과하고 startup recovery가 재현된다 |
| 3 | §13.1 진행 표시 항목 전부가 통과하고 로딩 바가 한국어·영어에서 보인다 |
| 4 | §13.2 즉시 반영 항목 전부가 통과하고 libraryRevision이 디스크에 저장되어 재시작 후에도 유지된다 |
| 5 | install·update·repair·replace·consolidate 계획 미리보기 카드가 렌더링되고 증거 해시가 바뀐 actionId 실행이 거부된다 |
| 6 | 상단 바 항목 이동, 설정 저장·재적재, sticky 액션 스크롤 가시성이 확인된다 |
| 7 | packaged smoke가 두 로케일로 통과하고 수동 UX 체크리스트 결과가 기록된다 |

완료 조건을 만족한 단계만 이 문서의 해당 **PLANNED** 표기를 **CURRENT**로
바꾸고 근거(테스트 이름 또는 수동 체크리스트 결과)를 함께 적는다. 어떤 조건을
하나라도 만족하지 못하면 그 단계는 미완성이며, 그 위에 구현된 이후 단계의
기능도 함께 **PARTIAL**로 표기한다.

단계 1과 2가 끝나기 전에 기존 Install 버튼을 Update, Repair 또는
“중복 정리”로 바꾸지 않는다.

## 13. 검증 시나리오

아래 fixture들은 테스트마다 임시로 만드는 파일이 아니라 하나의 공유 모듈(roadmap
P1.5의 미완 항목)로 관리한다. 번역기·변형별 fixture는 최소 가짜 게임 폴더,
영수증 v1/v2/v3 샘플과 DLL 버전 증거로 구성하고, 고장 주입은 fs 경계를 가로채어
같은 fixture를 재사용한다. 이 fixture 모듈 구축이 §12 구현 순서의 단계 1에
선행한다.

### 13.1 진행 표시

- 여러 chunk 다운로드에서 received가 단조 증가하고 마지막 값이 total과
  일치한다.
- Content-Length가 없으면 불확정 바를 사용한다.
- 캐시 적중도 단계 시작과 완료가 보인다.
- loader, translator, font처럼 여러 자산을 구분한다.
- 다른 operationId의 이벤트가 현재 게임 카드에 표시되지 않는다.
- 앱 수명 progress listener가 정확히 하나만 등록되고, 작업 종료 후
  operation 상태와 버튼이 정상으로 돌아온다.
- 두 작업을 연속 실행해도 한 이벤트가 중복 처리되지 않고 과거 terminal
  event가 새 작업을 바꾸지 않는다.
- 클릭 직후 첫 프레임에 로딩 바가 나타난다.
- pendingUserActions가 남으면 “완료”가 아니라 “추가 작업 필요”로 끝난다.
- settings로 이동했다 돌아와도 전역 작업 표시와 listener가 유지된다.
- renderer를 작업 중·outcome 직후 각각 reload해도 getCurrent/getOutcome으로
  상태를 복구하고, 적용 후 ACK한 결과만 main이 정리한다.
- 화면 읽기 도구가 aria-live로 단계 변경을 알 수 있다.

### 13.2 즉시 반영

- 설치 직후 수동 스캔 없이 상세 버전과 게임 카드 배지가 같이 바뀐다.
- “번역기 없음” 필터에서 게임이 즉시 빠지고 “번역기 있음”에 나타난다.
- 해결된 감사가 사라지고 문제 개수와 통계가 같은 렌더에서 갱신된다.
- 앱을 재시작해도 library.json에 최신 상태가 남아 있다.
- 제거와 복구에도 같은 규칙이 적용된다.
- needs-user-action으로 끝난 작업도 자동으로 쓰인 파일을 재감지하여 게임
  배지, 감사와 설정 상태를 즉시 갱신한다.
- 사후 UI 갱신 실패는 설치 성공과 구분되어 표시되고 재시도할 수 있다.
- 낮은 libraryRevision의 늦은 load 응답이 최신 postState를 덮지 않는다.
- 게임 A 설치 중 B 선택, settings 이동, A → B → A 역순 detail 응답에서도
  A의 라이브러리 행은 최신화되고 현재 선택 상세에는 다른 게임 데이터가
  들어오지 않는다.
- 같은 게임 A의 느린 detail snapshot 도중 A maintenance가 끝나도 늦은
  snapshot이 새 postState를 덮지 않는다.

### 13.3 설치 건강 상태

다음 fixture를 각각 검증한다.

- 미설치
- 영수증과 DLL 버전이 같은 정상 설치
- 관리 설치의 호환 가능한 구버전
- 수동 설치의 구버전
- 영수증과 DLL 버전 불일치
- BepInEx와 MelonMod 변형 동시 존재
- 서로 다른 경로의 두 DLL 버전
- payload만 있고 로더가 없는 상태
- 버전 불명
- 레지스트리보다 새로운 버전
- 사용자가 수정한 관리 파일
- 손상되거나 누락된 영수증

### 13.4 업데이트·복구 안전성

- 성공 후 동일 translator에는 하나의 활성 maintenance chain만 남는다.
  계획이 loader를 요구하면 목표 translator가 사용할 호환 loader 상태가
  하나로 명확하며, 영수증 수와 구성은 선택한 계승 모델의 불변식을
  만족한다.
- 설정, 번역 캐시, 사용자 사전과 수동 번역문이 보존된다.
- download, extract, cleanup, configure 각 단계에 고장을 주입했을 때 파일
  트리와 영수증이 작업 전 상태로 완전히 복원된다.
- receipt write, flush, active pointer rename과 activation 확인 실패를 각각
  주입해 이전 active 상태가 유지되는지 검증한다.
- applied 또는 staged 상태에서 프로세스를 종료한 fixture를 다음 앱 시작이
  durable journal로 복구하거나 명시적 안전 복구 상태로 전환한다.
- 두 번 이상 업데이트한 뒤 제거해도 최초 IndieDeck 설치 전 상태로
  돌아간다.
- 관리되지 않은 파일은 확인 없이 삭제되지 않는다.
- 다른 mod·translator가 참조하는 loader는 대상 translator 정리 중
  제거되지 않는다.
- create뿐 아니라 modify·snapshot 항목도 설치 후 사용자 수정이 있으면
  자동으로 baseline backup을 덮어쓰지 않는다.
- 계획 생성 뒤 파일이 바뀌면 오래된 actionId 실행을 거부한다.
- 파일이 같아도 registry, config 또는 source/target/endpoint 옵션 revision이
  바뀌면 오래된 actionId를 거부한다.
- 같은 정상 상태에 같은 repair를 다시 실행하면 두 번째 작업은 변경 없는
  no-op으로 끝난다.

### 13.5 상단 바·설정·고정 액션

- 원문 언어, 번역 언어, 엔드포인트와 UI 언어가 상단 바에 남지 않는다.
- 브랜드, 검색, 새로고침과 설정은 창 폭이 줄어도 사용할 수 있다.
- 설정 저장 후 선택 게임의 계획과 감사가 최신 기본값으로 다시 계산된다.
- 루트 추가는 OS 폴더 선택기를 통해서만 이루어진다.
- 실행 파일이 있는 게임은 상세의 맨 아래까지 스크롤해도 Play와 Open
  folder가 보인다. 실행 파일이 없으면 Play 불가 이유가 보이고, 빈 상세에는
  sticky 액션이 없다.
- 설치 중 Play가 비활성화되고 완료·실패 후 올바르게 복구된다.
- renderer를 우회해 game:launch IPC를 직접 호출해도 같은 게임 maintenance
  중에는 main이 거부하고 terminal outcome 뒤 다시 허용한다.
- 키보드와 화면 읽기 도구만으로 설정, CTA와 고정 액션을 사용할 수 있다.
- 기존 topbar select와 addRoot id를 제거한 HTML로도 packaged smoke가
  library ready 상태까지 도달한다.
- scanDepth의 유효 값은 재시작 뒤 스캔에 적용되고, 잘못된 값은 main에서
  거부된다.

## 14. 완료 정의

이 작업은 다음 조건을 모두 만족할 때 구현 완료로 볼 수 있다.

- 각 사용자 요구가 자동화된 검증 또는 재현 가능한 수동
  체크리스트에 연결되어 있다.
- 설치·업데이트·복구 중 진행 단계가 구조화 이벤트로 표시된다.
- 작업 직후 상세와 라이브러리 상태가 같은 postState에서 최신화되고
  디스크 인덱스에도 저장된다.
- 중복·불일치 해결이 원자적이며 관리되지 않은 파일을 자동 삭제하지 않는다.
- 여러 번 업데이트한 뒤에도 최초 상태 복원이 가능하다.
- 상단 바가 간소화되고 설정 페이지가 전역 옵션을 소유한다.
- 실행 가능한 게임은 모든 상세 스크롤 위치에서 게임 실행과 폴더 열기가
  보인다.
- 한국어·영어 카탈로그 검사, core 테스트, 빌드, registry 검사와 packaged
  launcher smoke가 통과한다.
- README, architecture, roadmap의 CURRENT/PLANNED 설명을 실제 구현 상태에
  맞춰 함께 갱신한다.

## 15. 이번 문서 작업의 범위

이번 변경은 위 계약을 기록하는 것까지만 한다. 로딩 바를 표시하거나,
기존 설치를 정리하거나, 상단 바를 바꾸거나, 실행 버튼을 고정하지 않는다.
또한 버전·태그·패키지와 GitHub Release를 만들지 않는다. 실제 구현이
시작될 때 이 문서의 **PLANNED** 항목을 작업 단위로 나누고, 검증된 항목만
**CURRENT**로 바꾼다.

## 16. 후속 구현: 추천 TMP 폰트

2026-10-05 후속 구현 범위다. 게임 목록은 등록 루트의 실제 폴더를 스캔한
결과이고, 엔진 감지·번역기 추천은 등록 signature/compat 규칙의 점수 기반이다.
AI 모델, 실시간 번역 품질 비교나 게임별 성공 이력 학습은 구현되어 있지 않다.

- Unity에서 TMP가 확인되고 대상 언어가 ko/ja/zh이면 등록 Unity 범위에 맞는
  폰트 추천과 범위 근거를 표시한다. 추정 매핑은 추정으로 유지한다.
- 번역기 설치 카드의 “추천 TMP 폰트 함께 설치”를 끄면 별도 main 발급 계획을
  실행한다. 이미 있는 같은 이름의 폰트를 확인 없이 덮어쓰지 않는다.
- 기존 호환 XUnity 단일 설치에는 “추천 폰트 추가”를 제공하고, 파일이 이미
  있으면 복사 없이 폴백을 연결한다. DLL·로더·언어·서비스·override·주석과
  알 수 없는 사용자 설정은 이 단독 작업의 변경 대상이 아니다.
- 기존 설정 경로와 fallback 키 매핑, payload 건강 상태, v2 영수증과
  font/config/metadata 경로를 재검증한다. TMP·Unity 불명, 중복 payload,
  손상 기록, 연결 경로 또는 기존 font 영수증의 덮어쓰기에는 강제 버튼이 없다.
- 별도 font 영수증이 설정의 이전 상태를 보관한다. translator 영수증의 원본
  hash/backup은 그대로 두고, 정확한 predecessor chain만 정상 overlay로
  인정한다. 전체 제거는 font → translator 순서로 복원한다.
- 폰트를 준비하지 못하면 없는 파일로 fallback 키를 바꾸지 않고 사용자
  조치 대기로 남긴다. 설치·실패 후 상세·설정·폰트 상태는 같은 postState로
  자동 갱신된다.

core/renderer/desktop guard 단위 테스트와 ko/en offline Electron flow에서
옵트아웃, 단독 설치, 실제 7z fixture 추출, DLL 미변경, 설정/기록 갱신과
역순 제거를 검증한다. fixture의 atlas 내용은 합성 데이터이며 실제 게임의
한글 렌더링, upstream 번들의 실게임 호환성, 일반 uGUI 폰트 자동 선택이나
시스템 TMP 3.2+ 여부까지 검증한 것은 아니다. 버전·태그·공개 Release는
이 후속 기능 구현 자체와 별도다.

## 17. 후속 구현: RPG Maker 로컬 MTool 연결

2026-10-05 후속 구현의 **CURRENT** 범위는 기존 외부 도구의 실행 인계다.
지원 엔진은 RPG Maker MV/MZ와 RGSS(XP/VX/VX Ace)이며, Wolf RPG나 MTool의
다른 지원 엔진으로 자동 확장하지 않는다. 실제 게임의 자동 선택·번역 결과
검증은 **PLANNED**이며, 런처에서 프로세스가 열렸다는 응답과 구분한다.

### 17.1 설정과 상세 카드

- Windows에서는 명시적 설정이 없을 때 `D:\MTool`을 기본 확인한다. 설정의
  폴더 선택은 기존 번들 상위 폴더 또는 `Tool` 폴더를 시스템 선택기로 받는다.
  알려진 `MTool.exe`, NW.js manifest와 `www/index.html` 배치를 확인하며,
  일반 파일·디렉터리인지, 상위 경로에 symlink/junction이 없는지 검증한다.
  PE 형식 확인은 게시자 서명·바이너리 안전성 검증이 아니다.
- “연결 해제”는 `mtoolRoot: null`을 저장해서 기본 경로도 재활성화하지 않는다.
  MTool, 설정, 게임 라이브러리, 인증·활성화 파일을 삭제하지 않는다.
- 설정 진입과 실행 요청 실패 시 도구 상태를 다시 확인한다. 확인 중에는
  실행·연결 변경 버튼을 잠그며, 늦게 도착한 이전 조회가 최신 상태나
  연결 해제 결과를 덮어쓰지 못한다. 외부에서 도구 파일을 이동·삭제하거나
  복구한 경우 다음 설정 진입에 실제 상태와 버튼이 갱신된다.
- “MTool로 게임 열기”는 main이 등록 게임을 다시 감지한 뒤 검증한 실행
  파일의 절대 경로를 인수 배열 한 항목으로 전달한다. 작업 디렉터리는
  검증한 MTool `Tool` 경로이며, shell·배치 파일·렌더러의 임의 경로나 인수
  문자열을 실행하지 않는다. 설치/설정 작업 중에는 실행 시작을 차단한다.
- “MTool만 열기”와 “게임 실행 파일 위치 열기”를 수동 선택의 대안으로 둔다.
  자동 선택이 되지 않으면 MTool 창에 실행 파일을 끌어 놓거나 직접 선택한다.
  원문·대상 언어와 번역 시작은 MTool 창에서 사용자가 결정한다.
- 외부 작업을 마친 뒤 “적용 후 새로고침”으로 해당 게임을 deep 재감지한다.
  기존 targeted refresh와 revision 병합으로 목록·상세 상태를 갱신하지만,
  marker 발견은 번역 성공이나 게임 실행 성공의 증거로 표시하지 않는다.

### 17.2 외부 소유권과 검증 경계

IndieDeck은 MTool을 다운로드·복사 설치·업데이트하지 않고, 내부 설정·인증
파일·게임 라이브러리를 읽거나 수정하지 않는다. 이 동작은 설치 진행률이나
IndieDeck receipt를 만드는 작업이 아니다. MTool이 나중에 바꾼 게임 파일도
IndieDeck 제거의 복원 범위에 포함되지 않는다. 따라서 사용자에게 **게임을
먼저 별도 백업하고, MTool 작업과 IndieDeck의 번역기·모드 설치를 겹치지
말 것**을 안내한다. 현재 런처는 MTool의 작업 종료를 감시하거나 전체 외부
세션 동안 게임을 잠그지 않는다.

[공식 사용 가이드](https://mtool.app/tutorial.php?lang=en)는 게임 선택과 언어
설정·번역 시작의 수동 경로를 설명하고,
[제작자의 인수 전달 안내](https://bbs.mtool.app/topic/850/mtool%E5%90%AF%E5%8A%A8%E5%91%BD%E4%BB%A4%E6%98%AF%E5%90%A6%E6%9C%89%E5%8F%82%E6%95%B0/3)는
실행 파일 경로 인수 방식의 근거다. 이는 **documented handoff**이며,
현재 로컬 MTool 배포와 실제 게임의 자동 선택·번역 동작을 검증한 증거는
아니다. 도구 파일 재배포, 자체 주입기 구현, 외부 변경의 자동 제거·복원은
이 기능에 포함되지 않는다.

검증은 core/desktop guard/renderer 모델과 ko/en offline Electron flow로 수행한다.
합성 게임·MTool PE fixture만 사용하고 MTool spawn을 테스트 진입점에서만
가로채므로 실제 MTool이나 게임을 실행하지 않는다. 단일 게임 인수와 도구
CWD, 도구만 열기, 실제 합성 marker의 targeted refresh, 파일 무효화·복구 뒤
설정 상태 재조회, 명시적 연결 해제와 IPC 경계를 검증한다. 이는 실제 게임의
자동 선택·번역 성공에 대한 증거가 아니다.
