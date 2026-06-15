export const FEEDBACK_CATEGORIES = [
  'Suggestion',
  'Bug',
  'Image Download Issue',
  'Image Conversion Issue',
  'Font Download Issue',
  'Font Conversion Issue',
  'Video Download Issue',
  'Video Extraction Issue',
  'Video Conversion Issue',
  'Audio Extraction Issue',
  'Website Extraction Issue',
  'Performance Issue',
  'Other',
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export type FeedbackDraft = {
  category?: FeedbackCategory;
  websiteUrl?: string;
  videoUrl?: string;
  fontName?: string;
  screenshotUrl?: string;
  lastError?: string;
  suggestions?: string;
  appVersion?: string;
  osLabel?: string;
  platform?: string;
  architecture?: string;
};

const CATEGORY_BY_OPERATION: Record<string, FeedbackCategory> = {
  image_download: 'Image Download Issue',
  image_conversion: 'Image Conversion Issue',
  font_download: 'Font Download Issue',
  font_conversion: 'Font Conversion Issue',
  video_download: 'Video Download Issue',
  video_extraction: 'Video Extraction Issue',
  video_conversion: 'Video Conversion Issue',
  audio_extraction: 'Audio Extraction Issue',
  website_extraction: 'Website Extraction Issue',
  zip_creation: 'Performance Issue',
  fhd_unavailable: 'Video Extraction Issue',
};

let pendingDraft: FeedbackDraft | null = null;

export const categoryForOperation = (operation: string): FeedbackCategory =>
  CATEGORY_BY_OPERATION[operation] || 'Bug';

export const setFeedbackDraft = (draft: FeedbackDraft) => {
  pendingDraft = { ...(pendingDraft || {}), ...draft };
};

export const consumeFeedbackDraft = (): FeedbackDraft | null => {
  const draft = pendingDraft;
  pendingDraft = null;
  return draft;
};

export const peekFeedbackDraft = (): FeedbackDraft | null => pendingDraft;

export const requestOpenFeedback = (draft?: FeedbackDraft) => {
  if (draft) setFeedbackDraft(draft);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vdx:open-feedback', { detail: draft || peekFeedbackDraft() }));
  }
};

export const buildFailureSuggestions = (input: {
  operation: string;
  error: string;
  url?: string;
  assetType?: string;
  outputPath?: string;
  extra?: Record<string, string | undefined>;
}) => {
  const lines = [
    `Operation: ${input.operation}`,
    input.assetType ? `Asset type: ${input.assetType}` : '',
    input.url ? `URL: ${input.url}` : '',
    input.outputPath ? `Output path: ${input.outputPath}` : '',
    `Error: ${input.error}`,
    ...Object.entries(input.extra || {})
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`),
  ].filter(Boolean);
  return lines.join('\n');
};
