# AI Video Intelligence & Editing System — 설계 노트

> 이 문서는 프로젝트 소유자가 이전에 LLM 과 나눈 "텍스트 기반 영상 편집 파이프라인" 논의를
> Storyboarder Next 저장소 안에 정리해 둔 것입니다. 영상을 **먼저 분석(샷·자막·객체)해 구조화된
> 데이터로 만들고, 그 데이터를 검색·편집·콘티로 되돌려 쓰는** 흐름의 기준 문서이며,
> [`docs/ANALYSIS_IMPORT.md`](ANALYSIS_IMPORT.md) 의 가져오기 형식은 이 데이터 모델을 그대로 따릅니다.

---

## 0. 한 줄 요약

```
영상 파일 ─▶ ① 분석기 (샷 경계 · 음성 → 텍스트 · 화면 설명 · OCR)
          ─▶ ② 구조화 DB (shots / transcript / objects / events + 벡터)
          ─▶ ③ 검색 · LLM 편집 에이전트 ("이 인터뷰에서 제품 얘기하는 부분만 30초로")
          ─▶ ④ 타임라인(OTIO/EDL/XML) ─▶ NLE (Premiere / Resolve / FFmpeg 렌더)
                     └─▶ Storyboarder Next 로 가져오기 → 콘티 보드 · 레퍼런스 화이트보드
```

"영상을 텍스트처럼 다룬다"가 핵심입니다. 컷 하나하나가 **시간 범위 + 설명 + 대사 + 태그**를 가진
레코드가 되면, 검색·요약·재배열·프롬프트 생성이 모두 텍스트 작업이 됩니다.

---

## 1. 데이터 모델

모든 시간은 **초(float)** 또는 **프레임(int, fps 와 함께)** 으로 표현하고, 구간은 `[start, end)` 반열림 구간입니다
(`end_frame` 은 포함하지 않음 → 인접 샷은 `end_frame == 다음 start_frame`).

### 1.1 Shot (컷 / 샷)

```json
{
  "shot_id": "SH014",
  "source_id": "interview_cam_a",
  "start_frame": 3120,
  "end_frame": 3408,
  "start_time": 130.0,
  "end_time": 142.0,
  "fps": 24,
  "duration_frames": 288,
  "description": "창가에 앉은 인터뷰이가 제품 상자를 들어 보인다",
  "visual_description": "역광, 따뜻한 톤, 얕은 심도. 인물 우측에 노트북.",
  "objects": ["사람", "제품 상자", "노트북"],
  "actions": ["상자를 든다", "카메라를 본다"],
  "camera": { "shot_type": "medium_close_up", "movement": "static" },
  "mood": "차분함",
  "tags": ["인터뷰", "제품", "B롤 후보"],
  "transcript_ids": ["ASR_031", "ASR_032"],
  "audio_events": ["키보드 소리"],
  "thumbnail": "thumbs/SH014.jpg"
}
```

### 1.2 Transcript segment (자막 / 발화)

```json
{
  "segment_id": "ASR_031",
  "source_id": "interview_cam_a",
  "start_time": 130.4,
  "end_time": 135.9,
  "speaker": "SPEAKER_01",
  "text": "처음엔 이게 될 거라고 아무도 믿지 않았어요.",
  "words": [{ "word": "처음엔", "start": 130.4, "end": 130.9 }]
}
```

### 1.3 Timeline (편집 결과)

```json
{
  "project": "launch_film_v2",
  "timeline": [
    { "clip_id": "C001", "source": "interview_cam_a", "in_frame": 3120, "out_frame": 3408, "timeline_position": 0 },
    { "clip_id": "C002", "source": "broll_city", "in_frame": 240, "out_frame": 336, "timeline_position": 288 }
  ]
}
```

### 1.4 묶음 (분석 결과 파일 하나)

```json
{
  "video_id": "interview_cam_a",
  "title": "창업자 인터뷰 A캠",
  "source": { "url": "https://youtu.be/…", "path": "D:/footage/interview_a.mp4", "hash": "sha1…" },
  "metadata": { "fps": 24, "width": 3840, "height": 2160, "duration": 1420.5 },
  "shots": [ … ],
  "transcript": [ … ]
}
```

이 파일이 **Storyboarder Next 의 "영상 분석 결과 → 보드" 가져오기 입력**입니다.

---

## 2. 기술 스택 (오픈소스 위주)

| 단계 | 도구 | 역할 | 비고 |
| --- | --- | --- | --- |
| 메타데이터 | **FFprobe** | fps · 해상도 · 길이 · 스트림 | FFmpeg 에 포함 |
| 샷 경계 | **PySceneDetect** | 컷 감지 (`detect-content`, `detect-adaptive`) | CSV 를 그대로 가져오기 가능 |
| 샷 경계 (고급) | **TransNetV2** | 딥러닝 기반 전환 감지 (디졸브 등) | GPU 권장 |
| 음성 → 텍스트 | **faster-whisper** | 빠른 Whisper 추론, 단어 타임스탬프 | SRT/VTT 출력 → 가져오기 가능 |
| 정렬 / 화자 | **WhisperX**, **pyannote** | 단어 단위 정렬, 화자 분리 | `speaker` 필드 채움 |
| 화면 설명 | **Florence-2**, **Qwen2.5-VL** | 키프레임 캡션 · 객체 · 행동 | `visual_description`, `objects`, `actions` |
| 화면 글자 | **PaddleOCR** | 자막·간판·슬라이드 텍스트 | 검색 품질 ↑ |
| 저장 | **SQLite** + 벡터 확장(sqlite-vec / Chroma) | 구조 데이터 + 임베딩 | 단일 파일로 휴대 |
| 교환 포맷 | **OpenTimelineIO** | 타임라인 ↔ NLE | EDL/FCPXML/AAF 어댑터 |
| 렌더 | **FFmpeg** | 컷 편집 · 프록시 · 썸네일 | 모든 OS |

참고 프로젝트 (설계 참고용, 번들하지 않음):

- PySceneDetect — https://github.com/Breakthrough/PySceneDetect
- Scene Scribe — https://github.com/seki2020/scene-scribe (샷 단위 설명 생성)
- ClipAtlas — https://github.com/xinsen854/ClipAtlas (클립 검색/아틀라스)
- MakeMyClip — https://github.com/MakeMyClip/editor (텍스트 기반 편집 UI)
- Open Script Editor — https://github.com/rbrown101010/Open-Script-Editor (대본 편집 ↔ 영상)
- FableCut — https://github.com/jcpsimmons/fablecut (LLM 편집 에이전트)

---

## 3. 단계별 로드맵

### Phase 1 — 분석기 (Analyzer)
1. FFprobe 로 메타데이터 → `metadata`
2. PySceneDetect 로 샷 경계 → `shots[].start/end`
3. faster-whisper(+WhisperX) 로 자막 → `transcript[]`, 샷과 시간 겹침으로 `transcript_ids` 연결
4. 샷마다 대표 프레임 1~3장 추출 → VLM 캡션 → `description / visual_description / objects / actions / camera / mood / tags`
5. 결과를 **JSON 하나**로 저장 (§1.4) — 여기까지가 Storyboarder Next 가 읽는 범위

### Phase 2 — 검색 (Search)
- 텍스트(대사·설명·태그) BM25 + 임베딩 하이브리드 검색
- "제품 상자가 보이는 미디엄 샷" 같은 자연어 질의 → 샷 목록
- 결과를 Storyboarder Next 화이트보드에 **보드 카드 / 링크**로 보내 레퍼런스 보드 구성

### Phase 3 — LLM 편집 에이전트
- 입력: 목표(길이·톤·메시지) + 검색된 샷 레코드
- 출력: §1.3 타임라인 JSON (+ 선택 이유)
- 안전장치: 샷 경계 밖 프레임 금지, 대사 중간 자르기 경고, 총 길이 제약

### Phase 4 — NLE 연계
- OpenTimelineIO 로 Premiere/Resolve 용 XML·EDL 내보내기
- FFmpeg 로 가편집 프록시 렌더 → 검토 → 수정 루프

---

## 4. Storyboarder Next 와의 연결 지점

| 파이프라인 산출물 | Storyboarder Next 에서 |
| --- | --- |
| 분석 JSON / PySceneDetect CSV / SRT·VTT | **가져오기 ▾ → 영상 분석 결과 → 보드** (샷 1개 = 보드 1개, 자막 = 대사, 샷 타입·카메라 매핑) |
| 원본 URL (YouTube 등) | 보드마다 해당 시간으로 가는 링크 + 화이트보드 임베드 카드 |
| 썸네일 경로 (`thumbnail`) | `board.ext.source.thumbnail` 에 보존 (이미지 자체는 가져오지 않음) |
| 샷 레코드 전체 | `board.ext.source` 에 출처(video_id, shot_id, 프레임·초, fps, 파일 경로) 보존 → 역추적 가능 |
| 타임라인 JSON | (예정) 타임라인 순서대로 보드 생성 — ROADMAP 참고 |
| (분석기가 없을 때) 영상 URL/파일 자체 | **가져오기 ▾ → 영상 → 장면별 스토리보드** — 브라우저에서 Phase 1 의 "샷 분할 + 대표 프레임" 을 가볍게 수행하고, 비전 모델이 있으면 VLM 설명까지. 앱 안에 들어 있는 최소 분석기이며 정밀 파이프라인의 대체가 아니라 입구입니다 → [VIDEO_TO_STORYBOARD.md](VIDEO_TO_STORYBOARD.md) |

반대 방향도 같습니다: Storyboarder Next 의 **샷 리스트 CSV / 프롬프트 팩 JSON** 은 편집 에이전트에
"의도된 컷 구성"을 알려주는 입력으로 쓸 수 있습니다 (`shotType`, `cameraMove`, `duration`, `action`, `dialogue`).

---

## 5. 최소 파이프라인 예시 (Windows, Python)

```powershell
# 1) 도구
pip install scenedetect[opencv] faster-whisper
winget install Gyan.FFmpeg          # ffprobe 포함

# 2) 샷 경계 → CSV (그대로 가져오기 가능)
scenedetect -i footage.mp4 detect-adaptive list-scenes -o out

# 3) 자막 → SRT (그대로 가져오기 가능)
python -c "from faster_whisper import WhisperModel; m=WhisperModel('small'); segs,_=m.transcribe('footage.mp4', word_timestamps=True); open('out/footage.srt','w',encoding='utf-8').write(''.join(f'{i+1}\n{int(s.start//3600):02}:{int(s.start%3600//60):02}:{s.start%60:06.3f} --> {int(s.end//3600):02}:{int(s.end%3600//60):02}:{s.end%60:06.3f}\n{s.text.strip()}\n\n'.replace('.',',',0) for i,s in enumerate(segs)))"
```

CSV 와 SRT 를 각각 가져오면 샷 보드와 대사 보드가 따로 생기므로, 둘을 합친 **JSON(§1.4)** 을 만드는 작은
스크립트를 두는 것이 가장 편합니다 — `shots` 는 CSV 행에서, `transcript` 는 SRT 에서 채우고, 시간 겹침으로
`transcript_ids` 를 연결하면 됩니다. (Storyboarder Next 는 `transcript_ids` 가 없어도 시간 겹침으로 자막을 붙여 줍니다.)
