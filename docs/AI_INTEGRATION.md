# AI 연동 가이드

AI 기능은 전부 **선택 사항**입니다. 아무 설정이 없어도 에디터, 프롬프트 생성(규칙 기반), 내보내기는 모두 동작합니다.
키는 `.env` 파일에만 두고(저장소에 커밋하지 않음, `.gitignore` 에 포함) 서버를 재시작하면 반영됩니다. 현재 상태는 `설정 → AI 연결 상태` 또는 `GET /api/ai/status` 에서 확인합니다.

```bash
cp .env.example .env   # 편집 후 npm start
```

## 0. 토큰을 아끼는 3단계

| 단계 | 비용 | 어디서 |
|---|---|---|
| ① 프롬프트 생성 | 0 (서버 내부 규칙) | 인스펙터 `프롬프트 생성` / `POST /api/ai/prompt` |
| ② 프롬프트 다듬기 | LLM 토큰 소량 (보드 1개당 1회 호출) | `AI로 다듬기` / `POST /api/ai/enhance` |
| ③ 영상 생성 | 영상 API 크레딧 | `영상 생성` / `POST /api/ai/video` |

①만으로도 쓸 만한 프롬프트가 나옵니다. 보드의 **샷 타입 · 카메라 무브 · 액션 · 대사 · 노트 · 프로젝트 비주얼 스타일 · 화면비 · 길이** 를 조합하며, 씬 헤딩(`S#1. 옥상 - 해질녘`) 보드는 장소/시간을 뽑아 "Establishing wide shot of 옥상, 해질녘 …" 형태로 만듭니다.
②, ③은 확정된 컷에서만 버튼을 누르는 방식이라 토큰이 새지 않습니다.

생성되는 세 가지:

- **Image prompt** — 키 프레임(첫 프레임) 이미지 생성용.
- **Video prompt** — image-to-video 용. "첫 프레임 = 이 보드 그림"을 전제로 카메라 움직임과 길이를 기술.
- **Negative** — 기본값 `text, watermark, logo, subtitles, extra fingers, …` (수정 가능).

## 1. 텍스트 AI (프롬프트 다듬기) — OpenAI 호환 API

`/v1/chat/completions` 를 제공하는 어떤 서버든 됩니다.

```ini
# OpenAI
AI_TEXT_BASE_URL=https://api.openai.com/v1
AI_TEXT_API_KEY=sk-...
AI_TEXT_MODEL=gpt-4o-mini

# OpenRouter (여러 모델)
AI_TEXT_BASE_URL=https://openrouter.ai/api/v1
AI_TEXT_API_KEY=sk-or-...
AI_TEXT_MODEL=anthropic/claude-3.5-haiku

# 로컬 (Ollama) — 키 없이 BASE_URL 만으로 켜집니다
AI_TEXT_BASE_URL=http://127.0.0.1:11434/v1
AI_TEXT_MODEL=qwen2.5:7b

# 로컬 (LM Studio)
AI_TEXT_BASE_URL=http://127.0.0.1:1234/v1
AI_TEXT_MODEL=local-model
```

- 요청은 보드 1개 단위이고 응답은 JSON(`imagePrompt`, `videoPrompt`, `negativePrompt`)으로 받아 인스펙터의 프롬프트 필드를 덮어씁니다(자동 저장). 이전 문구가 필요하면 미리 `복사` 해 두세요.
- `instructions` 로 추가 지시를 줄 수 있습니다(예: "더 짧게", "애니메이션 룩으로").
- 미설정이면 `AI로 다듬기` 버튼이 비활성화되고 API 는 `503` 을 돌려줍니다.

## 2. 영상 생성 — Higgsfield (image-to-video)

[Higgsfield](https://higgsfield.ai) 의 API 를 기본 프로바이더로 붙였습니다. 콘티 그림(합성 PNG)을 첫 프레임으로 주고 Video prompt 로 움직임을 지시하는 **image-to-video** 흐름입니다.

### 2.1 키 발급과 설정

1. https://console.higgsfield.ai 에서 API Key 를 만들면 `Key ID` 와 `Secret` 이 나옵니다.
2. `.env`:

```ini
HF_API_KEY_ID=...
HF_API_KEY_SECRET=...
# 모델 엔드포인트 (기본값). 문서의 다른 image-to-video 모델로 바꿀 수 있습니다.
HF_ENDPOINT=kling-video/v3.0/std/image-to-video
# 예) HF_ENDPOINT=wan/v2.7/image-to-video
```

인증 헤더는 서버가 `Authorization: Key <ID>:<SECRET>` 형태로 붙입니다. 전체 모델 목록과 파라미터는 https://docs.higgsfield.ai (LLM 용 색인: https://docs.higgsfield.ai/docs/llms.txt).

### 2.2 PUBLIC_BASE_URL — 왜 필요한가

Higgsfield 는 이미지를 업로드 받지 않고 **공개 HTTPS URL(`image_url`)** 에서 가져갑니다. 로컬 PC 의 `http://localhost:3000` 은 외부에서 접근할 수 없으므로 터널을 하나 띄우고 그 주소를 알려줘야 합니다.

```bash
# 방법 A: Cloudflare Tunnel (계정 불필요, 임시 URL)
#   설치: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:3000
#   → https://xxxx-xxxx.trycloudflare.com 이 출력됨

# 방법 B: ngrok  (https://ngrok.com/download)
ngrok http 3000

# 방법 C: 이미 공개 서버(VPS)에 배포했다면 그 도메인
```

```ini
PUBLIC_BASE_URL=https://xxxx-xxxx.trycloudflare.com
```

- 보드 이미지는 `PUBLIC_BASE_URL/projects/<id>/images/board-N-UID.png?v=<lastEdited>` 로 노출됩니다. 터널을 켜 두는 동안만 접근 가능하며 프로젝트 목록 등 다른 경로도 함께 노출되니 **생성할 때만 켜고 끄는** 것을 권합니다.
- 터널 대신 이미지를 직접 다른 곳(S3, Cloudflare R2, 이미지 호스팅)에 올렸다면 `POST /api/ai/video` 의 `imageUrl` 로 그 주소를 넘겨도 됩니다.
- 설정이 없으면 인스펙터에 "PUBLIC_BASE_URL 이 없어 image_url 을 만들 수 없습니다" 가 표시되고 요청은 `400` 으로 막힙니다.

### 2.3 흐름

```
[영상 생성] 클릭
  → 저장 flush → POST /api/ai/video {projectId, uid}
  → 서버: image_url + video prompt + duration(보드 길이, 3~15초 반올림) 조립
  → POST https://api.higgsfield.ai/<HF_ENDPOINT>   (Idempotency-Key 포함)
  → 응답 {request_id, status_url} 을 board.ext.aiJobs[] 에 저장, 상태 generating
[상태 확인] 클릭
  → POST /api/ai/video/poll {projectId, uid, jobId}
  → GET status_url → completed 면 video.url 을 job.videoUrl 에 저장, 상태 generated
  → 인스펙터에 "영상 열기 ↗"
```

- 요청 본문은 `prompt`, `image_url`, `duration` 이 기본이고 `extra` 로 모델별 옵션(`sound`, `cfg_scale`, `last_image_url`, `multi_shots`…)을 덧붙일 수 있습니다.
- 생성된 영상 파일은 **저장하지 않습니다.** URL 만 보드에 남습니다(저장소 크기 보호). 필요하면 받아서 `projects/<id>/renders/` 같은 폴더에 두고 `.gitignore` 에 추가하세요.
- 자동 폴링/웹훅은 아직 없습니다(→ ROADMAP). 상태 확인 버튼을 누르거나 아래 스크립트처럼 API 로 폴링하세요.

### 2.4 API 로 일괄 생성 (예시 스크립트)

```js
// scripts 예시: 상태가 ready 인 보드만 순서대로 생성 요청
const base = 'http://localhost:3000';
const id = 'sample-rooftop';
const { project } = await (await fetch(`${base}/api/projects/${id}`)).json();
for (const b of project.boards.filter((b) => b.ext.status === 'ready')) {
  const r = await fetch(`${base}/api/ai/video`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: id, uid: b.uid, extra: { sound: 'off' } }),
  });
  console.log(b.shot, r.status, (await r.json()).job?.id);
}
```

## 3. 다른 AI 툴과 함께 쓰기 (API 없이)

`내보내기 → 프롬프트 팩` 을 쓰면 어떤 툴이든 붙일 수 있습니다.

| 툴 | 방법 |
|---|---|
| Midjourney / DALL·E / Stable Diffusion / Flux | Image prompt 복사 → 키 프레임 생성 → 결과 이미지를 `이미지 ▾ → 레퍼런스 레이어로` 가져와 보드에 다시 붙임 |
| Kling / Runway / Pika / Luma / Veo (웹 UI) | 보드 합성 PNG(`images/board-N-UID.png`)를 첫 프레임으로 업로드 + Video prompt 붙여 넣기 |
| Higgsfield 웹 UI | 위와 같음. 보드 길이(초)를 duration 으로 |
| ComfyUI / 자동화 | `export/prompts`(JSON) 의 `boards[].payloads.higgsfield` 또는 `imagePrompt/videoPrompt/negativePrompt` 를 그대로 사용 |
| LLM(ChatGPT/Claude 등)에게 전체 검토 받기 | `export/markdown` 을 통째로 붙여 넣고 "컷 연결이 어색한 곳을 찾아줘" 같은 요청 |

프롬프트 팩 JSON 의 보드 항목 예:

```json
{
  "shot": "1A", "timecode": "00:00:00:00", "durationMs": 2000,
  "image": "images/board-2-XAJM8.png",
  "shotType": "EWS", "cameraMove": "static",
  "action": "S#1. 옥상 - 해질녘", "dialogue": "", "notes": "마스터 샷…",
  "links": [{ "provider": "youtube", "url": "https://www.youtube.com/watch?v=…&t=30s", "startSeconds": 30, "note": "노을 색온도" }],
  "imagePrompt": "Establishing extreme wide shot of 옥상, 해질녘. Style: …",
  "videoPrompt": "Static locked-off camera. Establishing view of …; 2s; smooth motion; 16:9. …",
  "negativePrompt": "text, watermark, …",
  "payloads": { "higgsfield": { "prompt": "…", "image_url": null, "duration": 3 } }
}
```

`image_url` 은 `PUBLIC_BASE_URL` 이 있을 때만 채워집니다.

## 4. 간단 프리비즈 → 고품질 영상 (권장 파이프라인)

1. 콘티 보드(러프 그림)로 **애니매틱 재생** — 리듬/길이 확정.
2. 보드별 Image prompt 로 키 프레임 생성(이미지 모델) → 레퍼런스 레이어로 가져와 구도 확인. 이 단계는 저렴합니다.
3. 마음에 드는 키 프레임이 있는 보드만 `ready` 로 표시.
4. `ready` 보드만 image-to-video(§2) — 영상 크레딧은 여기서만 소모.
5. 생성된 클립 URL 을 보드에 남기고 `approved`. 편집 툴(Resolve/Premiere)에서 CSV 샷 리스트 순서대로 이어 붙임.

## 5. 프로바이더 추가하기 (개발자용)

- `server/lib/ai/providers/` 에 파일 추가: `isConfigured()`, `publicStatus()`, `submit()`, `getStatus()` 를 export.
- `server/lib/ai/index.js` 의 `status()` / `submitVideo()` / `pollVideo()` 에 연결.
- 네트워크 호출은 모두 `fetchImpl` 주입이 가능하게 되어 있어 테스트에서 가짜 fetch 로 검증할 수 있습니다(`tests/links-prompts.test.js` 참고).
- 프롬프트 규칙은 `server/lib/promptBuilder.js` 한 곳에 있습니다(샷 타입/카메라 무브 → 영어 문구 사전).
