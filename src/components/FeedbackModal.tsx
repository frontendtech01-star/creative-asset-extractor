import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, MessageSquare, X } from 'lucide-react';
import {
  consumeFeedbackDraft,
  FEEDBACK_CATEGORIES,
  type FeedbackCategory,
  type FeedbackDraft,
} from '../lib/feedbackContext';
import {
  fetchFeedbackProfile,
  formatPlatformSummary,
  type FeedbackProfile,
} from '../lib/feedbackProfile';
import { compressScreenshotDataUrlForSheet } from '../lib/compressFeedbackScreenshot.browser';
import { submitFeedbackForm, uploadFeedbackScreenshot } from '../lib/feedbackSubmit';

export function FeedbackModal({
  open,
  onClose,
  appVersion = '1.0.0',
  productName = 'Creative Asset Extractor',
  initialDraft = null,
}: {
  open: boolean;
  onClose: () => void;
  appVersion?: string;
  productName?: string;
  initialDraft?: FeedbackDraft | null;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>('Suggestion');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [fontName, setFontName] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [lastError, setLastError] = useState('');
  const [suggestions, setSuggestions] = useState('');
  const [profile, setProfile] = useState<FeedbackProfile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submittedVersion, setSubmittedVersion] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotDataUrlRef = useRef('');
  const [dragActive, setDragActive] = useState(false);

  const applyDraft = (draft: FeedbackDraft | null) => {
    if (!draft) return;
    if (draft.category && FEEDBACK_CATEGORIES.includes(draft.category)) setCategory(draft.category);
    if (draft.websiteUrl) setWebsiteUrl(draft.websiteUrl);
    if (draft.videoUrl) setVideoUrl(draft.videoUrl);
    if (draft.fontName) setFontName(draft.fontName);
    if (draft.screenshotUrl) setScreenshotUrl(draft.screenshotUrl);
    if (draft.lastError) setLastError(draft.lastError);
    if (draft.suggestions) setSuggestions(draft.suggestions);
  };

  useEffect(() => {
    if (!open) return;

    setSubmitting(false);
    setUploadingScreenshot(false);
    setError('');
    setSubmitted(false);
    setSubmittedVersion('');
    setDragActive(false);
    screenshotDataUrlRef.current = '';

    const draft = initialDraft || consumeFeedbackDraft();
    applyDraft(draft);

    void fetchFeedbackProfile().then((nextProfile) => {
      if (!nextProfile) {
        setProfile({
          suggestedName: '',
          platform: '',
          architecture: '',
          osLabel: '',
          appVersion,
          productName,
        });
        setName('');
        return;
      }
      setProfile(nextProfile);
      setName(nextProfile.suggestedName || '');
    });
  }, [open, appVersion, productName, initialDraft]);

  const handleScreenshotFile = async (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    setUploadingScreenshot(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read screenshot.'));
        reader.readAsDataURL(file);
      });
      const compressedDataUrl = await compressScreenshotDataUrlForSheet(dataUrl);
      screenshotDataUrlRef.current = compressedDataUrl;
      const savedUrl = await uploadFeedbackScreenshot(compressedDataUrl, file.name);
      setScreenshotUrl(savedUrl);
    } catch (err: any) {
      setError(err?.message || 'Screenshot upload failed.');
    } finally {
      setUploadingScreenshot(false);
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) void handleScreenshotFile(file);
          break;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open]);

  if (!open) return null;

  const activeProfile: FeedbackProfile = profile || {
    suggestedName: name,
    platform: '',
    architecture: '',
    osLabel: '',
    appVersion,
    productName,
  };

  const canSubmit = Boolean(name.trim() && suggestions.trim());

  const handleClose = () => {
    setError('');
    setSubmitting(false);
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    if (!name.trim() || !suggestions.trim()) {
      setError('Name and suggestions are required.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitFeedbackForm({
        name,
        category,
        suggestions,
        appVersion: activeProfile.appVersion || appVersion,
        platform: activeProfile.platform,
        architecture: activeProfile.architecture,
        osLabel: activeProfile.osLabel,
        websiteUrl,
        videoUrl,
        fontName,
        screenshotUrl,
        screenshotDataUrl: screenshotDataUrlRef.current,
        lastError,
      });
      if (result.ok === false) {
        setError('Unable to submit right now. Please try again.');
        return;
      }
      setSubmittedVersion(result.appVersion || activeProfile.appVersion || appVersion);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const versionLabel = (submittedVersion || appVersion).replace(/^v/i, '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <div className="fade-in max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700">
              {submitted ? <CheckCircle2 className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
            </div>
            <div>
              <h2 id="feedback-title" className="text-xl font-semibold text-zinc-950">
                {submitted ? 'Thank you for your feedback!' : 'Feedback'}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {submitted
                  ? 'Feedback recorded successfully.'
                  : 'Share suggestions or report an issue with auto-filled troubleshooting context.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close feedback form"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {submitted ? (
          <div className="mt-6 space-y-5">
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4 text-sm text-zinc-700">
              <p className="font-medium text-zinc-900">Version</p>
              <p className="mt-1 text-zinc-600">v{versionLabel}</p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-3">
            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Name</span>
              <input
                type="text"
                value={name}
                readOnly
                required
                className="mt-1.5 w-full cursor-default rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Category</span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {FEEDBACK_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Website URL</span>
              <input
                type="url"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://example.com"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Video URL</span>
              <input
                type="url"
                value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://youtube.com/watch?v=..."
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Font Name</span>
              <input
                type="text"
                value={fontName}
                onChange={(event) => setFontName(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Inter, Roboto, etc."
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Screenshot</span>
              <input
                type="text"
                value={screenshotUrl}
                onChange={(event) => {
                  setScreenshotUrl(event.target.value);
                  if (!event.target.value.trim()) screenshotDataUrlRef.current = '';
                }}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Attached automatically after upload"
              />
            </label>

            <div
              className={`rounded-xl border border-dashed px-4 py-4 text-sm transition ${
                dragActive ? 'border-blue-400 bg-blue-50' : 'border-zinc-200 bg-zinc-50'
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const file = event.dataTransfer.files?.[0];
                void handleScreenshotFile(file || null);
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingScreenshot}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  <ImagePlus className="h-4 w-4" />
                  {uploadingScreenshot ? 'Uploading…' : 'Attach Screenshot'}
                </button>
                <span className="text-xs text-zinc-500">Upload, paste, or drag and drop</span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => void handleScreenshotFile(event.target.files?.[0] || null)}
              />
            </div>

            {lastError ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-semibold">Last Error</p>
                <p className="mt-1 whitespace-pre-wrap">{lastError}</p>
              </div>
            ) : null}

            <label className="block">
              <span className="text-sm font-medium text-zinc-800">Suggestions / Description</span>
              <textarea
                value={suggestions}
                onChange={(event) => setSuggestions(event.target.value)}
                required
                rows={5}
                className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="What happened? What would make this better?"
              />
            </label>

            {activeProfile.osLabel || activeProfile.architecture ? (
              <p className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-500 whitespace-pre-line">
                {formatPlatformSummary(activeProfile)}
              </p>
            ) : null}

            {error ? (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
            ) : null}

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={submitting || !canSubmit}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
              >
                {submitting ? 'Sending...' : 'Submit feedback'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
