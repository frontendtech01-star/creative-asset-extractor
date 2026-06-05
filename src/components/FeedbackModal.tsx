import React, { useEffect, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { submitFeedbackForm } from '../lib/feedbackSubmit';

const successMessageForMode = (mode?: string, fallback?: boolean) => {
  if (mode === 'sheet') {
    return fallback
      ? 'Thanks! Your feedback was saved locally because the Google Sheet webhook failed.'
      : 'Thanks! Your feedback has been added to the shared sheet.';
  }
  if (mode === 'google-form') {
    return 'Thanks! Your feedback has been submitted.';
  }
  return 'Thanks! Your feedback was saved to the local inbox on this computer.';
};

export function FeedbackModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [suggestions, setSuggestions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSuggestions('');
    setSubmitting(false);
    setMessage(null);
  }, [open]);

  if (!open) return null;

  const canSubmit = Boolean(name.trim() && suggestions.trim());

  const handleClose = () => {
    setMessage(null);
    setSubmitting(false);
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (!canSubmit) {
      setMessage({ type: 'error', text: 'Name and suggestions are required.' });
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitFeedbackForm(name, suggestions);
      if (result.ok === false) {
        setMessage({ type: 'error', text: 'Unable to submit right now. Please try again.' });
        return;
      }
      setMessage({
        type: 'success',
        text: successMessageForMode(result.mode, result.fallback),
      });
      setName('');
      setSuggestions('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <div className="fade-in w-full max-w-lg rounded-3xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700">
              <MessageSquare className="h-6 w-6" />
            </div>
            <div>
              <h2 id="feedback-title" className="text-xl font-semibold text-zinc-950">
                Feedback
              </h2>
              <p className="mt-1 text-sm text-zinc-500">Share suggestions to help improve the app.</p>
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

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-zinc-800">Name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your name"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-zinc-800">Suggestions</span>
            <textarea
              value={suggestions}
              onChange={(event) => setSuggestions(event.target.value)}
              required
              rows={5}
              className="mt-1.5 w-full rounded-xl border border-zinc-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="What would make this app better?"
            />
          </label>

          {message ? (
            <p
              className={`rounded-xl px-3 py-2 text-sm ${
                message.type === 'success'
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-red-50 text-red-800'
              }`}
            >
              {message.text}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={submitting || !canSubmit}
              className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
            >
              {submitting ? 'Sending...' : 'Submit feedback'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
