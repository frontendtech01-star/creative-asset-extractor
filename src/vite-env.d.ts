/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_FORM_ACTION_URL?: string;
  readonly VITE_GOOGLE_FORM_NAME_ENTRY?: string;
  readonly VITE_GOOGLE_FORM_EMAIL_ENTRY?: string;
  readonly VITE_GOOGLE_FORM_SUGGESTIONS_ENTRY?: string;
  readonly VITE_GOOGLE_FORM_APP_VERSION_ENTRY?: string;
  readonly VITE_GOOGLE_FORM_PLATFORM_ENTRY?: string;
  readonly VITE_GITHUB_OWNER?: string;
  readonly VITE_GITHUB_REPO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
