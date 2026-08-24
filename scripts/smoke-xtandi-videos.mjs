const api = String(process.env.QC_API || 'http://127.0.0.1:3000').replace(/\/$/, '');
const targets = [
  {
    url: 'https://www.xtandi.com/patient-videos',
    expected: /streams\.bitmovin\.com\/cvrub3qpb3clk0so01n0\/manifest\.m3u8/i,
  },
  {
    url: 'https://www.xtandi.com/patient-videos/jims-journey',
    expected: /streams\.bitmovin\.com\/cvrub3qpb3clk0so01n0\/manifest\.m3u8/i,
  },
  {
    url: 'https://www.xtandi.com/patient-videos/power-of-support',
    expected: /streams\.bitmovin\.com\/cvrua12pb3clk0so01m0\/manifest\.m3u8/i,
  },
  {
    url: 'https://www.xtandi.com/patient-videos/journey-to-access',
    expected: /xtamahlonadvicetreatmentv15hires\/manifest\.m3u8/i,
  },
];

for (const target of targets) {
  const response = await fetch(`${api}/api/browser-tabs/chrome/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' },
    body: JSON.stringify({ url: target.url }),
    signal: AbortSignal.timeout(240000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) throw new Error(`${target.url}: ${payload?.error || response.status}`);
  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  const urls = videos.map((video) => String(video?.url || ''));
  if (!urls.some((url) => target.expected.test(url))) {
    throw new Error(`${target.url}: expected Bitmovin master manifest, got ${JSON.stringify(urls)}`);
  }
  const technical = urls.filter((url) =>
    /insight\.adsrvr|\/(?:audio)(?:[_/-]|$)|(?:^|\/)init\.mp4|(?:^|\/)(?:video|rendition)_\d+\.m3u8/i.test(url)
  );
  if (technical.length) throw new Error(`${target.url}: technical video noise remained: ${JSON.stringify(technical)}`);
  if (videos.length !== 1) throw new Error(`${target.url}: expected one active patient video, got ${videos.length}`);
  console.log(`PASS Xtandi ${target.url} — ${urls[0]}`);
}
