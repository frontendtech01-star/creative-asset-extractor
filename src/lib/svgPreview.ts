/** Resolve standalone SVG CSS values without turning numeric strokes into colors. */
export const resolveSvgVariables = (svg: string) => svg.replace(
  /var\(\s*(--[^,)]+)(?:,\s*([^)]+))?\)/gi,
  (_match, token, fallback) => String(fallback || (/opacity/i.test(token) ? '1' : /width|size/i.test(token) ? '1.5' : '#000000')).trim()
);

export const previewBackground = (pixels: ArrayLike<number>) => {
  let light = 0, visible = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 16) continue;
    visible += 1;
    if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] > 190) light += 1;
  }
  return visible && light / visible > 0.6 ? '#3f3f46' : '#f4f4f5';
};
