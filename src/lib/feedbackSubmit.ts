import { apiFetch } from './api';

export type FeedbackSubmitSuccess = {
  ok: true;
  mode?: 'sheet' | 'google-form' | 'local';
  fallback?: boolean;
};
export type FeedbackSubmitFailure = {
  ok: false;
  reason: 'not_configured' | 'offline' | 'validation';
};
export type FeedbackSubmitResult = FeedbackSubmitSuccess | FeedbackSubmitFailure;

export const submitFeedbackForm = async (name: string, suggestions: string): Promise<FeedbackSubmitResult> => {
  const trimmedName = String(name || '').trim();
  const trimmedSuggestions = String(suggestions || '').trim();
  if (!trimmedName || !trimmedSuggestions) return { ok: false, reason: 'validation' };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, reason: 'offline' };
  }

  try {
    const response = await apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmedName, suggestions: trimmedSuggestions }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) {
      return { ok: false, reason: 'offline' };
    }
    return {
      ok: true,
      mode: data?.mode,
      fallback: Boolean(data?.fallback),
    };
  } catch {
    return { ok: false, reason: 'offline' };
  }
};
