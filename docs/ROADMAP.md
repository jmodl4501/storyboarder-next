# 로드맵 — 하나씩 붙일 기능

원칙: **기획 흐름(대본 → 보드 → 프롬프트 → 영상)** 을 두껍게 만드는 순서로. 각 항목은 독립적으로 PR 하나 크기이며, 붙일 때 관련 테스트(`tests/`)를 같이 추가합니다.

## v0.1 — 기반

- [x] 원작 호환 프로젝트 포맷 + 레이어 드로잉 엔진 (필압, 되돌리기, 어니언 스킨, 가이드)
- [x] 보드/샷 관리, 타임라인 드래그, 애니매틱 재생, 인쇄 시트
- [x] 샷 타입 · 카메라 무브 · 상태 · 태그
- [x] 레퍼런스 링크(YouTube/Vimeo/웹) 메타데이터 추출
- [x] 대본(Fountain/한국어) → 보드
- [x] 규칙 기반 프롬프트 빌더, OpenAI 호환 다듬기, Higgsfield image-to-video 요청/폴링
- [x] 내보내기: ZIP · CSV · Markdown/JSON 프롬프트 팩 · .storyboarder
- [x] 무손실 PNG 재압축, 유닛/API/e2e 테스트

## v0.2 — 레퍼런스 수집과 영상 분석 결과 가져오기

- [x] **레퍼런스 화이트보드** — 프로젝트당 무한 캔버스(`ext.whiteboard`): 이미지/영상/PDF 업로드(`assets/`), YouTube·Vimeo 인라인 임베드, 링크 카드, 스티키 노트, 텍스트, 프레임(그룹), 연결선, 보드 카드(더블클릭 → 에디터), 검색, 되돌리기, 자동 저장. 이미지 → 레퍼런스 레이어, 링크 → 보드 링크.
- [x] **영상 분석 결과 → 보드** — 샷/자막 JSON · PySceneDetect CSV · SRT/VTT 를 보드로(샷 타입·카메라 무브 어휘 매핑, 자막 → 대사, 시작 시간 링크, `ext.source` 출처, 화이트보드 카드 옵션). 파이프라인 설계는 [VIDEO_INTELLIGENCE.md](VIDEO_INTELLIGENCE.md).
- [x] `가져오기 ▾` 메뉴, 보드/화이트보드 전환(`Ctrl+1/2`), 홈 화면·에디터 재디자인, ZIP 에 `whiteboard.md` + 에셋 포함.
- [x] 테스트: 유닛·API 61개(+17), e2e 18단계(+2). 문서: ANALYSIS_IMPORT, VIDEO_INTELLIGENCE.

## v0.2.x — 가져오기 후속

1. **타임라인 JSON 가져오기** — 분석 파이프라인의 편집 결과 `{ timeline: [{ clip_id, source, in_frame, out_frame, timeline_position }] }` 를 소스별 샷 데이터와 조인해 **편집 순서대로** 보드 생성(컷 길이 = out−in). 여러 소스 영상의 샷을 한 보드 열로.
2. **키프레임 이미지 가져오기** — 분석 결과의 `thumbnail`/`keyframes[]` 경로(로컬 파일 또는 URL)를 에셋으로 받아 보드의 reference 레이어 또는 화이트보드 카드에 자동 배치(지금은 경로만 `ext.source.thumbnail` 에 보존).
3. **중복 가져오기 감지** — 같은 `videoId + shotId` 가 이미 있으면 갱신/건너뛰기 선택.
4. **화이트보드 → 보드 일괄 변환** — 선택한 이미지 카드들을 순서대로 새 보드(reference 레이어)로.
5. **화이트보드 내보내기** — PNG 한 장(전체/프레임 단위), 프레임별 Markdown 은 이미 ZIP 에 포함.

## v0.3 (현재) — 영상 → 장면별 스토리보드

- [x] **영상 주소/파일 → 장면 감지 → 보드** — 브라우저 안에서 `<video>` 배속 재생 + `requestVideoFrameCallback` 샘플링, 블록 움직임 보정 컷 점수(팬/줌은 컷이 아님), 적응 임계값, 플래시 거부, 페이드/디졸브/전환 재고정, 대표 프레임 캡처. 서버는 파일만 가져옴(직접 URL 스트리밍, yt-dlp 선택: 자막·챕터·진행률). 로컬 파일은 서버를 거치지 않음.
- [x] **보드 종류** — 캡처 프레임(reference) / 졸라맨·간단한 형체(윤곽 스케치 fill + 졸라맨·카메라 무브 pencil) / 둘 다(트레이싱용). 졸라맨 렌더러 `sketch.js`(포즈 9종·방향·샷 타입별 기본 프레이밍·도형·지평선·카메라 무브 표기, 결정적 지터).
- [x] **장면 설명** — 규칙 기반(밝기·채도·따뜻함·주조색·움직임·pan/tilt/zoom/handheld 추정, 한국어) + 비전 모델 선택(`describe-scenes`, 10장면/요청, `figures[]/shapes[]/horizon` 배치). 자막 → 대사, 챕터 → 태그, 시작 시간 링크, `ext.source` 측정값.
- [x] 서버: `videoFetch.js`, `sceneImport.js`, 원시 바이트 에셋 스트리밍(영상 한도 분리), 보드가 참조하는 에셋 GC 보호, `/cache/video` Range 서빙. 테스트 75개 / e2e 19단계. 문서: VIDEO_TO_STORYBOARD.

### v0.3.x — 장면 스토리보드 후속

1. **장면 다듬기 UI** — 결과 격자에서 두 장면 합치기 / 한 장면 가르기(시간 입력) / 대표 프레임 시각 바꾸기(플레이어에서 "이 프레임으로").
2. **사람 자리 추정(모델 없이)** — 얼굴/사람 감지를 브라우저 모델(예: MediaPipe, 선택 다운로드)로 붙여 졸라맨 위치·샷 타입을 비전 LLM 없이도 채우기.
3. **오디오 큐** — 디코딩한 오디오 파형으로 무음/대사 구간을 잡아 컷 감지 보조 + 보드 노트에 "대사 있음/음악만" 표시 (Web Audio, 의존성 없음).
4. **Whisper 자막** — 로컬 whisper.cpp/`faster-whisper` 를 서버 선택 도구로 붙여 YouTube 가 아닌 파일에도 대사 넣기 (`WHISPER_PATH`).
5. **장면 비교 보기** — 같은 영상의 원본 캡처 보드 ↔ 내 콘티 보드를 좌우로 (v0.4 "보드 간 비교" 와 합침).

## v0.4 — 기획 UX 보강 (작은 것부터)

- **보드 간 비교/스크럽** — 타임라인에서 Shift+클릭으로 두 보드를 좌우 비교, 플레이어에 프레임 스크럽 바.
- **씬 구분선** — 씬 헤딩 보드에 타임라인 구분선 + 씬별 접기, CSV/MD 에 씬 컬럼.
- **템플릿 보드** — 자주 쓰는 구도(OTS, 2-shot, 인서트) 를 밑그림 템플릿으로 삽입 (`public/templates/*.svg`, 저장소 용량 작음).
- **링크 미리보기 임베드** — 인스펙터에서 YouTube 임베드를 시작 시간부터 재생(화이트보드에는 이미 있음 → 인스펙터로 확장).
- **캐릭터/장소 사전** — 프로젝트 `ext.cast`, `ext.locations` 에 이름 → 외형 설명을 등록하면 프롬프트 빌더가 대사 화자/씬 헤딩에서 치환 (일관된 캐릭터 디자인 유지의 핵심).
- **보드 메모 음성 입력** — 브라우저 Web Speech API 로 노트 받아쓰기 (의존성 없음).

## v0.5 — AI 파이프라인

- **키 프레임 생성(text-to-image)** — OpenAI 호환 이미지 API / Stability / Replicate 를 선택형 프로바이더로; 결과를 자동으로 레퍼런스 레이어 + `ext.keyframes[]` 에.
- **자동 폴링 + 웹훅** — `/api/ai/webhook` 수신, SSE 로 보드 상태 실시간 갱신. (Higgsfield 웹훅 문서: https://docs.higgsfield.ai/docs/how-to/webhooks)
- **이미지 공개 URL 자동화** — `PUBLIC_BASE_URL` 대신 S3/R2 presigned 업로드 옵션(`IMAGE_PUBLISH=s3`), 토큰 만료형 이미지 경로.
- **Higgsfield multi_shots** — 같은 샷의 보드 묶음(1A~1C)을 `multi_prompt[]` 로 묶어 한 번에 요청, 보드 길이 → 각 구간 duration.
- **다른 영상 모델** — Kling 공식 API, Runway, Luma, Veo 를 같은 `submit/getStatus` 인터페이스로.
- **프롬프트 버전 관리** — `ext.promptHistory[]`, 어떤 프롬프트로 어떤 결과가 나왔는지 추적, 승인된 프롬프트 잠금.

## v0.6 — 프리비즈/연계

- **간단 프리비즈 내보내기** — 보드 + 길이 → MP4 애니매틱(브라우저 `MediaRecorder`/WebCodecs, 서버 ffmpeg 불필요).
- **편집 툴 연계** — EDL/CSV 마커 내보내기(Resolve/Premiere), 생성된 클립 URL 을 다운로드해 순서대로 이어 붙이는 스크립트(ffmpeg 가 있는 환경용 `scripts/assemble.js`).
- **Blender Grease Pencil 왕복** — 보드 PNG ↔ GP 프레임 가져오기/내보내기용 Blender 애드온 스크립트(문서 + 50줄 파이썬).
- **Figma 플러그인** — 선택한 프레임을 보드로 보내기 (REST API 호출만).
- **PSD 연결** — 원작의 `board.link` 를 사용해 외부 편집기(Krita/Photoshop)에서 편집 후 레이어 PNG 갱신 감시.

## v0.7 — 협업

- **다중 사용자 안전장치** — 보드 단위 낙관적 잠금(`lastEdited` 비교), 변경 알림(SSE).
- **댓글/승인** — 보드별 코멘트 스레드, 리뷰 모드(그리기 잠금, 코멘트만).
- **간단 인증** — `AUTH_TOKEN` 하나로 시작, 이후 OAuth(GitHub) 옵션.

## 기술 부채 / 품질

- 드로잉 엔진: 안정화(stabilizer), 스트로크 벡터 저장(후처리·스케일 변경 대비), 타일 기반 되돌리기 메모리 절감.
- 접근성: 키보드만으로 모든 모달 조작, 고대비 테마.
- i18n: UI 문자열 `public/js/i18n.js` 로 분리 (한국어/영어).
- 패키징: `npx storyboarder-next` 로 바로 실행되는 bin, Electron 없이 Tauri 셸 옵션.
- 화이트보드: 노드 수천 개일 때 뷰포트 밖 노드 가상화, 이미지 썸네일 자동 생성(큰 원본은 지연 로드), 멀티 터치 핀치 제스처 정밀도.

## 설계 메모

- 새 데이터는 **항상 `ext` 아래**에 두어 원작 호환을 깨지 않는다.
- 네트워크를 쓰는 모듈은 `fetchImpl` 주입 가능하게 만들어 오프라인 테스트를 유지한다.
- 외부 리소스(모델, 폰트, 브라우저)는 저장소에 넣지 않고 문서에 링크한다.
- 영상 분석은 이 앱이 직접 하지 않는다(ffmpeg/모델 의존성 없음). 분석기는 바깥에서 돌리고 **결과 파일(JSON/CSV/SRT)로만** 만난다 → [VIDEO_INTELLIGENCE.md](VIDEO_INTELLIGENCE.md), [ANALYSIS_IMPORT.md](ANALYSIS_IMPORT.md).
- 화이트보드 데이터는 `ext.whiteboard` 전용 엔드포인트로만 쓰고, 프로젝트 전체 PUT 은 이를 건드리지 않는다(두 편집면이 서로 덮어쓰지 않도록).
