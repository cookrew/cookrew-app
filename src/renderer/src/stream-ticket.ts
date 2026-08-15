/**
 * Stream tickets: the credential for the URLs a browser will not let us put a
 * header on.
 *
 * `fetch` carries `Authorization: Bearer …` and always has. EventSource,
 * WebSocket and `<img src>` cannot — the APIs have no header argument — so
 * while /api/* GETs were ungated they simply went out anonymous. Under the v4
 * §4 gate (deny-by-default: every /api/* route needs a known credential) those
 * three surfaces would go dark on a paired phone, which is why §4 sanctions a
 * query token in exactly this position: "query tokens only as one-shot
 * bootstrap/stream tickets".
 *
 * Pure and separate so both the rule and its limits are testable: it appends
 * to whatever query the URL already has, and appends NOTHING when there is no
 * token — a desktop renderer holds none and must not grow an empty `token=`.
 */
export function withStreamToken(url: string, token: string | null | undefined): string {
  if (!token) return url
  const [base, hash = ''] = url.split('#')
  const separator = base.includes('?') ? '&' : '?'
  const suffix = hash ? `#${hash}` : ''
  return `${base}${separator}token=${encodeURIComponent(token)}${suffix}`
}
