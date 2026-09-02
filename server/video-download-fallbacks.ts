export type VideoFailureKind =
  | 'drm'
  | 'authentication'
  | 'geo'
  | 'challenge'
  | 'expired'
  | 'rate-limit'
  | 'transient-http'
  | 'fragment'
  | 'format'
  | 'tool'
  | 'unsupported'
  | 'unknown';

export const classifyVideoFailure = (input: unknown): VideoFailureKind => {
  const message = String(input || '').toLowerCase();
  if (/\bdrm\b|widevine|fairplay|playready|encrypted media/.test(message)) return 'drm';
  if (/not available in your country|geo(?:graphical)? restriction|region.?block/.test(message)) return 'geo';
  if (/login|sign in|private video|members.only|authentication|cookies? required|use --cookies/.test(message)) return 'authentication';
  if (/captcha|bot challenge|challenge_required|confirm you.re not a bot|impersonat/.test(message)) return 'challenge';
  if (/url has expired|signature has expired|token expired|403.*(?:signature|token)|expired.*(?:url|token)/.test(message)) return 'expired';
  if (/too many requests|http error 429|rate.?limit/.test(message)) return 'rate-limit';
  if (/fragment\s+\d+|failed to download fragment|fragment retries exhausted/.test(message)) return 'fragment';
  if (/http error (?:408|425|500|502|503|504)|timed? ?out|connection reset|temporary failure|network is unreachable/.test(message)) return 'transient-http';
  if (/requested format is not available|no video formats|no formats|no downloadable/.test(message)) return 'format';
  if (/ffmpeg.*not found|ffprobe.*not found|spawn.*enoent|permission denied/.test(message)) return 'tool';
  if (/unsupported url|unsupported site|no suitable extractor/.test(message)) return 'unsupported';
  return 'unknown';
};

export const retryLayersForFailure = (kind: VideoFailureKind) => {
  if (kind === 'drm' || kind === 'tool' || kind === 'geo') return [];
  if (kind === 'authentication') return ['cookies'];
  if (kind === 'challenge') return ['impersonation', 'cookies'];
  if (kind === 'expired') return ['refresh-extractor', 'native-http'];
  if (kind === 'rate-limit') return ['backoff', 'impersonation', 'cookies'];
  if (kind === 'fragment') return ['native-http', 'conservative-fragments', 'best-available'];
  if (kind === 'transient-http') return ['backoff', 'native-http', 'conservative-fragments'];
  if (kind === 'format') return ['best-available', 'single-file'];
  if (kind === 'unsupported') return ['impersonation'];
  return ['native-http', 'best-available'];
};
