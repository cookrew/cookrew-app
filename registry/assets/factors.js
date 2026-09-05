/* cookrew.dev — identity v2, phase 4: the ladder's screens and the Security rows.
 *
 * Loaded beside site.js on every page that carries the account sheet. It owns
 * three things and nothing else:
 *
 *   W1  the "SIGN IN WITH A PASSKEY" button, and the "one more step" list the
 *       sheet becomes after a 401 second_factor.
 *   M2  the waiting screen for an approval, counting down honestly.
 *   /me the Security rows (add a passkey, add an authenticator) and the list
 *       of sign-ins waiting to be approved, denied or disowned.
 *
 * NOTHING SENSITIVE IS KEPT HERE. The session arrives as an HttpOnly cookie
 * the page cannot read; the pending id lives in a closure for the length of
 * one sheet; the authenticator secret is shown on screen and never stored.
 * Every string that came from another device — a device name, an address — is
 * written with textContent, because the browser asking to sign in chose it.
 */
;(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const toast = (message, ms) => window.cookrewAccount?.toast?.(message, ms)

  /* ── talking to the registry ───────────────────────────────────────────── */
  const api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    let out = null
    try {
      out = res.status === 204 ? {} : await res.json()
    } catch {
      out = null
    }
    return { status: res.status, body: out }
  }
  const said = (out, fallback) => (out.body && out.body.message) || fallback

  /* ── base64url ⇄ bytes, which is all WebAuthn speaks ───────────────────── */
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
  const havePasskeys = () => typeof window.PublicKeyCredential === 'function'

  /* ── small DOM ─────────────────────────────────────────────────────────── */
  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const button = (label, className) => {
    const b = el('button', `btn sm${className ? ` ${className}` : ''}`, label)
    b.type = 'button'
    return b
  }
  /** "1:48" — the countdown M2 shows while a Mac is being asked. */
  const clock = (ms) => {
    const left = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  }

  /* ── the ladder, in the sheet ──────────────────────────────────────────── */

  /** Copy table: one line per rung, recommended first and rescue last. */
  const RUNGS = {
    passkey: { chip: 'PASSKEY', title: 'Touch ID or Face ID', action: 'Use' },
    totp: { chip: 'CODE', title: 'Authenticator app', action: 'Type' },
    approve: { chip: 'APPROVE', title: 'On a device you already use', action: 'Ask' },
    recovery: { chip: 'RESCUE', title: 'A recovery code', action: 'Type' }
  }

  /**
   * Turn the sign-in sheet into the "one more step" list.
   *
   * `step` is the registry's 401: the pending id, the ways this account can
   * finish, and when it stops being possible. Only what the account HAS is
   * listed — a rung nobody can stand on is worse than a shorter ladder.
   */
  function ladder(input) {
    const dialog = input.dialog ?? $('account-sheet')
    if (!dialog) return
    const form = dialog.querySelector('#account-form') ?? dialog
    const step = input.step
    let stop = null
    const done = () => {
      if (stop) clearInterval(stop)
      stop = null
    }
    const say = (text) => {
      const note = $('acct-message')
      if (note) note.textContent = text
    }

    const panel = el('div', 'acct-ladder')
    const show = (nodes, lede) => {
      done()
      panel.replaceChildren()
      panel.append(el('p', 'meta', lede))
      for (const node of nodes) panel.append(node)
      form.replaceChildren(panel)
    }

    const finish = (out) => {
      if (out.status === 201) {
        done()
        dialog.close()
        location.assign('/me')
        return true
      }
      if (out.status === 410) {
        done()
        list(said(out, 'That sign-in was dropped. Start again with your password.'))
        return true
      }
      return false
    }

    /* the list itself */
    function list(note) {
      const rows = []
      for (const factor of step.next) {
        const copy = RUNGS[factor]
        if (!copy) continue
        const row = el('div', 'acct-rung')
        row.append(el('span', 'chip', copy.chip), el('span', 'sp', copy.title))
        const go = button(copy.action, 'primary')
        go.addEventListener('click', () => open(factor))
        row.append(go)
        rows.push(row)
      }
      show(rows, note ?? 'Prove it is you:')
    }

    /* a typed code — the authenticator, or a rescue code */
    function typed(factor) {
      const field = el('input')
      field.className = 'acct-code'
      field.setAttribute('inputmode', factor === 'totp' ? 'numeric' : 'text')
      field.setAttribute('autocomplete', 'one-time-code')
      field.setAttribute('maxlength', factor === 'totp' ? '6' : '20')
      field.placeholder = factor === 'totp' ? '123456' : 'ABCD-EFGH'
      const go = button('Continue', 'primary')
      const back = button('Try another way')
      back.addEventListener('click', () => list())
      const row = el('div', 'row')
      row.append(field, go, back)
      const send = async () => {
        go.disabled = true
        const out = await api('POST', `/v2/sessions/${step.pending}/${factor}`, { code: field.value })
        go.disabled = false
        if (finish(out)) return
        say(said(out, 'That did not go through. Try again.'))
      }
      go.addEventListener('click', () => void send())
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void send()
        }
      })
      show(
        [row],
        factor === 'totp'
          ? 'The six digits your authenticator app is showing now.'
          : 'One of the recovery codes you saved. Each opens the account exactly once.'
      )
      field.focus()
    }

    /* the passkey rung */
    async function passkey() {
      if (!havePasskeys()) {
        say('Passkeys are not available in this browser. Choose another way in.')
        list()
        return
      }
      show([], 'Ask your passkey…')
      const options = await api('GET', `/v2/sessions/${step.pending}/passkey/options`)
      if (options.status !== 200) {
        list(said(options, 'That sign-in was dropped. Start again with your password.'))
        return
      }
      let credential
      try {
        credential = await navigator.credentials.get({
          publicKey: {
            challenge: unb64u(options.body.challenge),
            rpId: options.body.rpId,
            timeout: options.body.timeout,
            userVerification: options.body.userVerification,
            allowCredentials: (options.body.allowCredentials ?? []).map((c) => ({
              type: 'public-key',
              id: unb64u(c.id)
            }))
          }
        })
      } catch {
        list('That passkey was not used. Try another way in.')
        return
      }
      const out = await api('POST', `/v2/sessions/${step.pending}/passkey`, { credential: wireAssertion(credential) })
      if (finish(out)) return
      list(said(out, 'That passkey did not answer for this account.'))
    }

    /* M2 — the waiting screen, honest about what is happening */
    async function approve() {
      show([], 'Asking a device you already use…')
      const asked = await api('POST', `/v2/sessions/${step.pending}/approve`, {})
      if (asked.status !== 202) {
        list(said(asked, 'That sign-in was dropped. Start again with your password.'))
        return
      }
      const until = asked.body.expiresAt ?? step.expiresAt
      const head = el('p', 'acct-asked', 'ASKED YOUR OTHER DEVICE')
      const line = el('p', 'meta')
      const back = button('Try another way')
      back.addEventListener('click', () => list())
      show([head, line, back], 'Approve this sign-in there. It shows this browser and where it is asking from.')
      const tick = () => {
        line.textContent = `Waiting for an approval. Expires in ${clock(until - Date.now())}.`
      }
      tick()
      stop = setInterval(async () => {
        tick()
        const out = await api('GET', `/v2/sessions/${step.pending}`)
        if (out.status === 202) return
        if (finish(out)) return
        list(said(out, 'That sign-in was dropped. Start again with your password.'))
      }, 2000)
    }

    const open = (factor) => {
      if (factor === 'passkey') void passkey()
      else if (factor === 'approve') void approve()
      else typed(factor)
    }

    say(step.message ?? '')
    list()
    // The sheet closing ends the polling with it.
    dialog.addEventListener('close', done, { once: true })
  }

  /** What the registry is handed for an assertion — bytes as base64url. */
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

  /* ── W1: the passkey button, above the username ────────────────────────── */

  async function passwordlessSignIn(status) {
    const options = await api('GET', '/v2/sessions/passkey/options')
    if (options.status !== 200) {
      status(said(options, 'cookrew.dev could not start a passkey sign-in just now.'))
      return
    }
    let credential
    try {
      credential = await navigator.credentials.get({
        publicKey: {
          challenge: unb64u(options.body.challenge),
          rpId: options.body.rpId,
          timeout: options.body.timeout,
          userVerification: options.body.userVerification,
          allowCredentials: []
        }
      })
    } catch {
      status('No passkey was used. Sign in with your username and password instead.')
      return
    }
    const device = await window.cookrewAccount?.device?.()
    const out = await api('POST', '/v2/sessions/passkey', { credential: wireAssertion(credential), device })
    if (out.status === 201) {
      location.assign('/me')
      return
    }
    status(said(out, 'That passkey did not open an account here.'))
  }

  function fitPasskeyButton() {
    const dialog = $('account-sheet')
    const form = dialog?.querySelector('#account-form')
    const tabs = form?.querySelector('.acct-tabs')
    if (!form || !tabs || form.querySelector('[data-passkey-signin]')) return
    if (!havePasskeys()) return
    const go = el('button', 'btn primary acct-passkey', 'Sign in with a passkey')
    go.type = 'button'
    go.dataset.passkeySignin = '1'
    const or = el('p', 'meta', 'or')
    go.addEventListener('click', () => {
      const status = (text) => {
        const note = $('acct-message')
        if (note) note.textContent = text
      }
      status('Ask your passkey…')
      void passwordlessSignIn(status)
    })
    tabs.after(or)
    tabs.after(go)
  }

  /* ── /me: the Security rows ────────────────────────────────────────────── */

  async function addPasskey() {
    if (!havePasskeys()) {
      toast('Passkeys are not available in this browser.', 6000)
      return
    }
    const options = await api('POST', '/v2/me/passkeys/options', {})
    if (options.status !== 200) return toast(said(options, 'That did not go through.'), 6000)
    const name = prompt('Name this passkey (for example "This Mac")', 'This browser')
    if (name === null) return
    let credential
    try {
      credential = await navigator.credentials.create({
        publicKey: {
          challenge: unb64u(options.body.challenge),
          rp: options.body.rp,
          user: {
            id: unb64u(options.body.user.id),
            name: options.body.user.name,
            displayName: options.body.user.displayName
          },
          pubKeyCredParams: options.body.pubKeyCredParams,
          authenticatorSelection: options.body.authenticatorSelection,
          attestation: options.body.attestation,
          timeout: options.body.timeout,
          excludeCredentials: (options.body.excludeCredentials ?? []).map((c) => ({
            type: 'public-key',
            id: unb64u(c.id)
          }))
        }
      })
    } catch {
      toast('No passkey was created.', 5000)
      return
    }
    const out = await api('POST', '/v2/me/passkeys', {
      name,
      credential: {
        id: credential.id,
        rawId: b64u(credential.rawId),
        response: {
          clientDataJSON: b64u(credential.response.clientDataJSON),
          attestationObject: b64u(credential.response.attestationObject)
        }
      }
    })
    if (out.status === 201) location.reload()
    else toast(said(out, 'That passkey was not enrolled.'), 6000)
  }

  async function addTotp() {
    const started = await api('POST', '/v2/me/totp/enrol', {})
    if (started.status !== 201) return toast(said(started, 'That did not go through.'), 6000)
    const box = $('me-totp')
    if (box) {
      box.textContent = `${started.body.secret}\n\n${started.body.otpauth}`
      box.hidden = false
    }
    const code = prompt('Add the secret above to your authenticator app, then type the six digits it shows')
    if (code === null) return
    const out = await api('POST', '/v2/me/totp/confirm', { code })
    if (out.status === 204) location.reload()
    else toast(said(out, 'That code was not the one showing.'), 6000)
  }

  /* ── /me: D6, the approvals waiting for an answer ──────────────────────── */

  function approvalRow(request, refresh) {
    const row = el('li')
    row.append(el('span', 'chip', 'Request'))
    const middle = el('span')
    // The sentence quotes the name the asking device gave itself (see
    // v2-pending.ts). textContent all the way down: that name is a stranger's
    // string, and this is the prompt where the owner decides.
    middle.append(el('b', null, request.sentence ?? 'A device wants to sign in as you.'))
    middle.append(document.createElement('br'))
    middle.append(
      el(
        'span',
        'meta',
        `Started ${clock(Math.max(0, Date.now() - request.at))} ago · ${request.address} · expires in ${clock(request.expiresAt - Date.now())}`
      )
    )
    row.append(middle)
    const answer = async (decision, question) => {
      if (question && !confirm(question)) return
      const out = await api('POST', `/v2/me/approvals/${encodeURIComponent(request.id)}`, { decision })
      if (out.status !== 204) return toast(said(out, 'That request could not be answered.'), 6000)
      if (decision === 'not-me') {
        toast('Every other device is signed out. Change your password now.', 8000)
        location.reload()
        return
      }
      refresh()
    }
    const yes = button('Approve', 'primary')
    yes.addEventListener('click', () => void answer('approve'))
    const no = button('Deny')
    no.addEventListener('click', () => void answer('deny'))
    const never = button('Not me', 'danger')
    never.addEventListener('click', () =>
      void answer(
        'not-me',
        'This signs every other device out and locks the password until you change it. Was this not you?'
      )
    )
    row.append(yes, no, never)
    return row
  }

  function watchApprovals() {
    const list = $('me-approvals')
    if (!list) return
    const draw = async () => {
      const out = await api('GET', '/v2/me/approvals')
      if (out.status !== 200 || !Array.isArray(out.body)) return
      list.replaceChildren()
      if (out.body.length === 0) {
        const none = el('li')
        none.append(el('span', 'meta', 'No device is asking to sign in. Requests appear here for ten minutes.'))
        list.append(none)
        return
      }
      for (const request of out.body) list.append(approvalRow(request, draw))
    }
    void draw()
    setInterval(draw, 5000)
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-add-passkey],[data-add-totp],[data-drop-passkey],[data-drop-totp]')
    if (!target) return
    event.preventDefault()
    if (target.dataset.addPasskey !== undefined) void addPasskey()
    else if (target.dataset.addTotp !== undefined) void addTotp()
    else if (target.dataset.dropPasskey !== undefined) {
      // Taking a factor OFF costs the password, the same as changing it: one
      // session must not be able to lower the account's floor by itself.
      const current = prompt('Your password, to remove this passkey')
      if (current === null) return
      void api('DELETE', `/v2/me/passkeys/${encodeURIComponent(target.dataset.dropPasskey)}`, { current }).then((out) =>
        out.status === 204 ? location.reload() : toast(said(out, 'That passkey was not removed.'), 6000)
      )
    } else if (target.dataset.dropTotp !== undefined) {
      const current = prompt('Your password, to remove the authenticator')
      if (current === null) return
      void api('DELETE', '/v2/me/totp', { current }).then((out) =>
        out.status === 204 ? location.reload() : toast(said(out, 'That did not go through.'), 6000)
      )
    }
  })

  if (!havePasskeys()) {
    for (const row of document.querySelectorAll('[data-passkey-note]')) {
      row.textContent = 'Not available in this browser.'
    }
  }
  fitPasskeyButton()
  watchApprovals()

  window.cookrewFactors = { ladder, addPasskey, addTotp }
})()
