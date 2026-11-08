/* auth.cookrew.dev — the page's toolkit: bytes, WebAuthn's wire shape, and
 * the one DOM builder. Loaded before auth.js, and nothing else uses it.
 *
 * h() puts every string in as text, never as HTML: names and sentences come
 * from the server and the device name is the asker's own word. The icons are
 * constants and the one place markup is parsed.
 */
;(() => {
  'use strict'
  const doc = document

  /* ── base64url ⇄ bytes, exactly as factors.js speaks WebAuthn ──────────── */
  const unb64u = (text) => {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const b64u = (buffer) => {
    let s = ''
    for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const wireAssertion = (credential) => ({
    id: credential.id,
    rawId: b64u(credential.rawId),
    response: {
      clientDataJSON: b64u(credential.response.clientDataJSON),
      authenticatorData: b64u(credential.response.authenticatorData),
      signature: b64u(credential.response.signature),
      ...(credential.response.userHandle ? { userHandle: b64u(credential.response.userHandle) } : {})
    }
  })
  const canPasskey = () => typeof window.PublicKeyCredential === 'function'

  /* ── small DOM ──────────────────────────────────────────────────────────── */
  function h(tag, attrs, ...kids) {
    const node = doc.createElement(tag)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (key === 'class') node.className = value
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    // Strings become text nodes: nothing from the server is ever parsed as HTML.
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') node.append(kid)
    return node
  }

  /** The icons: constants only, the one place markup is parsed. */
  const STROKE = {
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="m7 7 10 10M17 7 7 17"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    code: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M7.5 12h.01M10.5 12h.01M13.5 12h.01M16.5 12h.01" stroke-width="2.4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
    life: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m6 6 3.5 3.5M18 6l-3.5 3.5M6 18l3.5-3.5M18 18l-3.5-3.5"/>',
    arrow: '<path d="m9 6 6 6-6 6"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>'
  }
  const FILLED = {
    github:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    google:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>'
  }
  function svg(name) {
    const markup =
      FILLED[name] ||
      (STROKE[name] &&
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STROKE[name]}</svg>`)
    if (!markup) return null
    const t = doc.createElement('template')
    t.innerHTML = markup
    return t.content.firstChild
  }

  window.cookrewAuthKit = Object.freeze({ unb64u, b64u, wireAssertion, canPasskey, h, svg })
})()
