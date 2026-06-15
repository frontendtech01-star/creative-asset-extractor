import { apiFetch } from './api';
import type { FeedbackCategory } from './feedbackContext';

export type FeedbackProfile = {
  suggestedName: string;
  platform: string;
  architecture: string;
  osLabel: string;
  appVersion: string;
  productName: string;
};

export type FeedbackSubmission = {
  name: string;
  category?: FeedbackCategory | string;
  suggestions: string;
  appVersion: string;
  platform: string;
  architecture: string;
  osLabel: string;
  websiteUrl?: string;
  videoUrl?: string;
  fontName?: string;
  screenshotUrl?: string;
  screenshotDataUrl?: string;
  lastError?: string;
};

export type FeedbackStatus = {
  mode: string;
  sheetWebhookNeedsUpdate: boolean;
  expectedSheetWebhookVersion: number;
  sheetWebhookVersion: number;
};

export const fetchFeedbackStatus = async (): Promise<FeedbackStatus | null> => {
  try {
    const response = await apiFetch('/api/feedback/status');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return {
      mode: String(data?.mode || 'local'),
      sheetWebhookNeedsUpdate: Boolean(data?.sheetWebhookNeedsUpdate),
      expectedSheetWebhookVersion: Number(data?.expectedSheetWebhookVersion) || 2,
      sheetWebhookVersion: Number(data?.sheetWebhookVersion) || 0,
    };
  } catch {
    return null;
  }
};

export const fetchFeedbackProfile = async (): Promise<FeedbackProfile | null> => {
  try {
    const response = await apiFetch('/api/feedback/profile');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return {
      suggestedName: String(data?.suggestedName || ''),
      platform: String(data?.platform || ''),
      architecture: String(data?.architecture || ''),
      osLabel: String(data?.osLabel || ''),
      appVersion: String(data?.appVersion || '1.0.0'),
      productName: String(data?.productName || 'Creative Asset Extractor'),
    };
  } catch {
    return null;
  }
};

export const formatPlatformSummary = (profile: Pick<FeedbackProfile, 'productName' | 'appVersion' | 'osLabel' | 'architecture'>) => {
  const version = profile.appVersion.replace(/^v/i, '');
  const parts = [
    `${profile.productName} v${version}`,
    profile.osLabel,
    profile.architecture,
  ].filter(Boolean);
  return parts.join('\n');
};
