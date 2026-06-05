import React from 'react';
import { BookOpen, Lock, Scale, ShieldCheck, Terminal, X } from 'lucide-react';

type ResponsibleUseContext = 'firstLaunch' | 'about';

const contextTitle: Record<ResponsibleUseContext, string> = {
  firstLaunch: 'Responsible use',
  about: 'About responsible use',
};

const contextDetail: Record<ResponsibleUseContext, string> = {
  firstLaunch: 'A quick note before you start using the downloader.',
  about: 'How this app is intended to be used.',
};

export function ResponsibleUseInline() {
  return (
    <div className="fade-in mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-medium text-zinc-500">
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
        Use responsibly
      </span>
      <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:inline-block" />
      <span>Please respect creator rights</span>
      <span className="hidden h-1 w-1 rounded-full bg-zinc-300 sm:inline-block" />
      <span>For personal and lawful use only</span>
    </div>
  );
}

export function ResponsibleUseModal({
  open,
  context = 'firstLaunch',
  onClose,
}: {
  open: boolean;
  context?: ResponsibleUseContext;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="responsible-use-title"
    >
      <div className="fade-in max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-emerald-50 p-3 text-emerald-700">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h2 id="responsible-use-title" className="text-xl font-semibold text-zinc-950">
                {contextTitle[context]}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">{contextDetail[context]}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close responsible use notice"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-6 space-y-4 text-sm leading-6 text-zinc-700">
          <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center gap-2 font-semibold text-zinc-950">
              <Scale className="h-4 w-4 text-blue-600" />
              Lawful personal use
            </div>
            <p className="mt-2">
              This application is intended for personal and lawful use only. Users are responsible for complying with
              copyright laws, platform terms of service, and local regulations.
            </p>
            <p className="mt-2">
              Do not use this application to download, reproduce, or distribute copyrighted or protected content without
              proper permission.
            </p>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="flex items-center gap-2 font-semibold text-zinc-950">
              <Lock className="h-4 w-4 text-zinc-700" />
              DRM and protected services
            </div>
            <p className="mt-2">
              This software does not bypass DRM or protected streaming technologies. DRM-protected platforms such as
              Netflix, Prime Video, Disney+, and Hotstar are unsupported.
            </p>
          </section>

          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-emerald-950">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4" />
              Privacy and local processing
            </div>
            <p className="mt-2 text-emerald-800">
              User media is not uploaded to external servers by this app. Extraction and conversion happen locally on
              your machine when possible.
            </p>
          </section>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-zinc-500">This notice appears on first launch.</p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
          >
            I understand
          </button>
        </div>
      </div>
    </div>
  );
}

export function InstallationGuideModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/35 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="installation-guide-title"
    >
      <div className="fade-in max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-zinc-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-blue-50 p-3 text-blue-700">
              <BookOpen className="h-6 w-6" />
            </div>
            <div>
              <h2 id="installation-guide-title" className="text-xl font-semibold text-zinc-950">
                Installation guide
              </h2>
              <p className="mt-1 text-sm text-zinc-500">Set up the local app and optional desktop shell.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close installation guide"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-6 space-y-4 text-sm leading-6 text-zinc-700">
          <section className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center gap-2 font-semibold text-zinc-950">
              <Terminal className="h-4 w-4 text-blue-600" />
              Local setup
            </div>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              <li>Install Node.js from nodejs.org.</li>
              <li>Open this project folder in Terminal or Command Prompt.</li>
              <li>Run <code className="rounded bg-white px-1.5 py-0.5 text-xs font-semibold text-zinc-900">npm install</code>.</li>
              <li>Start the web app with <code className="rounded bg-white px-1.5 py-0.5 text-xs font-semibold text-zinc-900">npm run dev</code>.</li>
              <li>For desktop mode, run <code className="rounded bg-white px-1.5 py-0.5 text-xs font-semibold text-zinc-900">npm start</code>.</li>
            </ol>
          </section>

          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-emerald-950">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4" />
              Protected local fetching
            </div>
            <p className="mt-2 text-emerald-800">
              Asset requests run without browser credentials, referrer data, or app storage attached.
            </p>
          </section>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
