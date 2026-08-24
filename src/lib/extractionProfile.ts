export type ExtractionProfileKind = 'normal' | 'heavy' | 'captcha';
export type ExtractionProfileHint = 'auto' | ExtractionProfileKind;

export type ExtractionProfile = {
  kind: ExtractionProfileKind;
  label: string;
  detail: string;
  browserBudgetMs: number;
  pageLoadTimeoutMs: number;
  challengeWaitMs: number;
};

type ProfileInput = {
  url: string;
  html?: string;
  crawlMode?: 'fast' | 'deep';
  captchaDetected?: boolean;
  profileHint?: ExtractionProfileHint;
};

const KNOWN_HEAVY_HOSTS = /(?:^|\.)(?:fabindia\.com|warehousestationery\.co\.nz|joannamendoza\.com)$/i;

export function classifyWebsiteExtraction({
  url,
  html = '',
  crawlMode = 'fast',
  captchaDetected = false,
  profileHint = 'auto',
}: ProfileInput): ExtractionProfile {
  if (captchaDetected || profileHint === 'captcha') {
    return {
      kind: 'captcha',
      label: 'Verification or CAPTCHA detected',
      detail: 'Checking briefly for automatic verification. If it remains, open the website in Chrome and complete the CAPTCHA before retrying.',
      browserBudgetMs: 20_000,
      pageLoadTimeoutMs: 12_000,
      challengeWaitMs: 9_000,
    };
  }

  const assetTags = (html.match(/<(?:img|source|video|script|link)\b/gi) || []).length;
  const hasLargeMarkup = html.length > 650_000;
  const hasDenseAssets = assetTags > 140;
  const isKnownHeavy = KNOWN_HEAVY_HOSTS.test(new URL(url).hostname);
  const isHeavy = profileHint === 'heavy' || (profileHint === 'auto' && (crawlMode === 'deep' || isKnownHeavy || hasLargeMarkup || hasDenseAssets));

  if (isHeavy) {
    return {
      kind: 'heavy',
      label: 'Heavy website detected',
      detail: 'This page has a large or highly interactive asset set, so Chromium is given extra time to finish the scan.',
      browserBudgetMs: 10_000,
      pageLoadTimeoutMs: 25_000,
      challengeWaitMs: 20_000,
    };
  }

  return {
    kind: 'normal',
    label: 'Normal website scan',
    detail: 'Using the standard fast Chromium scan for this page.',
    browserBudgetMs: profileHint === 'normal' ? 5_000 : 10_000,
    pageLoadTimeoutMs: 12_000,
    challengeWaitMs: 9_000,
  };
}
