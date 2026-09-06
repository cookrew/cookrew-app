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
    /**
     * THE LADDER CARRIES ITS OWN PLACE TO SPEAK.
     *
     * `show()` replaces the form's children, which DETACHES site.js's
     * `#acct-message` — so every refusal written there after the first screen
     * went into a node the document no longer held, and a wrong code looked
     * exactly like a button that did nothing. This line is part of the panel,
     * so it is on screen for as long as the ladder is; site.js's own line is
     * still used for the moment before the first screen is drawn.
     */
    const message = el('p', 'meta acct-said')
    message.setAttribute('role', 'status')
    const say = (text) => {
      const note = message.isConnected ? message : $('acct-message')
      if (note) note.textContent = text
    }

    /**
     * What the sheet was before the ladder took it over. Put back when the
     * dialog closes, so the next open is a sign-in form rather than the last
     * screen of a sign-in somebody walked away from — and so site.js's own
     * handlers find their fields again.
     */
    const original = [...form.children]
    const restore = () => {
      done()
      if (original.length > 0) form.replaceChildren(...original)
    }

    const panel = el('div', 'acct-ladder')
    const show = (nodes, lede) => {
      done()
      message.textContent = ''
      panel.replaceChildren()
      panel.append(el('p', 'meta', lede))
      for (const node of nodes) panel.append(node)
      panel.append(message)
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
      /**
       * "ASKED YOUR OTHER DEVICE", not the mock's "ASKED YOUR MAC" — a
       * decision, recorded here where the copy lives.
       *
       * Naming the device would mean the registry telling a caller which
       * devices an account has BEFORE that caller has proved anything but a
       * password. Somebody who has phished a password would read back the
       * shape of the person's life ("MacBook Pro", "Mira's iPhone") from a
       * screen designed to protect them. The owner sees the name on their own
       * side, where they are signed in and it is theirs to see.
       */
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

    // The registry's own sentence is the first thing on the screen — "One more
    // step. Prove it is you." — rather than a line written under a heading
    // that says the same thing twice.
    list(step.message ?? undefined)
    // The sheet closing ends the polling with it, and gives the form back.
    dialog.addEventListener('close', restore, { once: true })
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

  /**
   * THE QR, AS ONE SVG PATH.
   *
   * `rows` are the registry's own '0'/'1' strings — the same shape the desktop
   * sheet draws. Drawn as a single path of unit squares in module coordinates
   * and scaled by the viewBox, so it is crisp at any size instead of a bitmap
   * that a phone camera has to guess at; `crispEdges` keeps the module grid
   * off the anti-aliaser. The QUIET ZONE is four modules on every side and it
   * is not decoration: a scanner needs it to find the symbol at all.
   */
  const QUIET = 4
  function qrSvg(rows) {
    const modules = rows.length
    if (modules === 0) return null
    const span = modules + QUIET * 2
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', `0 0 ${span} ${span}`)
    svg.setAttribute('width', '220')
    svg.setAttribute('height', '220')
    svg.setAttribute('shape-rendering', 'crispEdges')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', 'Scan this with your authenticator app')
    svg.dataset.modules = String(modules)
    const paper = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    paper.setAttribute('width', String(span))
    paper.setAttribute('height', String(span))
    paper.setAttribute('fill', '#fff')
    const dark = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    let d = ''
    for (let row = 0; row < modules; row++) {
      const line = rows[row]
      for (let col = 0; col < line.length; col++) {
        if (line[col] === '1') d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`
      }
    }
    dark.setAttribute('d', d)
    // Ink, not currentColor: a QR read off a screen in dark mode is a QR that
    // has to stay dark-on-white whatever the page around it is doing.
    dark.setAttribute('fill', '#14110a')
    svg.append(paper, dark)
    return svg
  }

  /**
   * ADD AN AUTHENTICATOR — scan, then verify, in the page.
   *
   * The owner's note: /me must do what the desktop sheet does. It used to be
   * two `prompt()` boxes with the secret as text, which is unscannable and
   * asks a person to type 32 characters from a dialog they cannot copy from.
   *
   * NOTHING IS ENROLLED UNTIL A CODE COMES BACK. The secret lives in this
   * closure and on the account as an INACTIVE record; CANCEL just drops the
   * panel, and the next ADD replaces it server-side. Only `confirm` makes it
   * a factor, and only then does the row change.
   */
  async function addTotp() {
    const panel = $('me-totp')
    if (!panel) return
    const started = await api('POST', '/v2/me/totp/enrol', {})
    if (started.status !== 201) return toast(said(started, 'That did not go through.'), 6000)
    const { secret, otpauth, qr } = started.body

    panel.replaceChildren()
    panel.hidden = false
    panel.append(el('p', 'meta', 'Scan this with your authenticator app, then type the six digits it shows.'))
    const picture = qrSvg(Array.isArray(qr) ? qr : [])
    if (picture) panel.append(picture)

    // The secret as selectable text, for a phone that cannot scan a screen it
    // is standing in front of — and the URL for an app that takes one.
    const typed = el('p', 'meta')
    typed.append(document.createTextNode('or type this secret: '))
    typed.append(el('code', 'totp-secret', secret))
    panel.append(typed)
    const link = el('a', 'meta totp-link', otpauth)
    link.setAttribute('href', otpauth)
    link.setAttribute('rel', 'noreferrer')
    panel.append(link)

    const field = el('input')
    field.className = 'acct-code'
    field.setAttribute('inputmode', 'numeric')
    field.setAttribute('autocomplete', 'one-time-code')
    field.setAttribute('maxlength', '6')
    field.placeholder = '123456'
    const verify = button('Verify', 'primary')
    const cancel = button('Cancel')
    const row = el('div', 'row')
    row.append(field, verify, cancel)
    const message = el('p', 'meta totp-said')
    message.setAttribute('role', 'status')
    panel.append(row, message)
    field.focus()

    const close = () => {
      panel.replaceChildren()
      panel.hidden = true
    }
    cancel.addEventListener('click', close)

    const send = async () => {
      verify.disabled = true
      const out = await api('POST', '/v2/me/totp/confirm', { code: field.value })
      verify.disabled = false
      if (out.status !== 204) {
        // The registry's own sentence, under the field where it was typed.
        message.textContent = said(out, 'That code was not the one showing.')
        field.focus()
        return
      }
      close()
      activateTotpRow()
    }
    verify.addEventListener('click', () => void send())
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void send()
      }
    })
  }

  /**
   * The row becomes what the server would now render for it — in place, rather
   * than by reloading the page under somebody who has just typed six digits.
   * The sentence is the one site-account.ts writes, so the two agree.
   */
  function activateTotpRow() {
    const row = $('me-totp-row')
    if (!row) return
    const note = $('me-totp-note')
    if (note) note.textContent = 'Six digits, every thirty seconds. Asked for on a device this account has not seen.'
    const add = row.querySelector('[data-add-totp]')
    if (!add) return
    const remove = button('Remove', 'danger')
    remove.dataset.dropTotp = '1'
    add.remove()
    row.append(remove)
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
