import { apiFetch } from './api';
import type { FeedbackSubmission } from './feedbackProfile';

export type FeedbackSubmitSuccess = {
  ok: true;
  mode?: 'sheet' | 'google-form' | 'local';
  fallback?: boolean;
  appVersion?: string;
};
export type FeedbackSubmitFailure = {
  ok: false;
  reason: 'not_configured' | 'offline' | 'validation';
};
export type FeedbackSubmitResult = FeedbackSubmitSuccess | FeedbackSubmitFailure;

export const uploadFeedbackScreenshot = async (dataUrl: string, filename = 'screenshot.png') => {
  const response = await apiFetch('/api/feedback/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, filename }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || 'Screenshot upload failed.');
  }
  return String(data.screenshotUrl || data.displayPath || '');
};

export const submitFeedbackForm = async (input: FeedbackSubmission): Promise<FeedbackSubmitResult> => {
  const trimmedName = String(input.name || '').trim();
  const trimmedSuggestions = String(input.suggestions || '').trim();
  if (!trimmedName || !trimmedSuggestions) {
    return { ok: false, reason: 'validation' };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const response = await apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: trimmedName,
        category: String(input.category || 'Suggestion').trim() || 'Suggestion',
        suggestions: trimmedSuggestions,
        appVersion: input.appVersion,
        platform: input.platform,
        architecture: input.architecture,
        osLabel: input.osLabel,
        websiteUrl: String(input.websiteUrl || '').trim(),
        videoUrl: String(input.videoUrl || '').trim(),
        fontName: String(input.fontName || '').trim(),
        screenshotUrl: String(input.screenshotUrl || '').trim(),
        screenshotDataUrl: String(input.screenshotDataUrl || '').trim(),
        lastError: String(input.lastError || '').trim(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) {
      return { ok: false, reason: 'offline' };
    }
    return {
      ok: true,
      mode: data?.mode,
      fallback: Boolean(data?.fallback),
      appVersion: data?.appVersion,
    };
  } catch {
    return { ok: false, reason: 'offline' };
  }
};
