# 영상 → 장면별 스토리보드 (v0.3)

`가져오기 ▾ → 영상 → 장면별 스토리보드`. 영상 주소(또는 로컬 파일)를 주면 **장면(샷) 단위로 잘라서** 장면마다 보드를 하나씩 만들고, 각 보드에 **장면 설명**을 붙입니다. 보드 그림은 두 가지(또는 둘 다)입니다.

| 보드 종류 | 어디에 그려지나 | 내용 |
|---|---|---|
| **캡처 프레임** | `reference` 레이어 | 장면 대표 프레임(JPEG). 바로 따라 그리거나 레퍼런스로 쓴다 |
| **졸라맨 · 간단한 형체** | `fill` + `pencil` 레이어 | 프레임을 단순화한 **윤곽 스케치**(fill) 위에 **졸라맨/도형/카메라 무브 표시**(pencil). 비전 모델이 있으면 인물 배치·포즈·샷 타입을 모델이 정하고, 없으면 윤곽 스케치 + 카메라 무브 표시만 (옵션으로 자리표시 졸라맨) |
| **둘 다** (기본) | `reference`(35%) + `pencil` | 연하게 깔린 프레임 위에 윤곽선과 졸라맨 — 트레이싱용 |

장면 설명은 보드의 **액션**(한 줄), **노트**(`[S003] 00:05.0–00:07.5 · 분위기 · (설명: AI / 자동 추정)`), **대사**(자막이 있을 때), **샷 타입 / 카메라 무브 / 태그**로 들어가고, 출처는 `ext.source` 에 남습니다 (아래 "데이터").

## 어디서 무엇이 돌아가나

```
URL ──▶ 서버: 파일만 가져온다 ──▶ /cache/video/<job>/<file> (same-origin, Range 지원)
파일 ─────────────────────────▶ 브라우저 object URL (서버로 보내지 않음)
                                     │
                                     ▼
                     브라우저 <video> 를 음소거·배속 재생하며 requestVideoFrameCallback
                     으로 모든 프레임을 64px 로 샘플링 → 컷 감지 · 대표 프레임 캡처 · 색/움직임 통계
                                     │
                     (선택) POST /api/ai/describe-scenes — 비전 모델이 장면 10개씩 설명 + 졸라맨 배치
                                     │
                     POST /api/projects/:id/import/scenes — 보드 N개를 한 번에 생성 (원자적)
                     POST /api/projects/:id/boards/:uid/image × N — 레이어 PNG 업로드
```

* **서버는 영상을 디코딩하지 않습니다.** ffmpeg 가 없어도 동작하고, 서버 CPU 를 쓰지 않습니다. 디코딩은 사용자의 브라우저가 합니다 (브라우저가 재생할 수 있는 형식이면 됩니다 — H.264 mp4, VP9/AV1 webm 등. HEVC/ProRes 는 브라우저에 따라 안 될 수 있음).
* **URL 종류**
  * 직접 영상 파일 URL (`https://…/clip.mp4`) → 서버가 스트리밍 다운로드 (`VIDEO_MAX_MB`, 기본 1024).
  * YouTube · Vimeo · 기타 페이지 → 서버에 **yt-dlp** 가 있을 때만 (`YTDLP_PATH` 또는 PATH). 자막(수동 > 자동)도 같이 받아 장면별 **대사**로 들어가고, 챕터는 태그/노트에 들어갑니다. ffmpeg 가 있으면 화질 선택(480/720/1080) 시 병합이 가능하고, 없으면 단일 파일 포맷으로 내려받습니다.
  * yt-dlp 가 없으면 모달 상단에 안내가 뜨고, 로컬 파일 드롭은 항상 됩니다.
* **공개 서버에서는** `POST /video/fetch` 가 서버를 다운로더로 만드는 셈이니 접근 제어(리버스 프록시 인증)를 두고, `VIDEO_MAX_MB` 를 낮추세요. 사설 IP 로의 요청은 기본 차단됩니다.

## 장면 감지 알고리즘 (`public/js/sceneDetect.js`)

의존성 없는 샘플 기반 감지기입니다. PySceneDetect 의 ContentDetector 와 같은 계열이지만, 브라우저 재생 특성(가변 프레임 간격)에 맞췄습니다.

1. **샘플링** — 8배속(설정 가능 4/8/16) 재생 중 `requestVideoFrameCallback` 이 주는 매 프레임을 64×36 캔버스로 축소. 샘플당 루마 배열 + 4×4×4 RGB 히스토그램 + 평균 밝기/채도/따뜻함.
2. **컷 점수** — 연속 샘플 사이에 `score = 0.6·(움직임 보정 루마 차) + 0.4·(히스토그램 거리×255)`.
   * 움직임 보정: 3×3 블록마다 ±8px 범위(2px 단계 → ±1 정밀)에서 최적 이동을 찾고, **질감 있는 블록들의 중앙값**을 전역 카메라 이동으로 씁니다. 평평한 배경 앞을 지나가는 피사체는 전역 이동으로 잡히지 않습니다. 블록 이동의 방사 성분으로 줌을 추정합니다.
3. **컷 판정** — `score ≥ 임계값(기본 30)` 이고 `score ≥ 최근 8샘플 중앙값 × 2.2`(핸드헬드/뮤직비디오 보호), 현재 장면이 최소 길이(기본 0.6 s) 이상일 때 **후보**로 두고, **다음 샘플이 그 변화를 유지할 때** 확정(단일 프레임 플래시 거부). 컷 시각은 두 샘플의 중간.
4. **전환 처리** — 컷 직후 최소 길이 안에 또 큰 변화가 오면 페이드/와이프 도중이었다는 뜻이므로 장면 시작을 **다시 고정**(re-anchor)해 깨끗한 프레임을 대표로 삼습니다. 평균 루마 < 12 또는 > 246 인 프레임은 블랙/화이트로 보고 장면을 닫고(`fade-out`), 다시 내용이 나오면 `fade-in` 으로 엽니다. 카메라가 정지해 있을 때 1 초 전 프레임과 크게 다르면 `dissolve`.
5. **대표 프레임** — 장면 시작 + 0.5 s 의 프레임(짧으면 첫 프레임)을 원본 해상도(최대 1600px)로 JPEG 캡처. 비전 모델에는 512px 로 줄여 보냅니다.
6. **통계 → 설명/카메라 무브** — 장면별 밝기·채도·따뜻함·주조색·움직임량·전역 이동(짧은 창 + 1 초 창)·줌 발산을 모아, 규칙으로 `pan-left/right`, `tilt-up/down`, `zoom-in/out`, `static`, `handheld` 를 추정하고 한국어 설명을 만듭니다. 이 설명은 **"밝은 따뜻한 톤 (주황 계열) 장면 · 카메라 오른쪽으로 팬"** 처럼 영상에서 실제로 측정한 것만 말합니다 — 내용(누가 무엇을 하는지)은 비전 모델이 있을 때만 들어갑니다.

튜닝: 컷 감도 슬라이더(14–70)가 임계값입니다. 뮤직비디오·액션은 40 이상, 인터뷰·정적 영상은 20 전후가 잘 맞습니다. 최대 장면 수에 도달하면 분석이 멈춥니다.

한계: 같은 장소에서 비슷한 구도로 바뀌는 컷(숏/리버스 숏이 비슷한 배경일 때)은 놓칠 수 있고, 매우 빠른 핸드헬드는 과분할될 수 있습니다. 샘플 간격이 재생 속도와 기기 성능에 따라 달라지므로(8배속·60Hz 화면이면 약 0.13 s), 감지 시각 오차는 ±1 샘플입니다.

## 졸라맨 렌더러 (`public/js/sketch.js`)

* 입력 레이아웃: `{ figures: [{ x, y, h, pose, facing, label }], shapes: [{ type, x, y, w, h, label }], horizon }`
  * `x,y` 머리 중심(프레임 비율 0–1), `h` 전신 높이/프레임 높이(0.2 작게, 0.9 전신 가득, ≥1.2 클로즈업), `pose` = `stand|walk|run|sit|lie|arms-up|point|crouch|wave`, `facing` = `left|right|front|back`.
  * `shapes.type` = `rect|ellipse|line` (좌상단 기준, `line` 은 `x,y → x+w,y+h`).
* 샷 타입이 있고 인물이 없으면 샷 타입별 기본 프레이밍(TWO: 두 명 마주봄, OTS: 전경 실루엣, INSERT: 사각 프레임 …).
* 카메라 무브는 빨간 화살표/프레임으로 표시(`PAN →`, `DOLLY IN` 사각 + 대각 화살표, `TILT ↑`, 핸드헬드 지그재그, 궤도 타원).
* 윤곽 스케치: 대표 프레임을 480px 로 줄여 3×3 블러 → Sobel 에지(평균+1.6σ 적응 임계값) → 어두운 영역 2단계 톤 워시. 결과는 `fill` 레이어(졸라맨 모드) 또는 `pencil` 레이어에 선만(둘 다 모드).
* 모든 선은 시드 기반 지터로 손그림 느낌을 내며, 같은 입력이면 같은 그림이 나옵니다(테스트 가능).

## 비전 모델 (선택)

`.env` 에 `AI_TEXT_BASE_URL / AI_TEXT_API_KEY` 가 있으면 `AI_VISION_MODEL`(기본 `AI_TEXT_MODEL`) 로 `POST /api/ai/describe-scenes` 를 호출합니다. 한 번에 장면 10개(각 512px JPEG, `detail: low`)를 보내고, 모델은 장면마다 `action`(≤ 60자 한국어 캡션) · `description` · `shotType` · `cameraMove` · `mood` · `tags` · `figures[]` · `shapes[]` · `horizon` 을 JSON 으로 돌려줍니다. 응답이 깨진 장면은 규칙 기반 설명으로 대체되고, 보드 노트에 `(설명: AI 모델명)` 또는 `(설명: 자동 추정 …)` 으로 출처가 남습니다. OpenAI `gpt-4o-mini`, OpenRouter 의 비전 모델, Ollama `llava`/`qwen2-vl` 등 OpenAI 호환 `chat/completions` 에 이미지 입력을 받는 모델이면 됩니다.

## 데이터

보드 `ext.source` (kind `video-scene`):

```json
{
  "kind": "video-scene", "videoId": "dQw4w9WgXcQ", "sceneId": "S003",
  "startTime": 4.9, "endTime": 7.5, "startFrame": 118, "endFrame": 180, "fps": 24,
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "file": "clip.webm",
  "asset": "/projects/<id>/assets/49011648b7-clip.webm",
  "descriptionBy": "ai | heuristic", "cutScore": 131.2,
  "metrics": { "brightness": 0.52, "saturation": 0.56, "warmth": 0.39, "motion": 26, "panX": -2.2, "zoom": 0, "gain": 0.77, "hue": "주황" }
}
```

프로젝트 `ext.imports[]` 에 `{ kind: "video-scenes", source, videoId, boards, sourceUrl, file, asset, mode, withAi }` 가 추가되고, "영상 파일을 프로젝트 자산으로 보관" 을 켜면 `assets/` 에 복사되어 모든 보드의 `ext.source.asset` 이 가리킵니다(화이트보드에는 영상 노드로 올라가 더블클릭 재생). YouTube 링크가 있으면 보드마다 **시작 시간으로 가는 링크**가 붙습니다.

## 테스트

* `tests/scene-detect.test.js` — 특징 추출, 움직임 보정 비교(팬 ≠ 컷), 카메라 무브 규칙, 한국어 설명, 자막 매칭, 주조색.
* `tests/video-fetch.test.js` — URL 분류, 직접 다운로드(용량 제한·비영상 거부), 가짜 yt-dlp 로 자막 → 대사, yt-dlp 부재 오류, `sceneImport.toBoards`, `describeScenes`(fetch 스텁).
* `tests/api.test.js` — `/video/capabilities`, `/import/scenes`(캐시 영상 보관 + 화이트보드 노드).
* `tests/e2e/smoke.js` — 10 초짜리 VP9 픽스처(`tests/e2e/fixtures/scenes.webm`, 컷 3 + 페이드)를 드롭 → 4 장면 감지 → 졸라맨 모드 보드 4개(fill+pencil) + 에셋 + 화이트보드 영상 노드. 헤드리스 크로미움은 H.264 를 디코딩하지 못하므로 픽스처는 webm 입니다.
