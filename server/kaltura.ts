import * as cheerio from 'cheerio';

// Drupal media references can contain the player configuration only in hydration data.
export const extractKalturaVideosFromHtml = (html: string, sourceUrl: string) => {
  const videos = new Map<string, any>();
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    const partnerId = String(value.partnerId || '');
    const entryId = String(value.entryId || value.id || '');
    if (/^[1-9]\d*$/.test(partnerId) && /^[01]_[a-z0-9]+$/i.test(entryId)) {
      const url = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}/format/applehttp/protocol/https/a.m3u8`;
      videos.set(url, {
        url, sourceUrl, provider: 'kaltura', type: 'm3u8', isDirect: true,
        title: value.name || value.alt || 'Kaltura video',
        thumbnail: `https://cfvod.kaltura.com/p/${partnerId}/sp/${partnerId}00/thumbnail/entry_id/${entryId}/width/1280`,
      });
    }
    Object.values(value).forEach(visit);
  };
  const $ = cheerio.load(html);
  $('script[type="application/json"]').each((_, element) => {
    try { visit(JSON.parse($(element).text())); } catch { /* Ignore non-JSON scripts. */ }
  });
  return [...videos.values()];
};
