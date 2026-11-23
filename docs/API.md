# REST API

기본 주소 `http://localhost:3000`. 모든 요청/응답은 JSON(UTF-8). 오류는 `{ "error": "...", "details"?: ... }` 와 HTTP 상태 코드(400/404/409/413/502/503).
인증은 없습니다 — 로컬/LAN 용 도구입니다. 외부에 열 때는 [DEPLOY.md](DEPLOY.md) 의 주의사항을 보세요.

## 상태 / 메타

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | `{ ok, name, version, projectsDir }` |
| GET | `/api/meta` | 선택지 사전: `shotTypes`, `cameraMoves`, `boardStatus`, `layers`, `shotTypeLabelsKo`, `cameraMoveLabelsKo`, `ai`(연결 상태) |

## 프로젝트

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/projects` | | `[{ id, title, boardCount, totalDuration(ms), aspectRatio, fps, updated, thumbnail }]` 최근 수정순 |
| POST | `/api/projects` | `{ name, aspectRatio?, fps?, defaultBoardTiming?, style?, title? }` | `201 { id, project }` — `id` 는 이름에서 만든 폴더명. 빈 보드 1개 포함 |
| GET | `/api/projects/:id` | | `{ id, project, imageSize: [w, h] }` |
| PUT | `/api/projects/:id` | 프로젝트 JSON 전체 | `{ id, project }` — 서버 소유 필드(`url`, `layers`, `lastEdited`, `aspectRatio`)는 서버 값 유지, 샷 번호 재계산. **`ext.whiteboard` 는 이 경로로 바뀌지 않습니다**(아래 화이트보드 API 전용) |
| DELETE | `/api/projects/:id` | | `{ ok: true }` 폴더 전체 삭제 |

## 보드

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/projects/:id/boards` | `{ afterUid?, count?(≤50), board?: {action, dialogue, notes, duration, newShot, ext} }` | `201 { project, created: [uid…] }` |
| POST | `/api/projects/:id/boards/reorder` | `{ order: [uid, …] }` (전체 순서) | `{ project }` |
| POST | `/api/projects/:id/boards/:uid/duplicate` | | `201 { project, created }` 레이어 파일도 복사 |
| DELETE | `/api/projects/:id/boards/:uid` | | `{ project, index }` 이미지 파일도 삭제. 마지막 보드를 지우면 빈 보드가 새로 생김 |
| POST | `/api/projects/:id/boards/:uid/image` | 아래 | `{ board }` |

이미지 업로드 본문:

```jsonc
{
  "layers": { "pencil": "data:image/png;base64,…" },   // 변경된 레이어만 (PNG)
  "clearedLayers": ["tone"],                           // 비워진 레이어 → 파일 삭제
  "layerOpacity": { "reference": 0.5 },
  "composite": "data:image/jpeg;base64,…",             // 합성본 → -posterframe.jpg (JPEG 필수)
  "thumbnail": "data:image/png;base64,…",              // → -thumbnail.png (PNG 필수)
  "lineMileage": 123.4
}
```

레이어 이름: `reference | fill | tone | pencil | ink | notes`. 요청 크기 한도 80MB, 이미지 하나 25MB.

## 대본 → 보드

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/script/parse` | `{ text, granularity?: "element"\|"scene"\|"sentence", defaultBoardTiming? }` | `{ meta, summary, boardCount, boards(최대 200개 미리보기) }` — 저장하지 않음 |
| POST | `/api/projects/:id/script` | `{ text, granularity?, afterUid?, replaceEmptyFirstBoard?: true }` | `201 { project, created: [uid…], summary, meta }` |

## 영상 분석 결과 → 보드

분석 JSON · PySceneDetect CSV · SRT · WebVTT 를 보드로 변환합니다. 형식과 필드 규칙은 [ANALYSIS_IMPORT.md](ANALYSIS_IMPORT.md).

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/import/analysis/preview` | `{ text }`(문자열, 형식 자동 감지) 또는 `{ data }`(JSON 객체), `defaultBoardTiming?` | `{ summary, warnings, boards(최대 200개 미리보기) }` — 저장하지 않음, 프로젝트 불필요 |
| POST | `/api/projects/:id/import/analysis` | `{ text \| data, afterUid?, replaceEmptyFirstBoard?: true, addToWhiteboard?: false }` | `201 { project, created: [uid…], summary, warnings, whiteboard: { frame, cards } \| null }` |

- `summary`: `{ format, videoId, title, fps, shots, transcriptSegments, boards, withDialogue, withShotType, withCameraMove, withThumbnail, totalMs, sourceUrl, sourcePath, truncated }` (한 번에 최대 500 보드).
- 알 수 없는 형식 · 보드가 하나도 안 나오는 입력은 `400`.
- `addToWhiteboard: true` 면 만들어진 보드들을 화이트보드의 새 프레임 안에 카드로 깔고, `source.url` 이 있으면 임베드/링크 카드를 하나 더 둡니다.
- 프로젝트 `ext.imports[]` 에 `{ at, kind: "analysis", format, videoId, boards, sourceUrl, sourcePath }` 가 기록되고, 각 보드의 `ext.source` 에 샷 출처가 남습니다.

## 영상 → 장면별 스토리보드 (v0.3)

장면 감지·프레임 캡처·스케치는 브라우저가 합니다(`public/js/sceneDetect.js`, `sketch.js`). 서버는 (1) 영상 파일을 가져와 same-origin 으로 서빙하고, (2) 비전 모델 호출을 중계하고, (3) 장면 목록을 보드로 바꿉니다. 설계는 [VIDEO_TO_STORYBOARD.md](VIDEO_TO_STORYBOARD.md).

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/video/capabilities` | | `{ ytdlp: { available, version }, ffmpeg: { available }, maxMb, vision: { configured, model, visionModel, … } }` |
| POST | `/api/projects/:id/video/fetch` | `{ url, quality?: "480"\|"720"\|"1080" }` | `202 { job }` — 비동기. `job = { id, status: running\|done\|error, stage, progress, message, kind: youtube\|vimeo\|direct\|page, info, result, error }` |
| GET | `/api/video/jobs/:id` | | `{ job }` — `done` 이면 `result = { url: "/cache/video/<job>/<file>", name, mime, size, info: { id, title, uploader, duration, fps, width, height, chapters[], … }, transcript: [{ start, end, text, speaker }], subtitlesLang, subtitlesAuto }` |
| DELETE | `/api/video/jobs/:id` | | `{ ok }` — 캐시 파일 삭제 (6시간 뒤 자동 삭제) |
| POST | `/api/ai/describe-scenes` | `{ scenes: [{ index, time, duration, image(data URL, ≤ ~650 KB), transcript?, hints? }] (≤ 10개), title?, style?, context? }` | `{ scenes: [{ index, action, description, shotType, cameraMove, mood, tags, figures[], shapes[], horizon } \| { index, missing: true }], model, usage }` — 비전 모델 미설정 시 `503` |
| POST | `/api/projects/:id/import/scenes` | `{ scenes: [{ index, start, end, action, description?, dialogue?, notes?, shotType?, cameraMove?, mood?, tags?, descriptionBy?: ai\|heuristic\|manual, transcript?: [{ speaker, text }], metrics?, cutScore?, frame?: { start, end } }], source: { kind, url?, videoId?, title?, uploader?, fps?, width?, height?, duration?, fileName?, asset? }, afterUid?, replaceEmptyFirstBoard?, addToWhiteboard?, keepVideo?, cacheJob?, mode? }` | `201 { project, created: [uid…], summary, asset \| null, whiteboard: { frame, cards } \| null }` |

- `video/fetch`: `http(s)` 만, 사설 IP/`localhost` 거부(`VIDEO_FETCH_ALLOW_PRIVATE=1` 로 해제 — 테스트용). 직접 파일 URL 은 스트리밍 다운로드(`VIDEO_MAX_MB`, 기본 1024 MB, 초과 시 작업 오류). YouTube/Vimeo/페이지 URL 은 **yt-dlp** 필요(`YTDLP_PATH` 또는 PATH; 없으면 `501`). 자막은 수동 > 자동 순으로 `ko,en` 등을 골라 `transcript` 로 변환. ffmpeg(`FFMPEG_PATH`) 이 있으면 화질 선택 시 영상+오디오 병합, 없으면 단일 파일 포맷.
- 캐시 위치 `VIDEO_CACHE_DIR`(기본 OS 임시 폴더 `storyboarder-next-video/`), `/cache/video/<job>/<file>` 로 Range 요청 지원 서빙.
- `import/scenes`: 장면은 시작 시간 순으로 정렬되고 최대 500개. 보드 길이 = 장면 길이. `keepVideo` + `cacheJob` 이면 캐시 파일을 프로젝트 `assets/` 로 복사하고(파일이 이미 사라졌으면 `410`), `keepVideo` + `source.asset`(클라이언트가 원시 업로드한 로컬 파일) 이면 그 에셋을 씁니다. 두 경우 모두 모든 보드의 `ext.source.asset` 이 채워지고, `addToWhiteboard` 면 프레임 위에 **영상 노드**(에셋) 또는 **임베드 노드**(YouTube 링크)가 놓입니다.
- 프로젝트 `ext.imports[]` 에 `{ at, kind: "video-scenes", source, videoId, boards, sourceUrl, file, asset, mode, withAi }` 기록. 보드 `ext.source` 는 `{ kind: "video-scene", videoId, sceneId, startTime, endTime, startFrame, endFrame, fps, url, file, asset, descriptionBy, cutScore, metrics }`.
- 보드 이미지는 생성 뒤 클라이언트가 `POST /boards/:uid/image` 로 레이어별로 올립니다(`reference` = 캡처, `fill` = 윤곽 스케치, `pencil` = 졸라맨/카메라 표시; `layerOpacity.reference = 0.35` 는 "둘 다" 모드).

## 화이트보드

프로젝트당 하나, `project.ext.whiteboard` 에 저장됩니다(구조는 [FILE_FORMAT.md](FILE_FORMAT.md#extwhiteboard--레퍼런스-화이트보드)). 서버는 항상 정규화해서 돌려줍니다 — 모르는 타입의 노드, 끝점이 없는 연결선, 없는 보드를 가리키는 보드 카드는 버립니다.

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/projects/:id/whiteboard` | | `{ whiteboard: { version, viewport, nodes, edges } }` |
| PUT | `/api/projects/:id/whiteboard` | `{ whiteboard: {…} }` 또는 화이트보드 객체 그대로 (`nodes[]` 필수) | `{ whiteboard }` 정규화된 결과. 저장 후 아무 노드도 참조하지 않는 10분 이상 된 에셋 파일을 정리합니다 |
| POST | `/api/projects/:id/whiteboard/boards` | `{ uids?: [uid…](기본: 전체), title?, cols?(1–12), origin?: {x, y} }` | `201 { whiteboard, frame, cards }` — 보드들을 새 프레임 안에 격자로 카드 추가 |

## 에셋 (화이트보드 업로드 파일)

`projects/<id>/assets/` 에 `<sha1 앞 10자리>-<안전한 파일명>` 으로 저장되고(같은 내용은 한 번만), `/projects/<id>/assets/<name>` 으로 서빙됩니다.

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/projects/:id/assets` | | `{ assets: [{ name, url, size, mime, mtime }] }` |
| POST | `/api/projects/:id/assets` | JSON `{ name, mime?, dataUrl }` **또는** 원시 바이트(`Content-Type: image/*`, `video/*`, `audio/*`, `application/pdf`, `application/octet-stream`) + `?name=&mime=` | `201 { asset: { name, url, size, mime } }` |
| POST | `/api/projects/:id/assets/from-url` | `{ url }` — 원격 이미지/영상을 내려받아 에셋으로 (서버가 다운로드) | `201 { asset: {…, sourceUrl} }` |
| DELETE | `/api/projects/:id/assets/:name` | | `{ ok: true }` |

- 허용 확장자: `png jpg jpeg gif webp avif svg bmp mp4 webm mov m4v mp3 wav m4a ogg pdf json txt md csv`. 그 외는 `415`.
- 파일 하나 최대 **60 MB**(`413`), 영상(`video/*`)은 `VIDEO_MAX_MB`(기본 1024 MB)까지 — 원시 바이트 업로드는 디스크로 스트리밍되므로 큰 영상도 메모리를 쓰지 않습니다. JSON 요청 본문 한도는 80 MB.
- `from-url` 은 http(s) 만, 사설 IP/`localhost` 거부(SSRF 방지), 20초 타임아웃, 응답 `Content-Type` 이 `image/*`·`video/*` 가 아니면 `415`, 다운로드 실패는 `502`.
- 에셋은 화이트보드 노드 **또는 보드**(`ext.source.asset`, 링크, `ext.imports[].asset`)가 참조하는 동안 유지되고, 참조가 사라지면 다음 화이트보드 저장 때(10분 유예) 지워집니다.

## 레퍼런스 링크 미리보기

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/link-preview?url=…` | YouTube / Vimeo / 일반 페이지의 `{ url, provider, id, title, author, thumbnail, embedUrl, startSeconds, siteName, description }` |
| POST | `/api/link-preview` | `{ url }` 동일 |

- 사설 IP/`localhost` 로 향하는 URL 은 거부합니다(SSRF 방지).
- `LINK_PREVIEW_OFFLINE=1` 이면 네트워크 없이 URL 규칙으로 알 수 있는 값만 채웁니다.
- 링크를 보드에 붙이는 것은 클라이언트가 `board.ext.links` 에 넣고 `PUT` 하는 것으로 끝납니다.

## AI

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| GET | `/api/ai/status` | | `{ text: {configured, model, baseUrl}, video: {configured, endpoint, baseUrl, provider}, publicBaseUrl }` |
| POST | `/api/ai/prompt` | `{ projectId, uid }` 또는 `{ board, project }`, `style?` | `{ imagePrompt, videoPrompt, negativePrompt, params: {durationSeconds, aspectRatio…}, payloads: {higgsfield} }` — 오프라인, 토큰 0 |
| POST | `/api/ai/enhance` | `{ projectId, uid, instructions? }` | `{ imagePrompt, videoPrompt, negativePrompt, model }` — 미설정 시 `503` |
| POST | `/api/ai/video` | `{ projectId, uid, endpoint?, imageUrl?, prompt?, extra? }` | `202 { job, raw, board }` — 보드 `ext.aiJobs` 에 기록, 상태 `generating`. `imageUrl` 이 없고 `PUBLIC_BASE_URL` 도 없으면 `400` |
| POST | `/api/ai/video/poll` | `{ projectId, uid, jobId }` | `{ job, raw, board }` — 완료되면 `job.videoUrl`, 상태 `generated` |

## 내보내기

`GET /api/projects/:id/export/:format`

| format | Content-Type | 내용 |
|---|---|---|
| `csv` | text/csv (BOM) | 샷 리스트 |
| `markdown` / `md` | text/markdown | 프롬프트 팩 |
| `prompts` / `prompts.json` | application/json | 프롬프트 팩 JSON |
| `json` / `storyboarder` | application/json | `.storyboarder` 파일 그대로 |
| `zip` | application/zip | `<id>/` 폴더 번들 (JSON + images + csv + md + json + `whiteboard.md` + 화이트보드가 참조하는 `assets/`) |

모두 `Content-Disposition: attachment` 로 내려옵니다. 인쇄 시트는 API 가 아니라 페이지입니다: `/print.html?project=<id>`.

## 정적 파일

- `/` 앱, `/print.html` 인쇄 시트
- `/projects/<id>/images/<file>` 보드 이미지 (`?v=<lastEdited>` 로 캐시 무효화)
- `/projects/<id>/assets/<file>` 화이트보드 에셋
- `/cache/video/<job>/<file>` 서버가 가져온 영상(임시, Range 지원 — 브라우저 장면 분석용)
- `/docs/<file>.md` 이 문서들 (앱의 도움말 링크가 가리킴, `text/markdown`)

## 예: curl 로 처음부터 끝까지

```bash
# 1) 프로젝트
curl -s -X POST localhost:3000/api/projects -H 'content-type: application/json' \
  -d '{"name":"데모","aspectRatio":1.7778,"style":"anime, flat colors"}'

# 2) 대본 → 보드
curl -s -X POST localhost:3000/api/projects/데모/script -H 'content-type: application/json' \
  -d '{"text":"S#1. 교실 - 아침\n\n수진이 창가에 앉아 있다.\n\n수진: 오늘도 늦었네.","replaceEmptyFirstBoard":true}'

# 3) 프롬프트
UID=$(curl -s localhost:3000/api/projects/데모 | node -pe 'JSON.parse(require("fs").readFileSync(0)).project.boards[0].uid')
curl -s -X POST localhost:3000/api/ai/prompt -H 'content-type: application/json' -d "{\"projectId\":\"데모\",\"uid\":\"$UID\"}"

# 4) 영상 분석 결과(JSON) → 보드 + 화이트보드 카드
curl -s -X POST localhost:3000/api/projects/데모/import/analysis -H 'content-type: application/json' \
  -d '{"data":{"video_id":"ref1","source":{"url":"https://youtu.be/aqz-KE-bpKQ"},"fps":24,"shots":[{"shot_id":"SH001","start_frame":0,"end_frame":96,"description":"도시 스카이라인","camera":{"shot_type":"wide"}}]},"addToWhiteboard":true}'

# 5) 화이트보드에 메모 하나 추가 (읽고 → 고치고 → 저장)
curl -s localhost:3000/api/projects/데모/whiteboard > wb.json
node -e 'const w=JSON.parse(require("fs").readFileSync("wb.json")).whiteboard;w.nodes.push({type:"note",x:0,y:-400,text:"톤: 따뜻한 아침 햇살"});console.log(JSON.stringify({whiteboard:w}))' \
  | curl -s -X PUT localhost:3000/api/projects/데모/whiteboard -H 'content-type: application/json' -d @-

# 6) 내보내기
curl -sO -J localhost:3000/api/projects/데모/export/zip
```
