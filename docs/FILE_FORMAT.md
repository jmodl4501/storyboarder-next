# 파일 포맷

프로젝트 하나 = 폴더 하나. 원작 Storyboarder 와 같은 배치이며, 원작(1.6 이상)의 "레이어 포맷" 규칙을 그대로 따르므로 폴더를 서로 복사해 열 수 있습니다.

```
projects/
└── sample-rooftop/
    ├── sample-rooftop.storyboarder        ← JSON (아래)
    ├── images/
    │   ├── board-2-XAJM8-pencil.png       ← 레이어별 PNG (있는 레이어만)
    │   ├── board-2-XAJM8-ink.png
    │   ├── board-2-XAJM8-tone.png
    │   ├── board-2-XAJM8-notes.png
    │   ├── board-2-XAJM8-thumbnail.png    ← 타임라인 썸네일 (320px 너비)
    │   └── board-2-XAJM8-posterframe.jpg  ← 합성본(notes 제외, 흰 배경). AI 입력·내보내기용
    └── assets/                            ← (v0.2, 선택) 화이트보드에 올린 파일. 없으면 폴더도 없음
        └── 3f9a1c2b7d-moodboard-01.jpg    ← <sha1 앞 10자리>-<안전한 파일명>
```

규칙

- `board.url` (`board-2-XAJM8.png`) 은 **이름의 기준일 뿐 실제 파일은 존재하지 않습니다.** 원작 1.6+ 는 이 파일이 있으면 "1.x 구형 프로젝트"로 보고 fill 레이어로 옮기는 마이그레이션을 실행하기 때문에, 우리도 절대 그 이름으로 쓰지 않습니다.
- 숫자(`2`)는 보드가 **처음 만들어질 때의 순번**이고 이후 순서를 바꿔도 바뀌지 않습니다(원작과 동일). 보드의 정체성은 `uid` 입니다.
- 레이어 PNG 는 저장 시 서버가 **무손실 재압축**합니다(`server/lib/png.js`, 보통 브라우저 출력 대비 40~60% 축소). 끄려면 `PNG_OPTIMIZE=0`.
- 썸네일은 notes 레이어를 포함하고, posterframe 은 제외합니다(연출 메모가 AI 에 들어가지 않도록).
- 이미지 크기: 화면비 ≥ 1 이면 `[900 × 화면비, 900]`, 아니면 `[900, 900 / 화면비]` → 16:9 는 1600×900 (원작과 동일).

## `.storyboarder` JSON

```jsonc
{
  "version": "0.2.0",               // 파일을 처음 만든 앱 버전 (이후 저장해도 유지)
  "aspectRatio": 1.7777777777777777,
  "fps": 24,
  "defaultBoardTiming": 2000,       // ms. duration 이 없는 보드의 길이
  "boards": [ /* 아래 */ ],
  "ext": {                          // ★ 우리가 추가한 프로젝트 확장 (원작은 무시함)
    "title": "샘플 — 옥상 (Rooftop)",
    "style": "cinematic, natural light, 35mm film look, muted colors",
    "generator": "storyboarder-next",
    "created": 1795360209012,
    "updated": 1795360347805,
    "aiTarget": "higgsfield",
    "whiteboard": { /* v0.2 — 레퍼런스 화이트보드, 아래 */ },
    "imports": [                    // v0.2 — 가져오기 이력 (영상 분석 결과)
      { "at": "2026-11-22T07:10:00.000Z", "kind": "analysis", "format": "json", "videoId": "brand_film_v3",
        "boards": 5, "sourceUrl": "https://www.youtube.com/watch?v=…", "sourcePath": "" }
    ]
  }
}
```

### 보드

```jsonc
{
  // ---- 원작과 공통 ----
  "uid": "XAJM8",                   // 5자리 base36 대문자
  "url": "board-2-XAJM8.png",       // 파일 이름 기준 (파일 없음)
  "newShot": true,                  // 새 샷 시작 여부 → shot 번호 계산에 사용
  "lastEdited": 1795360240179,
  "layers": {                       // 있는 레이어만. 키: reference | fill | tone | pencil | ink | notes
    "pencil": { "url": "board-2-XAJM8-pencil.png" },
    "ink":    { "url": "board-2-XAJM8-ink.png" },
    "tone":   { "url": "board-2-XAJM8-tone.png", "opacity": 1 },
    "notes":  { "url": "board-2-XAJM8-notes.png" }
  },
  "number": 1,                      // 현재 순서 (1부터) — 저장 때마다 다시 계산
  "shot": "1A",                     // 샷 번호 — 저장 때마다 다시 계산
  "time": 0,                        // 누적 시작 시각 ms — 다시 계산
  "duration": 2000,                 // 선택. 없으면 defaultBoardTiming
  "dialogue": "",
  "action": "S#1. 옥상 - 해질녘",
  "notes": "마스터 샷. 노을 색온도 참고 링크 확인.",
  "lineMileage": 11663.5,           // 그린 선의 총 길이(px)

  // ---- ★ 확장 ----
  "ext": {
    "shotType": "EWS",              // EWS WS FS MS MCU CU ECU OTS POV TWO INSERT LOW HIGH BIRD DUTCH | ""
    "cameraMove": "static",         // static pan-left … whip-pan | ""
    "links": [
      {
        "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30s",
        "provider": "youtube",      // youtube | vimeo | web
        "id": "aqz-KE-bpKQ",
        "title": "Big Buck Bunny …",
        "author": "Blender",
        "siteName": "YouTube",
        "thumbnail": "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg",
        "embedUrl": "https://www.youtube.com/embed/aqz-KE-bpKQ?start=30",
        "startSeconds": 30,
        "note": "노을 그라데이션 / 색온도 레퍼런스",
        "fetchedAt": 1795360347430
      }
    ],
    "prompt": "Establishing extreme wide shot of 옥상, 해질녘. …",     // image prompt
    "videoPrompt": "Static locked-off camera. …",
    "negativePrompt": "text, watermark, …",
    "status": "ready",              // draft | ready | generating | generated | approved
    "tags": [],
    "source": {                     // v0.2 — 영상 분석 결과에서 가져온 보드의 출처 (ANALYSIS_IMPORT.md)
      "videoId": "brand_film_v3", "shotId": "SH002",
      "startFrame": 96, "endFrame": 240, "startTime": 4, "endTime": 10, "fps": 24,
      "file": "", "url": "https://www.youtube.com/watch?v=…", "thumbnail": ""
    },
    "aiJobs": [                     // 영상 생성 요청 이력 (파일은 저장하지 않음)
      {
        "id": "req_…", "provider": "higgsfield", "endpoint": "kling-video/v3.0/std/image-to-video",
        "status": "completed", "statusUrl": "https://api.higgsfield.ai/requests/…/status",
        "prompt": "…", "imageUrl": "https://…/board-2-XAJM8-posterframe.jpg?v=…",
        "videoUrl": "https://…mp4", "createdAt": 1795360400000, "updatedAt": 1795360460000
      }
    ]
  }
}
```

### 샷 번호 규칙 (원작과 동일)

- 첫 보드는 항상 새 샷. `newShot` 인 보드마다 숫자가 1 증가, 같은 샷 안에서는 `A, B, C …` (26개를 넘으면 `A2, B2 …`).
- `number`, `shot`, `time` 은 **저장할 때 서버가 항상 다시 계산**하므로 직접 편집해도 덮어써집니다. 바꾸고 싶으면 `newShot`, `duration`, 보드 순서를 바꾸세요.

### 서버가 보존하는 필드

클라이언트가 `PUT /api/projects/:id` 로 프로젝트 전체를 보내도 `url`, `layers`, `lastEdited`, (비어 있지 않은) `ext.aiJobs`, 그리고 `aspectRatio` 는 서버에 있는 값을 유지합니다 — 이미지 저장과 텍스트 저장이 경쟁해도 그림이 사라지지 않고, 화면비는 이미지 크기를 결정하므로 생성 후 바꿀 수 없습니다. `_` 로 시작하는 키(`_legacyMain` 등 런타임 플래그)는 파일에 기록되지 않습니다.

## `ext.whiteboard` — 레퍼런스 화이트보드

프로젝트당 하나의 무한 캔버스. 원작은 `ext` 를 무시하므로 호환에 영향이 없습니다. 서버의 `server/lib/whiteboard.js` 가 읽고 쓸 때마다 정규화합니다(모르는 타입·좌표 범위 밖·끝점 없는 연결선 제거, 노드 ≤ 5000, 연결선 ≤ 5000, 텍스트 ≤ 20000자).

```jsonc
{
  "version": 1,
  "viewport": { "x": -120, "y": 80, "zoom": 0.5 },   // 마지막 카메라 위치 (클라이언트 편의용)
  "nodes": [
    // 공통: id(영숫자 ≤32) · type · x y w h (월드 좌표, px) · z(쌓임 순서) · createdAt · locked? · note? · tags?[]
    { "id": "n3k9x2a", "type": "frame", "x": 0, "y": 0, "w": 1200, "h": 800, "z": 0, "title": "레퍼런스 — 옥상", "color": "#7C9CFF" },
    { "id": "n8b1p0q", "type": "image", "x": 40, "y": 60, "w": 320, "h": 200, "z": 2,
      "src": "/projects/sample-rooftop/assets/3f9a1c2b7d-moodboard-01.jpg",   // 업로드 에셋 또는 외부 URL
      "alt": "moodboard-01.jpg", "natural": [1920, 1200], "sourceUrl": "https://…(원격에서 가져온 경우)" },
    { "id": "nq2w7e1", "type": "video", "src": "/projects/…/assets/…mp4", "name": "ref.mp4", "poster": "", "x": 400, "y": 60, "w": 400, "h": 260, "z": 3 },
    { "id": "n7f4d2s", "type": "embed", "provider": "youtube", "url": "https://www.youtube.com/watch?v=…", "embedUrl": "https://www.youtube.com/embed/…",
      "title": "…", "author": "…", "thumbnail": "https://i.ytimg.com/…", "startSeconds": 30, "videoId": "…", "x": 40, "y": 320, "w": 400, "h": 260, "z": 4 },
    { "id": "n1a2b3c", "type": "link", "url": "https://…", "title": "…", "description": "…", "thumbnail": "…", "siteName": "…", "x": 480, "y": 340, "w": 300, "h": 120, "z": 5 },
    { "id": "n5t6y7u", "type": "note", "text": "톤: 따뜻한 아침 햇살", "color": "#FFE08A", "x": 820, "y": 60, "w": 220, "h": 160, "z": 6 },
    { "id": "n9i8o7p", "type": "text", "text": "1막", "size": 32, "color": "#222222", "x": 40, "y": -60, "w": 280, "h": 48, "z": 1 },
    { "id": "nz1x2c3", "type": "board", "uid": "XAJM8", "x": 820, "y": 300, "w": 220, "h": 164, "z": 7 },   // 보드 카드 (썸네일·샷 번호는 보드에서 읽음)
    { "id": "nv4b5n6", "type": "file", "src": "/projects/…/assets/…pdf", "name": "treatment.pdf", "mime": "application/pdf", "size": 102400, "x": 40, "y": 620, "w": 240, "h": 72, "z": 8 }
  ],
  "edges": [
    { "id": "e2k3j4h", "from": "n8b1p0q", "to": "nz1x2c3", "label": "구도 참고", "color": "#7C9CFF", "style": "dashed" }   // style: 기본(화살표) | "line"(화살표 없음) | "dashed"
  ]
}
```

- 노드 타입: `image · video · embed · link · note · text · frame · board · file`. 프레임은 영역일 뿐이며 자식 관계는 저장하지 않습니다(안에 들어 있는 노드를 함께 움직이는 것은 클라이언트가 기하학적으로 판단).
- `board` 카드는 `uid` 가 가리키는 보드가 삭제되면 저장 시 함께 제거됩니다.
- `ext.whiteboard` 는 `PUT /api/projects/:id` 로는 바뀌지 않고 `PUT /api/projects/:id/whiteboard` 로만 저장됩니다 — 보드 편집과 화이트보드 편집이 서로 덮어쓰지 않도록.
- **에셋 파일**(`assets/`)은 어떤 노드도 참조하지 않게 된 뒤 10분이 지나면 다음 화이트보드 저장 때 삭제됩니다. ZIP 내보내기에는 참조 중인 에셋만 들어갑니다.

## 원작 Storyboarder 와의 호환

| 방향 | 동작 |
|---|---|
| 원작 → 여기 (1.6+ 레이어 포맷) | 폴더를 `projects/` 에 복사. 레이어 PNG 그대로 편집. 원작의 `-posterframe.jpg`/`-thumbnail.png` 도 그대로 사용 |
| 원작 → 여기 (1.x, `board.url` 파일에 그림이 있는 구형) | 읽기 시 `_legacyMain` 플래그. 그 보드를 처음 그리는 순간 원작과 같은 방식으로 **fill 레이어로 이전**하고 구 파일을 삭제 |
| 여기 → 원작 | `내보내기 → .storyboarder 파일` 또는 폴더 그대로. 원작은 `ext` 를 무시하고 레이어·샷·대사를 읽습니다. (원작은 reference/fill/tone/pencil/ink/notes 중 자기가 아는 레이어만 그립니다) |
| 원작에 없는 것 | `ext` 전체, `-posterframe.jpg` 를 AI 입력으로 쓰는 것, 레이어 PNG 재압축(표준 PNG 이므로 문제 없음) |

원작의 `audio`, `link`(PSD), `sg`(Shot Generator) 필드는 그대로 보존되어 저장되지만 이 앱에서는 사용하지 않습니다.

## 내보내기 파일

| 포맷 | 내용 |
|---|---|
| `shotlist.csv` | UTF-8 BOM. 열: number, shot, newShot, timecode, startMs, durationMs, durationSec, shotType, shotTypeKo, cameraMove, cameraMoveKo, action, dialogue, notes, status, tags, links, imagePrompt, videoPrompt, negativePrompt, image, videoUrl |
| `prompts.md` | 프로젝트 요약 + 보드별 이미지(`images/…posterframe.jpg`)·표·레퍼런스·프롬프트 |
| `prompts.json` | `{ project: {…}, boards: [{ uid, shot, timecode, durationMs, image, imageUrl, shotType, cameraMove, action, dialogue, notes, links, imagePrompt, videoPrompt, negativePrompt, payloads: { higgsfield: {…} } }] }` |
| `whiteboard.md` | (ZIP 안에만) 화이트보드를 읽을 수 있는 문서로: 프레임별 노드 목록 — 메모 본문, 링크 URL, 임베드(시작 시간), 이미지/파일 경로, 보드 카드(샷 번호·액션), 연결선. 화이트보드가 비어 있으면 생략 |
| `<id>-storyboard.zip` | `<id>/<id>.storyboarder` + `images/` + 위 파일들 + `whiteboard.md` + 화이트보드가 참조하는 `assets/` |
