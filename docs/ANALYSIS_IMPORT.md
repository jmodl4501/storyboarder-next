# 영상 분석 결과 가져오기 (Analysis Import)

영상 분석 파이프라인([`VIDEO_INTELLIGENCE.md`](VIDEO_INTELLIGENCE.md))이 만든 **샷 / 자막 데이터**를
보드로 바꿉니다. 에디터의 **가져오기 ▾ → 영상 분석 결과 → 보드** 에서 붙여넣거나 파일을 드롭하면
미리보기를 보여 주고, 확인하면 보드(+ 선택 시 화이트보드 카드)를 만듭니다.

- 서버 모듈: `server/lib/analysisImport.js` (의존성 없음, 순수 파서)
- API: `POST /api/import/analysis/preview`, `POST /api/projects/:id/import/analysis` ([API.md](API.md))
- 테스트: `tests/analysis-import.test.js`

---

## 1. 받아들이는 형식 (자동 감지)

| 형식 | 감지 기준 | 만들어지는 것 |
| --- | --- | --- |
| **스토리보드 Markdown** | `# 제목` + `### 장면 0001 · 시작–끝` | 장면 1개 = 보드 1개. 화면→액션, 분석→노트, 한/영 인용문→대사, `scenes/` 이미지→reference 레이어 |
| **분석 JSON** | `{` 또는 `[` 로 시작하는 JSON | 샷 1개 = 보드 1개. 자막은 시간이 겹치는 샷의 **대사**로. 샷이 없고 자막만 있으면 자막 1개 = 보드 1개 (MCU · static 기본값, 첫 보드만 새 샷) |
| **PySceneDetect CSV** | `Scene Number,Start Frame,…` 헤더 (`list-scenes` 출력) | 씬 1개 = 보드 1개 (설명 없음, 시간·프레임만). fps 는 첫 행에서 추정 |
| **SRT** | `00:00:01,000 --> 00:00:03,500` 블록 | 자막 1개 = 보드 1개 (대사). `이름:` / `[이름]` / `SPEAKER_01:` 접두사는 화자로 인식 |
| **WebVTT** | `WEBVTT` 헤더 | SRT 와 같음. `<v 화자>` 태그 지원 |

알 수 없는 텍스트는 400 오류(`unrecognized format`) 로 거절합니다 — 대본은 **대본 / 텍스트 → 보드** 를 쓰세요.

Markdown은 `제목/제목.md`와 `제목/scenes/*.jpg` 구조를 권장합니다. 앱에서 **보고서 폴더 선택**을 누르면 문서와 캡처가 자동 연결됩니다.

---

## 2. JSON 구조와 허용 필드

최상위는 객체(권장) 또는 샷 배열입니다. 키 이름은 **snake_case 와 camelCase 모두** 인식하며,
`result` `results` `data` `analysis` `video` `output` `payload` `response` 키로 한 겹 감싼 것도 (샷/자막 배열이 들어 있으면) 풀어서 읽습니다.

```json
{
  "video_id": "VID001",                 // id · source_id 도 가능
  "title": "브랜드 필름 레퍼런스",
  "source": { "url": "https://youtu.be/…", "path": "D:/footage/a.mp4", "hash": "…" },
  "metadata": { "fps": 24, "width": 1920, "height": 1080, "duration": 93.5 },   // fps 는 최상위에 있어도 됨
  "shots": [ … ],                       // scenes · cuts · clips · segments_visual 도 가능
  "transcript": [ … ]                   // transcripts · asr · speech · subtitles · captions · audio.transcript 도 가능
                                        // (text 가 있는 segments[] 배열, { segments: [...] } 객체도 인식)
}
```

### 2.1 샷 (`shots[]`)

| 보드 필드 | 읽는 키 (우선순위 순) | 비고 |
| --- | --- | --- |
| 식별자 (노트 `[SH001]`, `ext.source.shotId`) | `id` `shot_id` `scene_id` `number` `index` | 없으면 `SH001…` 자동 |
| 시작 / 끝 시간 | `start_time` `startTime` `start_sec` `start_timecode` `in` `start` / `end_*` `out` `end` | 초(숫자), `"12.5s"`, `"00:01:02.500"`, `"01:02"`, `"HH:MM:SS:FF"`(fps 필요), `{frame, time}` 객체 모두 가능 |
| 시작 / 끝 프레임 | `start_frame` `in_frame` `first_frame` / `end_frame` `out_frame` `last_frame` | 프레임만 있으면 `fps` 로 초를 계산 (샷의 `fps` → 파일의 `fps` 순) |
| 길이 (`duration` ms) | 끝 − 시작, 없으면 `duration` `length` 키, 그것도 없으면 프로젝트 기본 길이 | 최소 100 ms |
| **액션** (`action`) | `visual_description` → `description` `desc` `caption` `summary` `content` `title` → `objects` 나열 | |
| **대사** (`dialogue`) | `transcript_ids` 로 연결된 자막 → 없으면 시간이 겹치는 자막(겹침 ≥ 0.5초 또는 자막의 절반) → 없으면 샷 안의 `transcript`/`speech`/`dialogue` 문자열 | `화자: 텍스트` 형식, 여러 줄 |
| **샷 타입** (`ext.shotType`) | `camera.shot_type` `camera.type` `camera.size` `camera.framing` / 최상위 `shot_type` `shot_size` `framing` | §3 매핑. 매핑 실패 시 원문을 노트에 `샷: …` 로 보존 |
| **카메라 무브** (`ext.cameraMove`) | `camera.movement` `camera.move` `camera.motion` / 최상위 `camera_movement` `movement` `motion` | §3 매핑. 실패 시 노트에 `카메라: …` |
| **태그** (`ext.tags`) | `tags` `keywords` `labels` + `mood`(`emotion` `tone` `atmosphere`) | 최대 20개 |
| **노트** (`notes`) | `[id] 시작–끝 · f시작–끝 · 장소(location/place/setting + time_of_day) · 카메라/샷(매핑 실패분) · 객체(objects/entities/subjects) · 행동(actions/activities/events) · 분위기 · 오디오(audio_events/audio/sound)` | 한 줄, `·` 로 구분. 시간은 `MM:SS.s` |
| **레퍼런스 링크** (`ext.links[0]`) | 파일의 `source.url`(또는 `url` `video_url`)이 있을 때 | YouTube/Vimeo 면 `&t=시작초` 가 붙은 링크 + 임베드 URL + 썸네일, 그 외는 일반 웹 링크 |
| **출처** (`ext.source`) | `videoId, shotId, startFrame, endFrame, startTime, endTime, fps, file, url, thumbnail` | 원본으로 되돌아가기 위한 메타데이터. `thumbnail`(`thumb` `image` `keyframe` `poster`) 경로는 보존만 하고 이미지는 가져오지 않음 |

모든 샷은 `newShot: true` 로 만들어져 샷 번호가 `1A, 2A, 3A…` 로 매겨집니다.

### 2.2 자막 (`transcript[]`)

| 필드 | 읽는 키 |
| --- | --- |
| id | `segment_id` `segmentId` `id` (없으면 `ASR_001…`) |
| 시작 / 끝 | `start_time` `start` `start_sec` `from` `begin` / `end_time` `end` `end_sec` `to` `finish` (초 또는 타임코드) |
| 화자 | `speaker` `speaker_id` `speakerId` `who` |
| 텍스트 | `text` `transcript` `content` `sentence` (없는 항목은 건너뜀) |

`words[]` 는 개수만 세고 보드에는 쓰지 않습니다 (문장 단위면 충분).

---

## 3. 어휘 매핑

분석기마다 쓰는 용어가 달라서 느슨하게 매핑합니다. 전체 키를 정규화(소문자, 공백·`_`·`-` 제거)해 **정확히 일치 → 단어 단위 일치 → 5글자 이상 별칭 포함** 순으로 찾고, 한국어도 인식합니다.

### 샷 타입 → `ext.shotType`

| 코드 | 인식하는 표현 (일부) |
| --- | --- |
| `EWS` | extreme wide, establishing, extreme long, ELS, 익스트림와이드, 설정샷 |
| `WS` | wide, long shot, LS, very wide, 와이드, 롱샷 |
| `FS` | full, full body, 풀샷, 전신 |
| `MS` | medium, mid, waist, 미디엄, 웨이스트샷 |
| `MCU` | medium close-up, bust, chest, 바스트샷 |
| `CU` | close, close-up, headshot, face, 클로즈업 |
| `ECU` | extreme close-up, big close-up, macro, XCU, BCU, 익스트림클로즈업 |
| `OTS` | over the shoulder, 오버더숄더 |
| `POV` | point of view, first person, subjective, 시점샷, 1인칭 |
| `TWO` | two shot, 2S, 투샷 |
| `INSERT` | insert, detail, cutaway, cut-in, product, 인서트, 디테일 |
| `LOW` | low angle, worm's eye, 로우앵글, 앙각 |
| `HIGH` | high angle, 하이앵글 |
| `BIRD` | bird's eye, aerial, drone, top-down, overhead, 조감, 드론, 부감 |
| `DUTCH` | dutch, canted, tilted, oblique, 더치앵글, 사각 |

### 카메라 무브 → `ext.cameraMove`

| 코드 | 인식하는 표현 (일부) |
| --- | --- |
| `static` | static, locked(-off), fixed, still, none, tripod, 고정, 픽스 |
| `pan-left` / `pan-right` | pan (+ left/right/좌/우 로 방향 결정; 방향 없으면 right) |
| `tilt-up` / `tilt-down` | tilt (+ up/down) |
| `dolly-in` / `dolly-out` | dolly, push in, pull out/back, approach, 달리인/아웃 |
| `truck-left` / `truck-right` | truck, track left/right, lateral, slide, crab |
| `crane-up` / `crane-down` | crane, boom, jib, pedestal, rise, descend, flyover |
| `handheld` | handheld, shaky, documentary, run and gun, 핸드헬드 |
| `zoom-in` / `zoom-out` | zoom, crash zoom, 줌인/아웃 |
| `orbit` | orbit, arc, circle, 360, 회전 |
| `rack-focus` | rack focus, focus pull, 포커스이동 |
| `follow` | follow, tracking (shot), steadicam, gimbal, chase, 팔로우, 트래킹 |
| `whip-pan` | whip pan, swish pan, 휩팬 |

`drone` 처럼 **샷 타입 어휘에만 있는 카메라 표현**은 매핑되지 않고 노트에 `카메라: drone` 으로 남습니다 (의도적 — 잘못 매핑하는 것보다 낫습니다).

---

## 4. 가져오기 옵션

| 옵션 | 기본 | 설명 |
| --- | --- | --- |
| 현재 보드 뒤에 삽입 | 켬 | 끄면 맨 뒤에 붙습니다 (`afterUid` 생략) |
| 화이트보드에도 카드로 추가 | 켬 | 가져온 보드들을 **프레임 하나(제목 = 파일 `title` 또는 `video_id`)** 안에 격자로 배치하고, 원본 URL 이 있으면 임베드 카드를 함께 놓습니다 (`addToWhiteboard`) |
| 빈 첫 보드 대체 | 항상 | 새 프로젝트의 비어 있는 첫 보드는 가져온 보드로 대체됩니다 (`replaceEmptyFirstBoard: false` 로 끌 수 있음, API 전용) |

프로젝트 파일에는 `ext.imports[]` 에 가져온 기록(`at, kind, format, videoId, boards, sourceUrl, sourcePath`)이 쌓이고, 제목이 비어 있으면 파일의 `title` 로 채웁니다.

---

## 5. 예시 파일

### 5.1 JSON (모달의 "예시 JSON 넣기" 축약판)

```json
{
  "video_id": "brand_film_v3",
  "title": "브랜드 필름 레퍼런스 분석",
  "source": { "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
  "metadata": { "fps": 24, "width": 1920, "height": 1080, "duration": 32 },
  "shots": [
    { "shot_id": "SH001", "start_frame": 0, "end_frame": 96, "description": "도시 스카이라인 위로 해가 뜬다",
      "camera": { "shot_type": "wide", "movement": "drone" }, "tags": ["오프닝", "도시"], "mood": "희망적", "audio_events": ["BGM 시작"] },
    { "shot_id": "SH002", "start_frame": 96, "end_frame": 240, "visual_description": "여성 창업자가 공유 오피스에서 노트북을 연다",
      "objects": ["노트북", "커피잔"], "camera": { "shot_type": "medium", "movement": "dolly in" }, "transcript_ids": ["ASR_001"] }
  ],
  "transcript": [
    { "segment_id": "ASR_001", "start_time": 4.2, "end_time": 9.5, "speaker": "NARRATOR", "text": "시작은 언제나 작은 질문이었습니다." }
  ]
}
```

결과: 보드 2개 — `1A` WS · 4.0 s · 노트 `[SH001] 00:00.0–00:04.0 · f0–96 · 카메라: drone · 분위기: 희망적 · 오디오: BGM 시작` ·
링크 `youtube.com/watch?v=aqz-KE-bpKQ`, `2A` MS · dolly-in · 6.0 s · 대사 `NARRATOR: 시작은 …` · 링크 `…&t=4s`.

### 5.2 PySceneDetect CSV

```
scenedetect -i footage.mp4 detect-adaptive list-scenes -o out
```

```
Timecode List:,00:00:03.000,00:00:08.500
Scene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames),Length (timecode),Length (seconds)
1,1,00:00:00.000,0.000,72,00:00:03.000,3.000,72,00:00:03.000,3.000
2,73,00:00:03.000,3.000,204,00:00:08.500,8.500,132,00:00:05.500,5.500
```

CSV 의 프레임 번호는 1부터 시작하므로 `start_frame` 은 1 을 빼서 0 기준으로 저장합니다.

### 5.3 SRT

```
1
00:00:01,000 --> 00:00:03,500
SPEAKER_01: 안녕하세요.

2
00:00:04,000 --> 00:00:06,000
반갑습니다.
```

---

## 6. API 로 직접 넣기

```bash
# 미리보기 (프로젝트 불필요)
curl -s -X POST localhost:3000/api/import/analysis/preview -H 'content-type: application/json' \
  -d '{"text": "<JSON/CSV/SRT 문자열>"}'
# 또는 {"data": {...객체...}}

# 가져오기
curl -s -X POST "localhost:3000/api/projects/내-프로젝트/import/analysis" -H 'content-type: application/json' \
  -d '{"data": {...}, "addToWhiteboard": true, "afterUid": "ABCDE"}'
```

응답: `{ project, created: [uid…], summary, warnings, whiteboard: { frame, cards } | null }`.
`summary` 에는 `format, videoId, title, fps, shots, transcriptSegments, boards, withDialogue, withShotType, withCameraMove, withThumbnail, totalMs, sourceUrl, sourcePath, truncated` 가 들어 있습니다. 한 번에 최대 500개까지 만듭니다.

---

## 7. 한계 / 다음 단계

- 외부 분석기 없이 **영상 주소/파일만** 있다면 이 가져오기 대신 `가져오기 ▾ → 영상 → 장면별 스토리보드` 를 쓰세요 — 브라우저가 직접 장면을 감지하고 대표 프레임 캡처/졸라맨 스케치까지 만듭니다([VIDEO_TO_STORYBOARD.md](VIDEO_TO_STORYBOARD.md)). 이 문서의 가져오기는 PySceneDetect·Whisper·VLM 등으로 이미 뽑아 둔 **정밀한 데이터**(프레임 단위 컷, 화자 분리 자막, 객체 목록)를 그대로 보존할 때 유리합니다.
- 썸네일·키프레임 이미지는 가져오지 않습니다 (경로만 보존). 보드 그림이 필요하면 화이트보드에 이미지를 붙이고 **레퍼런스로** 보내거나, 가져오기 ▾ → 이미지로 넣으세요.
- `timeline[]`(편집 결과) 형식은 아직 읽지 않습니다 — ROADMAP 의 "타임라인 JSON 가져오기" 항목.
- 같은 파일을 두 번 가져오면 보드가 두 번 생깁니다 (중복 검사 없음). `ext.source.shotId` 로 구분할 수 있습니다.
