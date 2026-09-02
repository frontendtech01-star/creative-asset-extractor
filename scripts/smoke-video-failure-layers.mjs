import { classifyVideoFailure, retryLayersForFailure } from '../server/video-download-fallbacks.ts';

const cases = [
  ['This video is DRM protected with Widevine', 'drm', []],
  ['HTTP Error 429: Too Many Requests', 'rate-limit', ['backoff', 'impersonation', 'cookies']],
  ['fragment 12: HTTP Error 403', 'fragment', ['native-http', 'conservative-fragments', 'best-available']],
  ['signature has expired', 'expired', ['refresh-extractor', 'native-http']],
  ['Sign in and use --cookies', 'authentication', ['cookies']],
  ['Please confirm you are not a bot challenge', 'challenge', ['impersonation', 'cookies']],
  ['HTTP Error 503: Service Unavailable', 'transient-http', ['backoff', 'native-http', 'conservative-fragments']],
  ['Requested format is not available', 'format', ['best-available', 'single-file']],
  ['Unsupported URL', 'unsupported', ['impersonation']],
];

for (const [message, expectedKind, expectedLayers] of cases) {
  const kind = classifyVideoFailure(message);
  if (kind !== expectedKind) throw new Error(`${message}: expected ${expectedKind}, got ${kind}`);
  const layers = retryLayersForFailure(kind);
  if (JSON.stringify(layers) !== JSON.stringify(expectedLayers)) {
    throw new Error(`${kind}: expected ${expectedLayers.join(', ')}, got ${layers.join(', ')}`);
  }
}

console.log(`PASS: ${cases.length} video failure classes map to deterministic recovery layers`);
