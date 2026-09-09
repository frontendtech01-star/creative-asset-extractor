export const PROXY_COUNTRIES = [
  { code: 'US', label: 'USA' },
  { code: 'NZ', label: 'NZ' },
  { code: 'GB', label: 'UK' },
  { code: 'IN', label: 'India' },
] as const;

export function resolveCountryProxy(country: unknown, env = process.env): string {
  const code = String(country || '').trim().toUpperCase();
  if (!code) return '';
  if (!PROXY_COUNTRIES.some((item) => item.code === code)) {
    throw new Error('Choose USA, NZ, UK, or India for the Chromium proxy.');
  }
  const value = String(env[`EXTRACTION_PROXY_${code}`] || '').trim();
  if (!value) throw new Error(`The ${code} proxy is not configured. Add a real proxy server in the app configuration first.`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`The ${code} proxy configuration is invalid.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
    throw new Error(`The ${code} proxy must be an HTTP or HTTPS proxy URL with a port.`);
  }
  return parsed.href;
}

export function countryProxyStatus(env = process.env) {
  return PROXY_COUNTRIES.map((country) => {
    try {
      resolveCountryProxy(country.code, env);
      return { ...country, configured: true };
    } catch {
      return { ...country, configured: false };
    }
  });
}
