export const matchesOpenChromeUrl = (candidate: string, target: string) => {
  try {
    return new URL(candidate).href === new URL(target).href;
  } catch {
    return false;
  }
};

export function validateOpenChromeCapture(raw: any, target: string) {
  if (!matchesOpenChromeUrl(String(raw?.url || ''), target)) {
    throw new Error('The Chrome tab navigated during capture. Retry extraction.');
  }
  if (!raw?.ok) throw new Error('Chrome could not capture this page. Check the open tab and retry.');
  return raw;
}
