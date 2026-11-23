# 실행 · 배포 · 테스트 환경

## 1. 요구 사항

- Node.js **18.17 이상** (20 LTS 권장). 네이티브 모듈 없음 → Windows / macOS / Linux / Raspberry Pi 모두 동일.
- 런타임 의존성은 `express` 하나. `npm install` 은 수 초면 끝납니다.
- 저장소 용량을 지키기 위해 브라우저(Playwright), 폰트, 외부 라이브러리는 **포함하지 않습니다**. 필요할 때 아래 설명대로 받으세요.
- **선택**: `yt-dlp`(YouTube·Vimeo 주소에서 영상 가져오기) 와 `ffmpeg`(화질 선택 시 영상+오디오 병합, 자막 변환). 둘 다 없어도 앱은 완전히 동작합니다 — 직접 영상 파일 URL 과 로컬 파일 드롭은 항상 됩니다.
  ```bash
  pip install -U yt-dlp            # 또는 https://github.com/yt-dlp/yt-dlp/releases 의 단일 실행 파일
  # ffmpeg: apt install ffmpeg / brew install ffmpeg / winget install ffmpeg, 또는 pip install imageio-ffmpeg 후 FFMPEG_PATH 지정
  ```
  PATH 에 없으면 `.env` 에 `YTDLP_PATH=/usr/local/bin/yt-dlp`, `FFMPEG_PATH=/usr/bin/ffmpeg` 를 적습니다. 확인: `GET /api/video/capabilities`.

## 2. 로컬 실행

```bash
npm install
npm start                # http://localhost:3000  (HOST=0.0.0.0 이라 같은 네트워크에서도 접속 가능)
npm run dev              # 파일 변경 시 자동 재시작 (node --watch)
```

환경 변수(`.env` 또는 셸):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 포트 |
| `HOST` | `0.0.0.0` | 바인드 주소. 내 PC 에서만 쓰려면 `127.0.0.1` |
| `PROJECTS_DIR` | `./projects` | 프로젝트 저장 폴더 (Dropbox/NAS 경로도 가능) |
| `PUBLIC_BASE_URL` | – | 영상 API 가 이미지를 가져갈 공개 주소 → [AI_INTEGRATION.md](AI_INTEGRATION.md) |
| `LINK_PREVIEW_OFFLINE` | – | `1` 이면 링크 미리보기에서 외부 요청 안 함 |
| `PNG_OPTIMIZE` | `1` | `0` 이면 저장 시 PNG 재압축 생략 (느린 기기에서) |
| `AI_TEXT_*`, `HF_*` | – | AI 키 → [AI_INTEGRATION.md](AI_INTEGRATION.md) |

### iPad / 태블릿에서 그리기

1. PC 에서 `npm start`.
2. PC 의 LAN IP 확인 (`ipconfig` / `ifconfig` / `ip a`), 태블릿 브라우저에서 `http://<IP>:3000`.
3. Apple Pencil / S Pen 필압이 적용됩니다. 손바닥 오인식이 있으면 `설정 → 터치로도 그리기` 해제.
4. 홈 화면에 추가(PWA 처럼 전체 화면)해 두면 편합니다. 방화벽이 3000 포트를 막고 있지 않은지 확인.

## 3. 상시 실행 (PM2 / systemd)

```bash
# PM2 (https://pm2.keymetrics.io)
npm i -g pm2
pm2 start server/index.js --name storyboarder-next --env production
pm2 save && pm2 startup
```

```ini
# /etc/systemd/system/storyboarder-next.service
[Unit]
Description=Storyboarder Next
After=network.target

[Service]
WorkingDirectory=/opt/storyboarder-next
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
Environment=PORT=3000
Environment=PROJECTS_DIR=/srv/storyboards
User=www-data

[Install]
WantedBy=multi-user.target
```

## 4. Docker

```Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 HOST=0.0.0.0 PROJECTS_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
```

```bash
docker build -t storyboarder-next .
docker run -d -p 3000:3000 -v $PWD/projects:/data --env-file .env storyboarder-next
```

## 5. 인터넷에 열 때 (주의)

이 앱에는 **로그인이 없습니다.** 공개 서버에 올릴 때는 반드시 앞단에서 막으세요.

- Cloudflare Tunnel + Cloudflare Access(이메일 인증), 또는 Tailscale/ZeroTier 같은 사설망 — 가장 간단하고 안전.
- nginx/Caddy 리버스 프록시 + Basic Auth 예(Caddy):

```caddyfile
story.example.com {
  basicauth {
    me JDJhJDE0JGh...   # caddy hash-password
  }
  reverse_proxy 127.0.0.1:3000
}
```

- Higgsfield 등 영상 API 는 `PUBLIC_BASE_URL/projects/<id>/images/...` 를 **인증 없이** 가져가야 하므로, 인증 프록시를 쓴다면 `/projects/*/images/*` 경로만 예외로 열거나 생성할 때만 임시 터널(`cloudflared tunnel --url http://localhost:3000`)을 켜세요.
- **화이트보드 업로드**(`POST /api/projects/:id/assets`)는 파일당 최대 60 MB, 요청 본문 80 MB 입니다. 리버스 프록시의 본문 한도도 맞추세요(nginx `client_max_body_size 80m;`, Caddy 는 기본 무제한). 업로드 파일은 `projects/<id>/assets/` 에 쌓이므로 디스크 여유를 보고, 참조가 끊긴 파일은 자동 정리됩니다.
- **영상 가져오기**(`POST /api/projects/:id/video/fetch`)는 서버가 영상을 통째로 내려받습니다(`VIDEO_MAX_MB`, 기본 1024 MB; 캐시 `VIDEO_CACHE_DIR`, 6시간 뒤 자동 삭제). 공개 서버에서는 이 기능이 **서버를 다운로더로** 쓰게 하므로 인증 뒤에 두고 `VIDEO_MAX_MB` 를 낮추거나, 프록시에서 `/api/projects/*/video/fetch` 를 막으세요(로컬 파일 드롭은 서버를 거치지 않으므로 계속 됩니다). yt-dlp 는 대상 사이트의 약관을 따르는 범위에서 쓰세요.
- **원격 이미지 가져오기**(`POST …/assets/from-url`, 화이트보드에 이미지 주소를 붙여 넣을 때)는 서버가 그 URL 로 나가서 내려받습니다(아웃바운드 트래픽 발생, 20초 타임아웃, 60 MB 한도, 사설 IP 차단). 서버가 외부로 나갈 수 없는 환경이면 이 기능만 실패하고 링크 카드로 남습니다. 완전히 막으려면 프록시에서 이 경로를 차단하세요.

## 6. 테스트

```bash
npm test          # node:test — server/lib 유닛 테스트 + 실제 HTTP 서버를 띄우는 API 테스트 (임시 폴더 사용)
npm run lint      # node --check 전 파일 + HTML 이 참조하는 파일 존재 확인
```

### e2e 테스트 (Playwright)

실제 Chromium 으로 그리기·저장·대본/분석 결과 가져오기·화이트보드·재생·인쇄·새로고침까지 18단계를 돌리고 `tests/e2e/output/*.png` 에 스크린샷을 남깁니다. Playwright 는 devDependency 로 선언만 되어 있고 브라우저 바이너리(약 150MB)는 저장소에 없습니다.

```bash
npm i -D playwright          # package-lock 에 맞춰 설치 (또는 npm install 로 dev 포함 설치)
npx playwright install chromium
npm run test:e2e
```

- macOS / Windows: 위 두 줄이면 끝.
- Ubuntu / Debian: 시스템 라이브러리가 필요합니다. 보통 `npx playwright install --with-deps chromium` 으로 되지만, 최신 Debian(13)/일부 컨테이너에서는 폰트 패키지 이름 때문에 실패합니다. 그때는 직접 설치:

```bash
sudo apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
  libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-6 libx11-xcb1 libxcb1 libxext6 \
  libxcursor1 libxi6 libxrender1 libxss1 libxtst6 libglib2.0-0 \
  fonts-noto-cjk fonts-liberation
npx playwright install chromium
```

`fonts-noto-cjk` 가 없으면 스크린샷의 한글이 □ 로 나옵니다(테스트 자체는 통과).

- 다른 위치에 설치된 Playwright 를 쓰려면: `NODE_PATH=/path/to/node_modules node tests/e2e/smoke.js`.

### GitHub Actions 예시

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: e2e-screenshots, path: tests/e2e/output }
```

## 7. 저장소 관리 팁

- `projects/` 는 `.gitignore` 되어 있고 `projects/sample-*/` 만 커밋됩니다. 실제 작업 프로젝트를 git 으로 관리하려면 별도 저장소를 `PROJECTS_DIR` 로 지정하거나 `.gitignore` 의 예외에 추가하세요.
- 보드 PNG 는 저장 시 무손실 재압축되지만, 사진을 레퍼런스 레이어로 넣으면 보드당 수백 KB 가 됩니다. 사진은 링크로 두거나 Git LFS 를 고려하세요.
- 화이트보드 에셋(`projects/<id>/assets/`)은 원본 그대로 저장됩니다. 영상 파일을 많이 올리면 금방 커지므로 유튜브/Vimeo 는 임베드(저장 안 함)로, 큰 파일은 `.gitignore` 에 `projects/*/assets/*.mp4` 같은 규칙을 추가하세요.
- 생성된 영상은 저장하지 않습니다(URL 만). 받아 두려면 `projects/<id>/renders/` 처럼 별도 폴더 + `.gitignore`.
