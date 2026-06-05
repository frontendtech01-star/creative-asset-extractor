/** Browser-side insights extraction — plain JS for Puppeteer evaluate (no tsx __name injection). */
function insightsPageEvaluate(pageUrl, keywordList) {
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const toAbs = (value) => {
    if (!value || value.startsWith('data:') || value.startsWith('blob:')) return '';
    try { return new URL(value, pageUrl).href; } catch { return ''; }
  };
  const includesAny = (text, words) => words.some((word) => text.toLowerCase().includes(word));

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 10 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };

  const isNoise = (el) => Boolean(
    el.closest('nav, script, style, noscript, [role="navigation"], [id*="cookie" i], [class*="cookie" i], [class*="consent" i]')
  );

  const isSafetyNoise = (el) => Boolean(
    el.closest('nav, script, style, noscript, [role="navigation"], [id*="cookie" i], [class*="cookie" i], [class*="consent" i]')
  );

  const headingScore = (el) => {
    const text = clean(el.textContent);
    if (!text || text.length < 4 || text.length > 220 || isNoise(el) || !isVisible(el)) return -1;
    const rect = el.getBoundingClientRect();
    const size = parseFloat(window.getComputedStyle(el).fontSize || '16');
    const tag = el.tagName.toLowerCase();
    return (tag === 'h1' ? 900 : tag === 'h2' ? 350 : 100) + Math.max(0, 1200 - Math.max(0, rect.top)) + size * 16;
  };

  const headingCandidates = Array.from(document.querySelectorAll('h1, h2, [class*="hero" i], [class*="headline" i], [class*="title" i]'))
    .map((el) => ({ text: clean(el.textContent), score: headingScore(el) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const imageMap = new Map();
  const addImage = (src, el, source) => {
    const abs = toAbs(src);
    if (!abs) return;
    const label = `${abs} ${el.alt || ''}`.toLowerCase();
    if (/(logo|favicon|icon-|sprite|apple-touch-icon|avatar)/.test(label)) return;
    const rect = el.getBoundingClientRect();
    if (rect.top > 2600 || rect.width < 70 || rect.height < 50) return;
    const priority = Math.round(Math.max(0, 1200 - Math.max(0, rect.top)) + Math.min((rect.width * rect.height) / 1000, 1000));
    imageMap.set(abs, {
      url: abs,
      alt: clean(el.alt || el.getAttribute('aria-label') || ''),
      source,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      priority,
    });
  };

  Array.from(document.images).forEach((img) => {
    if (isNoise(img)) return;
    const srcs = [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.getAttribute('data-original')];
    srcs.forEach((src) => addImage(src || '', img, 'image'));
  });

  Array.from(document.querySelectorAll('[style], section, div, header')).forEach((el) => {
    if (isNoise(el) || !isVisible(el)) return;
    const match = window.getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
    if (match && match[1]) addImage(match[1], el, 'background');
  });

  const videoMap = new Map();
  const addVideo = (rawUrl, title, source, poster = '') => {
    const abs = toAbs(rawUrl);
    if (!abs) return;
    videoMap.set(abs, {
      url: abs,
      title: clean(title) || 'Video asset',
      source,
      poster: toAbs(poster),
    });
  };

  Array.from(document.querySelectorAll('video')).forEach((video) => {
    if (isNoise(video)) return;
    const title = video.getAttribute('title') || video.getAttribute('aria-label') || (video.closest('section') && video.closest('section').querySelector('h1,h2,h3') && video.closest('section').querySelector('h1,h2,h3').textContent) || '';
    addVideo(video.currentSrc || video.src, title, 'video', video.poster);
    Array.from(video.querySelectorAll('source')).forEach((source) => addVideo(source.getAttribute('src') || '', title, 'video-source', video.poster));
  });

  Array.from(document.querySelectorAll('iframe, embed')).forEach((frame) => {
    if (isNoise(frame)) return;
    const src = frame.getAttribute('src') || frame.getAttribute('data-src') || '';
    if (/youtube|youtu\.be|vimeo|wistia|vidyard|loom|brightcove|mp4|webm/i.test(src)) {
      const title = frame.getAttribute('title') || frame.getAttribute('aria-label') || (frame.closest('section') && frame.closest('section').querySelector('h1,h2,h3') && frame.closest('section').querySelector('h1,h2,h3').textContent) || '';
      addVideo(src, title, 'embed');
    }
  });

  const sections = Array.from(document.querySelectorAll('main section, article section, section, main [class], article [class]'))
    .filter((el) => !isNoise(el))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const titleEl = el.querySelector('h1,h2,h3,[class*="title" i],[class*="heading" i]');
      const title = clean(titleEl && titleEl.textContent);
      const text = clean(el.textContent);
      const image = Array.from(el.querySelectorAll('img'))
        .map((img) => toAbs(img.currentSrc || img.src || img.getAttribute('data-src') || ''))
        .find(Boolean) || '';
      return {
        title,
        text: text.length > 1200 ? text.slice(0, 1200) : text,
        top: rect.top,
        imageCount: el.querySelectorAll('img,video,picture').length,
        image,
      };
    })
    .filter((item) => item.text.length > 32);

  const focusSections = sections
    .filter((item) => item.top < 1300 || includesAny(item.text, ['value', 'solution', 'platform', 'designed', 'built', 'help', 'improve']))
    .sort((a, b) => a.top - b.top);
  const featureSections = sections.filter((item) => includesAny(`${item.title} ${item.text}`, ['feature', 'benefit', 'results', 'proof', 'easy', 'fast', 'improve', 'coverage', 'efficacy', 'safety', 'study']));
  const testimonialSections = sections.filter((item) => includesAny(`${item.title} ${item.text}`, ['testimonial', 'review', 'trusted', 'patients', 'customer', 'quote', 'ratings']));

  const normalizeExactBlockInPage = (value) =>
    value
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const seenSafety = new Set();
  const safetyBlocksRaw = Array.from(document.querySelectorAll('section, article, div, p, li, footer, [id*="isi" i], [class*="isi" i], [id*="safety" i], [id*="warning" i], [id*="disclaimer" i], [id*="legal" i], [id*="reference" i], [class*="safety" i], [class*="warning" i], [class*="disclaimer" i], [class*="legal" i], [class*="reference" i], [class*="important-information" i]'))
    .filter((el) => !isSafetyNoise(el))
    .map((el) => {
      const exactText = normalizeExactBlockInPage(el.innerText || '');
      const lower = exactText.toLowerCase();
      return {
        exactText,
        lower,
        isMatch: exactText.length > 20 && includesAny(lower, keywordList),
        isDisclaimer: includesAny(lower, ['disclaimer', 'not imply', 'terms apply', 'limitations', 'reference', 'prescribing information', 'see full', 'full pi']),
        isLegal: includesAny(lower, ['legal', 'terms of use', 'terms and conditions', 'privacy policy', 'copyright', 'all rights reserved', 'fair balance']),
        isReference: includesAny(lower, ['reference', 'references', 'bibliography', 'ref.', 'clinical trial', 'nct0', 'nct-']),
      };
    })
    .filter((item) => item.isMatch)
    .filter((item) => {
      const key = item.exactText.toLowerCase().replace(/\s+/g, ' ');
      if (seenSafety.has(key)) return false;
      seenSafety.add(key);
      return true;
    });
  const safetyBlocks = safetyBlocksRaw.filter((item) => !item.isDisclaimer && !item.isLegal && !item.isReference).map((item) => item.exactText);
  const disclaimerBlocks = safetyBlocksRaw.filter((item) => item.isDisclaimer).map((item) => item.exactText);
  const legalBlocks = safetyBlocksRaw.filter((item) => item.isLegal).map((item) => item.exactText);
  const referenceBlocks = safetyBlocksRaw.filter((item) => item.isReference).map((item) => item.exactText);

  const internalLinks = Array.from(document.querySelectorAll('a[href], [data-href], button[data-href], [data-url], [data-link], [role="tab"]'))
    .map((el) => el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link') || el.getAttribute('data-target') || '')
    .map((href) => toAbs(href))
    .filter(Boolean);

  const keywordText = `${headingCandidates[0] && headingCandidates[0].text || ''} ${focusSections.map((item) => item.text).join(' ')} ${featureSections.map((item) => item.text).join(' ')}`.toLowerCase();
  const rawKeywords = (keywordText.match(/\b[a-z][a-z0-9-]{3,}\b/g) || []).filter((word) => !['this','that','with','from','your','their','about','have','will','for','and','the','you','our','are','more','into','can','all','not','was','has'].includes(word));

  return {
    pageUrl,
    headingCandidates,
    heroImages: Array.from(imageMap.values()).sort((a, b) => b.priority - a.priority).slice(0, 10),
    videos: Array.from(videoMap.values()).slice(0, 16),
    focusSections,
    featureSections,
    testimonialSections,
    galleryImages: Array.from(imageMap.values()).sort((a, b) => b.priority - a.priority).slice(0, 24),
    safetyBlocks,
    disclaimerBlocks,
    legalBlocks,
    referenceBlocks,
    internalLinks,
    rawKeywords,
  };
}

module.exports = insightsPageEvaluate;
