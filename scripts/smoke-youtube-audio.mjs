import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const headers = { 'X-VDX-Local-Request': '1' };
const VIDEO_ONLY_URL =
  process.env.SMOKE_VIDEO_ONLY_URL ||
  'https://rr3---sn-qxaeenss.googlevideo.com/videoplayback?expire=1780344035&ei=g5Adasa7NvuD9fwP7vyJ4Qg&ip=2402:e280:4118:40:b9f4:404d:bf4e:63dd&id=o-AFp1K7rOpLv5Dh-IJAGuCJeakQcJC25nDtWHazzCResU&itag=137&source=youtube&requiressl=yes&xpc=EgVo2aDSNQ==&cps=231&met=1780322435,&mh=XQ&mm=31,26&mn=sn-qxaeenss,sn-cvh76nek&ms=au,onr&mv=m&mvi=3&pl=48&rms=au,au&initcwndbps=3581250&bui=AbKmrwqk8ZMt4N_xJ2wy70OEHmuMYVAF5gLMeYTllCSOFXYe2KWasBHBUX_YXEX6qvgWOKJbdOn1NJLn&spc=96Xrv4Kp4oyG9zKoNfr_imx3vgWqkp1ymF5DXCC7V28M&vprv=1&svpuc=1&mime=video/mp4&rqh=1&gir=yes&clen=76380868&dur=550.880&lmt=1780074580683771&mt=1780321774&fvip=5&keepalive=yes&fexp=51565115,51565682&c=ANDROID_VR&txp=6309224&sparams=expire,ei,ip,id,itag,source,requiressl,xpc,bui,spc,vprv,svpuc,mime,rqh,gir,clen,dur,lmt&sig=AHEqNM4wRgIhALCVWoJZX3FEtVvl-uQSm9xj856cxSFYsABtIxAMAZDcAiEA33zvfkVkTb-RxTeAiLDbSwdvggse-ZYNMuZfV22PwOE=&lsparams=cps,met,mh,mm,mn,ms,mv,mvi,pl,rms,initcwndbps&lsig=APaTxxMwRQIhAMm74xPQ0lfcfGsYglIpeM7A59zbtS5uqIb3ZqKlQIcGAiAFYeU47AkiLTSdnnFrdi_O8phJ4mod9JS5RneGXpbjAQ==';
const WATCH_URL = process.argv[2] || process.env.SMOKE_YOUTUBE_WATCH_URL || '';

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const ok = (message) => {
  console.log(`OK: ${message}`);
};

const ffprobeJson = (filePath) => {
  const raw = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath,
  ]);
  return JSON.parse(String(raw));
};

const hasAudioStream = (metadata) =>
  Array.isArray(metadata?.streams) &&
  metadata.streams.some((stream) => stream?.codec_type === 'audio' && stream?.codec_name && stream.codec_name !== 'unknown');

const main = async () => {
  const probeRes = await fetch(`${BASE}/api/probe-stream-audio?url=${encodeURIComponent(VIDEO_ONLY_URL)}`, { headers });
  const probeData = await probeRes.json();
  if (!probeRes.ok) {
    fail(`probe-stream-audio failed (${probeRes.status}): ${probeData?.error || 'unknown error'}`);
  }
  if (probeData.hasAudio) {
    fail(`video-only googlevideo URL unexpectedly reported audio (${probeData.audioCodec || 'unknown codec'})`);
  }
  if (!probeData.hasVideo) {
    fail('video-only googlevideo URL did not report a video stream');
  }
  ok(`video-only stream has video (${probeData.videoCodec || 'unknown'}) and no audio`);

  if (!WATCH_URL) {
    console.log('SKIP: merged audio verification (pass YouTube watch URL as argv[1] or SMOKE_YOUTUBE_WATCH_URL)');
    console.log('PASS: partial youtube audio smoke test');
    return;
  }

  const resolveRes = await fetch(
    `${BASE}/api/resolve-video?url=${encodeURIComponent(WATCH_URL)}&quality=fhd`,
    { headers }
  );
  const resolveData = await resolveRes.json();
  if (!resolveRes.ok || !resolveData?.video?.url) {
    fail(`resolve-video failed (${resolveRes.status}): ${resolveData?.error || 'missing video payload'}`);
  }
  if (/googlevideo\.com\/videoplayback/i.test(String(resolveData.video.url))) {
    fail(`resolve-video returned video-only googlevideo URL: ${resolveData.video.url.slice(0, 120)}...`);
  }
  if (!resolveData.video.isYouTubeMerged && !String(resolveData.video.url).includes('/api/youtube-merged-stream')) {
    fail(`resolve-video did not return a merged YouTube stream URL: ${resolveData.video.url}`);
  }
  ok('resolve-video returned merged YouTube stream URL');

  const verifyRes = await fetch(
    `${BASE}/api/verify-youtube-merge?url=${encodeURIComponent(WATCH_URL)}&quality=fhd`,
    { headers }
  );
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok || !verifyData?.ok) {
    fail(`verify-youtube-merge failed (${verifyRes.status}): ${verifyData?.error || 'unknown error'}`);
  }
  if (!verifyData.hasAudio) {
    fail('merged YouTube file has no audio track');
  }
  if (!verifyData.hasVideo) {
    fail('merged YouTube file has no video track');
  }
  ok(`merged cache verified with audio (${verifyData.audioCodec}) and video (${verifyData.videoCodec}), size=${verifyData.size}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdx-yt-audio-smoke-'));
  const tempFile = path.join(tempDir, 'merged-sample.mp4');
  try {
    const mergedPath = String(verifyData.mergedUrl || `/api/youtube-merged-stream?url=${encodeURIComponent(WATCH_URL)}&quality=fhd`);
    const mergedUrl = mergedPath.startsWith('http') ? mergedPath : `${BASE}${mergedPath.startsWith('/') ? mergedPath : `/${mergedPath}`}`;
    const downloadRes = await fetch(mergedUrl, { headers });
    if (!downloadRes.ok) {
      fail(`youtube-merged-stream download failed (${downloadRes.status})`);
    }
    const bytes = Buffer.from(await downloadRes.arrayBuffer());
    if (bytes.length < 1024 * 1024) {
      fail(`merged download too small (${bytes.length} bytes)`);
    }
    fs.writeFileSync(tempFile, bytes);
    const metadata = ffprobeJson(tempFile);
    if (!hasAudioStream(metadata)) {
      fail('downloaded merged MP4 has no audio stream according to ffprobe');
    }
    ok(`downloaded merged MP4 contains audio (${bytes.length} bytes)`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('PASS: youtube audio smoke test');
};

main().catch((error) => fail(error?.message || String(error)));
