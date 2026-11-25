'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../server/lib/analysisImport');

const SAMPLE = {
  video_id: 'VID1',
  title: 'AI Documentary',
  source: { url: 'https://youtu.be/aqz-KE-bpKQ' },
  metadata: { fps: 30, width: 1920, height: 1080, duration: 31 },
  shots: [
    { shot_id: 'SH001', start_frame: 0, end_frame: 120, description: '도시 전경', tags: ['도시', '드론'], camera: { shot_type: 'wide', movement: 'drone' }, audio_events: ['BGM'] },
    { shot_id: 'SH002', start_frame: 120, end_frame: 330, visual_description: '한 사람이 마이크 앞에서 이야기한다.', objects: ['사람', '마이크'], camera: { shot_type: 'medium', movement: 'static' }, transcript_ids: ['ASR_001'], thumbnail: 'thumbs/SH002.jpg' },
    { shot_id: 'SH004', start_time: '00:00:16', end_time: '00:00:23', visual_description: '노트북 작업', camera: { shot_type: 'close_up' }, mood: '집중' },
  ],
  transcript: [
    { segment_id: 'ASR_001', start_time: 4.5, end_time: 9.2, speaker: 'SPEAKER_01', text: '인공지능은 앞으로 모든 산업을 변화시킬 것입니다.' },
    { segment_id: 'ASR_002', start_time: 17, end_time: 20, text: '키보드 소리' },
  ],
};

test('mapShotType / mapCameraMove understand pipeline vocabulary (en + ko)', () => {
  assert.equal(ai.mapShotType('close_up'), 'CU');
  assert.equal(ai.mapShotType('Medium Close-Up'), 'MCU');
  assert.equal(ai.mapShotType('wide establishing shot'), 'EWS');
  assert.equal(ai.mapShotType('drone aerial'), 'BIRD');
  assert.equal(ai.mapShotType('클로즈업'), 'CU');
  assert.equal(ai.mapShotType('something else'), '');
  assert.equal(ai.mapCameraMove('static'), 'static');
  assert.equal(ai.mapCameraMove('slow pan to the left'), 'pan-left');
  assert.equal(ai.mapCameraMove('dolly out'), 'dolly-out');
  assert.equal(ai.mapCameraMove('tracking shot'), 'follow');
  assert.equal(ai.mapCameraMove('핸드헬드'), 'handheld');
  assert.equal(ai.mapCameraMove(''), '');
});

test('parseTime accepts timecodes, clock strings, seconds and frames', () => {
  assert.equal(ai.parseTime('00:01:02.500'), 62.5);
  assert.equal(ai.parseTime('01:02'), 62);
  assert.equal(ai.parseTime('00:00:04:12', 24), 4.5);
  assert.equal(ai.parseTime('12.5s'), 12.5);
  assert.equal(ai.parseTime(3), 3);
});

test('detectFormat', () => {
  assert.equal(ai.detectFormat(JSON.stringify(SAMPLE)), 'json');
  assert.equal(ai.detectFormat('Scene Number,Start Frame,Start Timecode\n1,1,00:00:00.000'), 'scenedetect-csv');
  assert.equal(ai.detectFormat('1\n00:00:01,000 --> 00:00:03,500\nhello'), 'srt');
  assert.equal(ai.detectFormat('WEBVTT\n\n00:00.000 --> 00:02.000\nhi'), 'vtt');
  assert.equal(ai.detectFormat('# Film\n\n### 장면 0001 · 00:00:00.000–00:00:02.000 · Intro'), 'storyboard-markdown');
  assert.equal(ai.detectFormat('   '), 'empty');
  assert.equal(ai.detectFormat('just some prose'), 'unknown');
});

test('storyboard Markdown → timed boards with image refs, bilingual dialogue and analysis notes', () => {
  const md = `# Imported Film

- 원본: [YouTube 영상](https://www.youtube.com/watch?v=abc123)
- 재생시간: 00:00:05
- 분석 소스: 1280×720, 24 fps

### 장면 0001 · 00:00:00.000–00:00:02.500 · 오프닝

![장면](scenes/scene_0001.jpg)

- 화면: 도시 위로 해가 뜬다.
- 분석: 설정 숏으로 장소와 분위기를 제시한다.

**한국어 번역**
> 아침이 시작됩니다.

**English · 자동 자막**
> Morning begins.

### 장면 0002 · 00:00:02.500–00:00:05.000 (2.5초)

![장면](scenes/scene_0002.jpg)

- 화면: 인물이 창문을 연다.
- 분석: 행동으로 본론을 시작한다.
> 안녕하세요.
`;
  const parsed = ai.parse(md);
  assert.equal(parsed.format, 'storyboard-markdown');
  assert.equal(parsed.meta.title, 'Imported Film');
  assert.equal(parsed.meta.fps, 24);
  assert.equal(parsed.shots.length, 2);
  assert.equal(parsed.shots[0].thumbnail, 'scenes/scene_0001.jpg');
  assert.equal(parsed.shots[0].transcriptText, '한국어: 아침이 시작됩니다.\nEnglish: Morning begins.');
  const { boards, summary } = ai.toBoards(parsed);
  assert.equal(summary.format, 'storyboard-markdown');
  assert.equal(boards.length, 2);
  assert.equal(boards[0].duration, 2500);
  assert.equal(boards[0].action, '도시 위로 해가 뜬다.');
  assert.ok(boards[0].notes.includes('설정 숏으로 장소와 분위기를 제시한다.'));
  assert.deepEqual(boards[0].ext.tags, ['markdown-import', '오프닝']);
});

test('JSON: shots + transcript → boards with timing, mapping, links and provenance', () => {
  const parsed = ai.parse(JSON.stringify(SAMPLE));
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.meta.videoId, 'VID1');
  assert.equal(parsed.meta.fps, 30);
  assert.equal(parsed.shots.length, 3);
  assert.equal(parsed.transcript.length, 2);

  const { boards, summary } = ai.toBoards(parsed, { defaultBoardTiming: 2000 });
  assert.equal(boards.length, 3);
  const [b1, b2, b3] = boards;
  assert.equal(b1.duration, 4000); // 120 frames @ 30fps
  assert.equal(b1.ext.shotType, 'WS');
  assert.equal(b1.action, '도시 전경');
  assert.ok(b1.notes.includes('[SH001]'));
  assert.ok(b1.notes.includes('카메라: drone')); // unmapped move is preserved in notes
  assert.deepEqual(b1.ext.tags, ['도시', '드론']);
  assert.equal(b1.ext.links[0].provider, 'youtube');
  assert.equal(b1.ext.links[0].embedUrl, 'https://www.youtube.com/embed/aqz-KE-bpKQ');

  assert.equal(b2.duration, 7000);
  assert.equal(b2.dialogue, 'SPEAKER_01: 인공지능은 앞으로 모든 산업을 변화시킬 것입니다.'); // via transcript_ids
  assert.equal(b2.ext.cameraMove, 'static');
  assert.equal(b2.ext.shotType, 'MS');
  assert.ok(b2.ext.links[0].url.includes('t=4s'));
  assert.equal(b2.ext.source.startFrame, 120);
  assert.equal(b2.ext.source.thumbnail, 'thumbs/SH002.jpg');

  assert.equal(b3.duration, 7000); // 16s → 23s
  assert.equal(b3.dialogue, '키보드 소리'); // by time overlap
  assert.ok(b3.ext.tags.includes('집중'));
  assert.equal(b3.ext.source.startTime, 16);

  assert.equal(summary.boards, 3);
  assert.equal(summary.withDialogue, 2);
  assert.equal(summary.withShotType, 3);
  assert.equal(summary.withCameraMove, 1);
  assert.equal(summary.totalMs, 18000);
  assert.equal(summary.sourceUrl, 'https://youtu.be/aqz-KE-bpKQ');
});

test('JSON: camelCase, wrapped and array-only variants are accepted', () => {
  const camel = ai.parse({ videoId: 'x', fps: 24, shots: [{ id: 's1', startTime: 0, endTime: 2, description: 'a', shotType: 'ECU' }] });
  assert.equal(camel.shots[0].shotType, 'ECU');
  assert.equal(camel.shots[0].endTime, 2);
  const wrapped = ai.parse({ result: { scenes: [{ scene_id: 1, start: '00:00:00', end: '00:00:03', summary: 'scene one' }] } });
  assert.equal(wrapped.shots.length, 1);
  assert.equal(wrapped.shots[0].endTime, 3);
  const arr = ai.parse([{ start_time: 0, end_time: 1.5, text: 'hello' }]);
  assert.equal(arr.transcript.length + arr.shots.length, 1);
});

test('PySceneDetect CSV → shots (frames are 1-based in the CSV)', () => {
  const csv = 'Timecode List:,00:00:03.000,00:00:08.500\nScene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames),Length (timecode),Length (seconds)\n1,1,00:00:00.000,0.000,72,00:00:03.000,3.000,72,00:00:03.000,3.000\n2,73,00:00:03.000,3.000,204,00:00:08.500,8.500,132,00:00:05.500,5.500\n';
  const parsed = ai.parse(csv);
  assert.equal(parsed.format, 'scenedetect-csv');
  assert.equal(parsed.meta.fps, 24);
  assert.deepEqual(parsed.shots.map((s) => [s.id, s.startFrame, s.endFrame, s.startTime, s.endTime]), [['SH001', 0, 72, 0, 3], ['SH002', 72, 204, 3, 8.5]]);
  const { boards } = ai.toBoards(parsed);
  assert.equal(boards.length, 2);
  assert.equal(boards[1].duration, 5500);
  assert.equal(boards[0].ext.links.length, 0);
});

test('SRT / VTT → one board per cue, speaker prefix preserved', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\nSPEAKER_01: 안녕하세요.\n\n2\n00:00:04,000 --> 00:00:06,000\n반갑습니다.\n';
  const s = ai.parse(srt);
  assert.equal(s.format, 'srt');
  assert.equal(s.transcript.length, 2);
  assert.equal(s.transcript[0].speaker, 'SPEAKER_01');
  const { boards, summary } = ai.toBoards(s);
  assert.deepEqual(boards.map((b) => b.dialogue), ['SPEAKER_01: 안녕하세요.', '반갑습니다.']);
  assert.equal(boards[0].duration, 2500);
  assert.equal(summary.transcriptSegments, 2);

  const vtt = 'WEBVTT\n\n00:00.000 --> 00:02.000\n<v Ann>Hi there\n\n00:02.500 --> 00:04.000\nSecond line\n';
  const v = ai.parse(vtt);
  assert.equal(v.format, 'vtt');
  assert.equal(v.transcript.length, 2);
  assert.equal(v.transcript[0].speaker, 'Ann');
  assert.equal(v.transcript[0].text, 'Hi there');
});

test('unknown input is rejected with status 400', () => {
  assert.throws(() => ai.parse('this is not analysis data'), (e) => e.status === 400);
  assert.throws(() => ai.parse(''), (e) => e.status === 400);
});
