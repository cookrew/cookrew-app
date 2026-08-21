import { COOKREW_HOME, MKT_INSTALL, fillInstallCopy } from './install-copy'
import { authorLabel, versionLabel } from '../../src/shared/marketplace-copy'

/**
 * THE INSTALL PAGE (A4, R21 Option A).
 *
 * One canonical https URL — https://<registry>/install/<presetId> — with three
 * readers. A canvas browser card intercepts the navigation and hands main a
 * preset id; a phone with Cookrew deep-links it; everybody else gets this page.
 * The third reader is the one this file is for, and it is the one the ruling
 * names: "plain web page without the app".
 *
 * WHAT IT IS NOT, and both are enforced below rather than promised.
 *
 * Not a review sheet. The manifest, the signature and the scrub report are for
 * a client that fetched and checked them ITSELF (A5). A registry page showing
 * them would be asking to be believed about its own bytes, which is the trust
 * the whole signing design refuses to require. So the page names the preset and
 * stops: name, author, version — the same facts search already serves ungated.
 *
 * Not an installer. There is no script, no form and no handler attribute on
 * this page, and its CSP forbids all three. "A page can never express
 * install-without-asking" then holds because the page has no way to express
 * anything at all — it is a document.
 */

export interface InstallPageView {
  kind: 'preset' | 'unknown'
  name?: string
  author?: string
  version?: number
  /** Identified presets need an account before the manifest is served. */
  gated?: boolean
  /** The origin to build the canonical link from, or null to omit the link. */
  origin?: string | null
  id?: string
}

/**
 * Escape for HTML text AND for a double-quoted attribute — one function,
 * because two would eventually be used in the wrong place. Preset names and
 * author handles are chosen by publishers, so every one of them is untrusted
 * input that reaches a document.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** host[:port], and nothing else. Ports are 1–65535, spelled plainly. */
const HOST = /^[a-z0-9]([a-z0-9.-]{0,252}[a-z0-9])?(:[0-9]{1,5})?$/i
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * The origin a canonical link may be built from, or null.
 *
 * The Host header is chosen by whoever sent the request, so it is the classic
 * way to poison a page into advertising somebody else's URL. Escaping it would
 * make it safe to RENDER while leaving it wrong to PUBLISH, so anything that is
 * not a plain host[:port] produces no link at all — the page loses a line and
 * keeps its meaning, which is the right way round.
 */
export function originOf(hostHeader: string | undefined): string | null {
  if (typeof hostHeader !== 'string' || !HOST.test(hostHeader)) return null
  const [hostname, port] = hostHeader.split(':')
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null
  // https everywhere except loopback, where the dev registry lives and there is
  // no network in between. Same rule, same reason, as the app's recogniser.
  const scheme = LOOPBACK.has(hostname.toLowerCase()) ? 'http' : 'https'
  return `${scheme}://${hostHeader}`
}

/** The canonical link for a preset — the exact shape the app recognises. */
export function canonicalInstallUrl(origin: string, presetId: string): string {
  return `${origin}/install/${presetId}`
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1a1a1a; --dim: #6b6b6b; --bg: #fbfaf8; --line: #e4e1dc; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #ececec; --dim: #9a9a9a; --bg: #171717; --line: #2e2e2e; }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; justify-content: center;
}
main { width: 100%; max-width: 34rem; }
h1 { font-size: 1.6rem; line-height: 1.2; margin: 0 0 .35rem; overflow-wrap: anywhere; }
.byline { color: var(--dim); margin: 0 0 1.75rem; overflow-wrap: anywhere; }
.lede { margin: 0 0 1.75rem; }
.note { color: var(--dim); font-size: .9rem; }
.gated { border-left: 3px solid var(--line); padding-left: .85rem; margin: 1.75rem 0; }
code {
  display: block; padding: .7rem .85rem; margin: .5rem 0 1.75rem;
  border: 1px solid var(--line); border-radius: 8px;
  font: .85rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere; user-select: all;
}
footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
a { color: inherit; }
`.trim()

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

function unknownPage(): string {
  const title = MKT_INSTALL['mkt.install.unknown.title']
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(MKT_INSTALL['mkt.install.unknown.body'])}</p>
<footer><p class="note">${escapeHtml(MKT_INSTALL['mkt.install.noapp'])}
<a href="${COOKREW_HOME}">${escapeHtml(COOKREW_HOME)}</a></p></footer>`
  )
}

/**
 * Build the page. Every publisher-controlled value goes through escapeHtml on
 * its way in; the copy is ours and still goes through it, because a rule with
 * an exception is a rule someone forgets.
 */
export function installPageHtml(view: InstallPageView): string {
  if (view.kind === 'unknown') return unknownPage()

  const name = view.name ?? ''
  const title = fillInstallCopy(MKT_INSTALL['mkt.install.title'], { presetName: name })
  const byline = fillInstallCopy(MKT_INSTALL['mkt.install.byline'], {
    author: authorLabel(view.author ?? ''),
    version: versionLabel(view.version ?? 0)
  })
  // No link at all when the host could not be trusted: a page that quietly
  // drops one line still says the true thing, and a page that publishes an
  // attacker's origin does not.
  const link =
    view.origin != null && view.id != null
      ? `<p>${escapeHtml(MKT_INSTALL['mkt.install.howto'])}</p>
<code>${escapeHtml(canonicalInstallUrl(view.origin, view.id))}</code>`
      : ''
  const gated =
    view.gated === true
      ? `<p class="gated">${escapeHtml(MKT_INSTALL['mkt.install.gated.note'])}</p>`
      : ''

  return page(
    name,
    `<h1>${escapeHtml(title)}</h1>
<p class="byline">${escapeHtml(byline)}</p>
<p class="lede">${escapeHtml(MKT_INSTALL['mkt.install.lede'])}</p>
${gated}${link}
<p class="note">${escapeHtml(MKT_INSTALL['mkt.install.review.note'])}</p>
<footer><p class="note">${escapeHtml(MKT_INSTALL['mkt.install.noapp'])}
<a href="${COOKREW_HOME}">${escapeHtml(COOKREW_HOME)}</a></p></footer>`
  )
}
