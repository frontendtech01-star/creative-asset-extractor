import { apiFetch } from './api';
import {
  buildFailureSuggestions,
  categoryForOperation,
  requestOpenFeedback,
  setFeedbackDraft,
  type FeedbackCategory,
} from './feedbackContext';

export type ActivityKind =
  | 'url_entered'
  | 'platform_detected'
  | 'extraction_start'
  | 'extraction_success'
  | 'extraction_failure'
  | 'image_download'
  | 'image_download_failure'
  | 'image_conversion_start'
  | 'image_conversion_success'
  | 'image_conversion_failure'
  | 'font_download'
  | 'font_download_failure'
  | 'font_conversion_start'
  | 'font_conversion_success'
  | 'font_conversion_failure'
  | 'video_download'
  | 'video_download_failure'
  | 'video_extraction_failure'
  | 'video_conversion_failure'
  | 'audio_extraction_failure'
  | 'zip_creation_failure'
  | 'fhd_unavailable';

export type ActivityEntry = {
  kind: ActivityKind;
  message?: string;
  url?: string;
  platform?: string;
  extractionType?: string;
  assetType?: string;
  outputPath?: string;
  error?: string;
  stack?: string;
  meta?: Record<string, string | number | boolean | undefined>;
};

const sanitizeStack = (error: unknown) => {
  const stack = error instanceof Error ? String(error.stack || '') : '';
  if (!stack) return '';
  return stack.split('\n').slice(0, 8).join('\n');
};

export const logActivity = async (entry: ActivityEntry) => {
  try {
    await apiFetch('/api/activity-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...entry,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Activity logging is best-effort.
  }
};

export type FailureReportInput = {
  operation: ActivityKind;
  error: string | Error;
  url?: string;
  websiteUrl?: string;
  videoUrl?: string;
  fontName?: string;
  assetType?: string;
  outputPath?: string;
  platform?: string;
  extractionType?: string;
  screenshotUrl?: string;
  openFeedback?: boolean;
  meta?: Record<string, string | undefined>;
};

const operationKeyFromKind = (kind: ActivityKind) => {
  if (kind.includes('image_download')) return 'image_download';
  if (kind.includes('image_conversion')) return 'image_conversion';
  if (kind.includes('font_download')) return 'font_download';
  if (kind.includes('font_conversion')) return 'font_conversion';
  if (kind.includes('video_download')) return 'video_download';
  if (kind.includes('video_extraction')) return 'video_extraction';
  if (kind.includes('video_conversion')) return 'video_conversion';
  if (kind.includes('audio_extraction')) return 'audio_extraction';
  if (kind.includes('zip_creation')) return 'zip_creation';
  if (kind === 'fhd_unavailable') return 'fhd_unavailable';
  if (kind.includes('extraction')) return 'website_extraction';
  return 'bug';
};

export const reportOperationFailure = async (input: FailureReportInput) => {
  const errorMessage = input.error instanceof Error ? input.error.message : String(input.error || 'Unknown error');
  const stack = input.error instanceof Error ? sanitizeStack(input.error) : '';
  const operationKey = operationKeyFromKind(input.operation);
  const category = categoryForOperation(operationKey) as FeedbackCategory;

  await logActivity({
    kind: input.operation,
    message: errorMessage,
    url: input.url || input.videoUrl || input.websiteUrl,
    platform: input.platform,
    extractionType: input.extractionType,
    assetType: input.assetType,
    outputPath: input.outputPath,
    error: errorMessage,
    stack,
    meta: input.meta,
  });

  const suggestions = buildFailureSuggestions({
    operation: operationKey,
    error: errorMessage,
    url: input.url || input.videoUrl || input.websiteUrl,
    assetType: input.assetType,
    outputPath: input.outputPath,
    extra: { stack, ...input.meta },
  });

  setFeedbackDraft({
    category,
    websiteUrl: input.websiteUrl || (input.extractionType ? input.url : ''),
    videoUrl: input.videoUrl || input.url,
    fontName: input.fontName,
    screenshotUrl: input.screenshotUrl,
    lastError: errorMessage,
    suggestions,
  });

  if (input.openFeedback !== false) {
    requestOpenFeedback();
  }
};
