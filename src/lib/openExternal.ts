import { getDesktopBridge } from './desktopBridge';

export const openExternalUrl = async (url: string) => {
  const target = String(url || '').trim();
  if (!target) return;
  const bridge = getDesktopBridge();
  if (bridge?.openExternalUrl) {
    await bridge.openExternalUrl(target);
    return;
  }
  window.open(target, '_blank', 'noopener,noreferrer');
};
