# 게임 썸네일과 Steam 이미지

현재 소스 기준 기능이다. 배포 여부와 사용 가능한 버전은
[GitHub 릴리즈](https://github.com/tjwlstj/indie-deck/releases/latest)에서
확인한다. 썸네일 탐색은 게임을 실행하거나 게임 파일을 수정하지 않는다.

게임 목록과 상세 화면에서 이미지를 보여준다. 사용자가 이전에 고른 Steam
이미지가 있으면 이를 먼저 가져오려고 시도한다. 그 이미지가 없거나 가져오지
못하면 게임 폴더의 `cover.png`, `cover.jpg`, `cover.jpeg`, `cover.webp`,
`folder.png`, `folder.jpg`, `poster.png`, `poster.jpg`, `thumbnail.png`,
`thumbnail.jpg`를 정해진 순서로 살펴본다. 로컬 이미지가 없으면 Steam 설치
manifest의 설치 폴더 이름 또는 게임 폴더의 `steam_appid.txt`에서 AppID를
찾고 해당 ID의 Steam 공식 CDN 이미지를 요청한다. 일치하는 설치 manifest가
여럿이면 임의로 하나를 선택하지 않는다.

`steam_appid.txt`에는 개발·테스트용 ID나 다른 게임의 ID가 들어 있을 수 있어,
공식 CDN에서 받았다는 사실만으로 현재 게임과 이미지가 일치한다는 보장은
없다. 발견한 이미지가 잘못됐다면 게임 상세 화면의 **Steam 이미지 검색**에서
게임에 맞는 결과를 직접 고를 수 있다. 이 버튼을 누르면 게임 제목이 Steam에
전송된다. 결과의 이름을 확인하고 선택하면 그 게임에 대한 AppID가 런처의
사용자 설정에 저장되고 이미지가 표시된다. 표시된 이미지가 맞는지 확인해
준다. 선택하지 않은 검색 결과는 적용되지 않는다.

이미지는 실행 중 메모리에 캐시하며, 수동 선택한 AppID와 실제 이미지 파일은
다르게 취급한다. 다시 실행할 때 Steam 이미지가 필요하면 다시 가져와야 하므로
오프라인에서 이전 Steam 이미지가 보인다는 보장은 없다. 게임 폴더에 유효한
로컬 이미지가 있으면 네트워크 없이 표시할 수 있다. 네트워크 실패 시에는
로컬 이미지를 확인하고, 이미지가 없으면 기본 표시를 사용한다.

지원 형식은 PNG·JPEG·WebP다. 이미지 크기와 형식을 제한하며, 표시되는
출처는 로컬 게임 폴더 또는 Steam이다. Steam manifest 읽기는 이미 발견한
게임의 이미지 식별에 사용하며, Steam 계정의 게임 목록 전체를 가져오거나
소유권을 확인하는 기능은 아니다.

## MTool과의 관계

Windows에서 사용자가 연결한 MTool은 RPG Maker MV/MZ·RGSS와 Wolf RPG,
Ren'Py, KiriKiri로 판정된 게임에 수동 전달할 수 있다. 실행파일을 MTool에
넘긴 후 게임 선택과 번역 진행·결과는 MTool에서 확인해야 한다. 이 연결은
개별 게임의 번역 성공을 보증하지 않는다. 공식 지원 엔진 및 사용법은
[MTool](https://mtool.app/)과 [공식 안내](https://mtool.app/tutorial.php?lang=en)를
참고한다.

Unity 폴더의 기존 MTool 흔적은 탐지될 수 있지만, 이는 해당 게임에 MTool
수동 전달이 지원된다는 뜻이 아니다. Unity 번역은 해당 게임에 맞는 별도의
번역기·로더 경로를 확인한다.
