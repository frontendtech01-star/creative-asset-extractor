export type ClipboardUrlPayload = {
  url: string;
  source?: 'launch' | 'focus' | 'restore' | 'manual';
};

export type VdxDesktopBridge = {
  isDesktop: true;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (value: string) => Promise<string>;
  getSystemProfile: () => Promise<{ username?: string; displayName?: string }>;
  onClipboardUrl: (callback: (payload: ClipboardUrlPayload) => void) => () => void;
  getAppVersion: () => Promise<string>;
  openExternalUrl: (url: string) => Promise<boolean>;
  openFolderPath: (folderPath: string) => Promise<boolean>;
};

export const getDesktopBridge = (): VdxDesktopBridge | null => {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Window & { vdxDesktop?: VdxDesktopBridge }).vdxDesktop;
  return bridge?.isDesktop ? bridge : null;
};
