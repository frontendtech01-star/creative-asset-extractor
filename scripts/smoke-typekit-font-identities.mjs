const API = process.env.QC_API || 'http://127.0.0.1:3000';
const headers = { 'Content-Type': 'application/json', 'X-VDX-Local-Request': '1' };

const kits = [
  {
    url: 'https://use.typekit.net/tzy4ptk.css',
    family: 'acumin-pro-wide',
    faces: [
      ['400', 'normal'], ['400', 'italic'], ['500', 'normal'], ['500', 'italic'],
      ['600', 'normal'], ['600', 'italic'], ['700', 'normal'], ['700', 'italic'],
    ],
  },
  {
    url: 'https://use.typekit.net/bbu6zls.css',
    family: 'sofia-pro',
    faces: [['300', 'normal'], ['400', 'normal'], ['700', 'normal'], ['800', 'normal'], ['900', 'normal']],
  },
];

const response = await fetch(`${API}/api/resolve-font-links`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ urls: kits.map((kit) => kit.url) }),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `Font resolver failed (${response.status})`);

const fonts = Array.isArray(payload.fonts) ? payload.fonts : [];
for (const kit of kits) {
  const found = fonts.filter((font) => String(font?.cssSource) === kit.url);
  if (found.length !== kit.faces.length) {
    throw new Error(`${kit.family}: expected ${kit.faces.length} unique faces, got ${found.length}`);
  }
  const identities = new Set();
  for (const font of found) {
    const family = String(font?.family || '').toLowerCase();
    const weight = String(font?.weight || '400');
    const style = String(font?.style || 'normal').toLowerCase();
    const identity = `${family}|${weight}|${style}`;
    if (family !== kit.family || !kit.faces.some(([expectedWeight, expectedStyle]) => expectedWeight === weight && expectedStyle === style)) {
      throw new Error(`${kit.family}: incorrect identity ${identity}`);
    }
    if (identities.has(identity)) throw new Error(`${kit.family}: duplicate face ${identity}`);
    identities.add(identity);
  }
  console.log(`PASS: ${kit.family} exposes ${found.length}/${kit.faces.length} distinct family/weight/style faces`);
}
