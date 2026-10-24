// Safe for browser-side previews and exports. The server also removes literal secrets
// known to the connection, which are deliberately never sent to the browser.
const SENSITIVE =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|x-key|x-api-access-key|x-api-app-key|x-goog-api-key|secret|secret[-_]?key|password|client[-_]?secret|access[-_]?token|refresh[-_]?token)$/i;
export const HIDDEN = '***已隐藏***';

/** A historical mask is not a usable credential: let connection authentication supply it. */
export function omitRedactedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => !/\*\*\*|\[REDACTED\]|\$API_KEY/i.test(value)),
  );
}

function cleanText(text: string): string {
  return text
    .replace(
      /([?&](?:key|api[_-]?key|access[_-]?token|token|secret|signature)=)([^&#\s"']*)/gi,
      (_match, prefix, value) => `${prefix}${/^\$API_KEY$|^%24API_KEY$/i.test(value) ? value : '***'}`,
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@');
}

export function redactSensitive<T>(value: T, headers = false): T {
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE.test(key) || (headers && /^(key|token|signature)$/i.test(key))) {
      const mask = (v: unknown) => (typeof v === 'string' && v.includes('$API_KEY') ? cleanText(v) : HIDDEN);
      out[key] =
        item && typeof item === 'object' && 'enabled' in item && 'value' in item
          ? { ...item, value: mask(item.value) }
          : mask(item);
    } else out[key] = redactSensitive(item, /headers$/i.test(key));
  }
  return out as T;
}
