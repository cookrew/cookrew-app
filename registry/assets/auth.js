/* auth.cookrew.dev — the sign-in page's one script.
 *
 * The document (registry/src/auth-page.ts) is a frame with an empty card; this
 * draws every screen in it from what the registry says about the request:
 * who is asking, then sign in / create / a provider trip, the second-factor
 * ladder, recovery codes, and the way back to whichever client asked.
 *
 * WHAT THIS SCRIPT NEVER DOES. It never sends a device (the server takes the
 * device from the request), never sees a session token (success is a handoff
 * URL carrying a one-use code), and never writes a server string as HTML:
 * every name, sentence and code goes in as text, because the device name in
 * particular is the asker's own word.
 */
;(() => {
  'use strict'
  const doc = document
  const body = doc.body
  const HEADER = 'x-cookrew-auth-request'
  const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
  const NET = 'Cookrew could not be reached. Check your connection and try again.'
  const query = new URLSearchParams(location.search)
  const $screen = doc.getElementById('screen')
  const $who = doc.getElementById('who')

  /** A URL the page may navigate to: any scheme but the ones that run or embed content. */
  const safe = (url) =>
    typeof url === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(javascript|data|vbscript|blob|file):/i.test(url)
  const PRODUCT = safe(body.dataset.product) ? body.dataset.product : 'https://cookrew.dev'
  const LEGAL = body.dataset.legal === '1'

  let request = query.get('request')
  let summary = null
  /** The request reached an end (success, cancel, denial, expiry): the clock stops watching. */
  let over = false
  /** Server time minus ours, from the Date header, so a skewed clock does not expire a live sign-in. */
  let skew = 0
  const now = () => Date.now() + skew

  /* ── talking to the auth origin ─────────────────────────────────────────── */
  async function call(method, path, payload, bare) {
    const headers = { accept: 'application/json' }
    if (payload !== undefined) headers['content-type'] = 'application/json'
    if (!bare && request) headers[HEADER] = request
    let res
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: payload === undefined ? undefined : JSON.stringify(payload)
      })
    } catch {
      return { status: 0, body: {} }
    }
    const date = Date.parse(res.headers.get('date') || '')
    if (!Number.isNaN(date)) skew = date - Date.now()
    let data = {}
    if (method !== 'HEAD' && res.status !== 204) {
      try {
        data = (await res.json()) || {}
      } catch {
        data = {}
      }
    }
    return { status: res.status, body: data }
  }

  const { unb64u, b64u, wireAssertion, canPasskey, h, svg } = window.cookrewAuthKit

  const button = (label, cls, onclick, icon) =>
    h('button', { type: 'button', class: `btn${cls ? ` ${cls}` : ''}`, onclick }, icon ? svg(icon) : null, label)
  const go = (label, href, cls) => (safe(href) ? h('a', { class: `btn${cls ? ` ${cls}` : ''}`, href }, label) : null)
  const link = (label, onclick) => h('button', { type: 'button', class: 'link', onclick }, label)
  const links = (...kids) => h('div', { class: 'links' }, ...kids)
  const badge = (icon, no) => h('span', { class: `badge${no ? ' no' : ''}`, 'aria-hidden': 'true' }, svg(icon))
  const head = (kicker, title, lede) => [
    kicker ? h('p', { class: 'k' }, kicker) : null,
    h('h2', { tabindex: '-1' }, title),
    lede ? h('p', { class: 'lede' }, lede) : null
  ]
  function sayer() {
    const said = h('p', { class: 'said', role: 'status' })
    const say = (text, calm) => {
      said.textContent = text || ''
      said.classList.toggle('calm', Boolean(calm))
    }
    return { said, say }
  }
  function field(label, attrs, hint) {
    const input = h('input', { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs })
    const chip = h('em', { class: 'chip', hidden: true })
    return { input, chip, row: h('label', { class: 'fld' }, h('span', null, label, chip), input, hint ? h('small', null, hint) : null) }
  }
  /** A form the script handles: Enter submits, nothing navigates (and CSP form-action 'none' agrees). */
  const form = (kids, onsubmit) =>
    h('form', { novalidate: true, onsubmit: (event) => (event.preventDefault(), onsubmit()) }, ...kids)
  /** A form's one submit button, busy while its call is out. */
  function submitter(label, cls, work) {
    const send = button(label, cls, null)
    send.type = 'submit'
    return { send, submit: () => busy(send, work) }
  }
  /** One press at a time: the button says it is working until the call answers. */
  async function busy(btn, work) {
    if (btn.getAttribute('aria-busy') === 'true') return
    btn.setAttribute('aria-busy', 'true')
    try {
      await work()
    } finally {
      btn.removeAttribute('aria-busy')
    }
  }
  const clock = (ms) => {
    const left = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  }

  /* ── one screen at a time ───────────────────────────────────────────────── */
  let epoch = 0
  let cleanups = []
  /** Replace the card's screen; returns `live()`, false once another screen has replaced it. */
  function screen(nodes) {
    for (const stop of cleanups) stop()
    cleanups = []
    const mine = ++epoch
    $screen.replaceChildren(...nodes.flat().filter(Boolean))
    const target = $screen.querySelector('[data-focus]') || $screen.querySelector('h2')
    if (target) target.focus({ preventScroll: true })
    if ($screen.getBoundingClientRect().top < 0) $screen.parentElement.scrollIntoView()
    return () => epoch === mine
  }
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms)
    cleanups.push(() => clearTimeout(t))
  }
  const every = (fn, ms) => {
    const t = setInterval(fn, ms)
    cleanups.push(() => clearInterval(t))
  }

  /* ── who is asking, above every screen ──────────────────────────────────── */
  const PROVIDER_HOST = { github: 'github.com', google: 'accounts.google.com' }
  function label(id) {
    const named = summary && (summary.providers || []).find((p) => p.id === id)
    return named ? named.label : id === 'github' ? 'GitHub' : id === 'google' ? 'Google' : 'the provider'
  }
  const host = (id) => PROVIDER_HOST[id] || label(id)
  const kindOf = (client) => (client === 'cli' ? 'cli' : client === 'desktop' ? 'desktop' : 'web')
  const from = () => (summary ? summary.clientLabel : 'where you began')

  function drawWho() {
    const s = summary
    const kind = kindOf(s.client)
    const device = s.device && s.device.name ? `Asked from “${s.device.name}”` : 'Asked from a new device'
    const back = s.client === 'web' && s.returnHost ? ` · returns to ${s.returnHost}` : ''
    // The hero already draws web, desktop and terminal; the card borrows that drawing.
    const way = doc.querySelector(`.ways [data-way="${kind}"]`)
    $who.replaceChildren(
      h('span', { class: 'ico', 'aria-hidden': 'true' }, way ? way.firstChild.cloneNode(true) : null),
      h(
        'div',
        null,
        h('b', null, s.clientLabel || 'Cookrew'),
        h('small', null, device + back),
        s.userCode ? h('span', { class: 'ucode' }, 'Code', h('span', null, s.userCode), 'matches your terminal?') : null
      )
    )
    $who.hidden = false
    if (way) way.classList.add('on')
  }

  /* ── what any answer means ──────────────────────────────────────────────── */
  function outcome(out, say, fallback) {
    const b = out.body || {}
    if (out.status === 0) return say(NET)
    if (out.status < 300 && b.status === 'authorized') return success(b)
    if (out.status < 300 && b.status === 'new') return chooseName(b)
    if (out.status < 300 && b.status === 'cancelled') return cancelled(b)
    if (out.status < 300 && b.status === 'ready') return setEnrol(b.enrol), first()
    if (out.status === 401 && b.error === 'second_factor') return ladder(b)
    if (out.status === 403 && b.error === 'second_step_setup' && b.pending) return setupChoose(b)
    if (out.status === 410 && b.error === 'denied') return denied(false)
    if (out.status === 410 && b.error === 'expired') return expired()
    return say(
      b.message || (out.status === 429 ? 'Too many tries. Wait a minute, then try again.' : fallback || 'That did not go through. Try again.')
    )
  }

  /* ── opening the page ───────────────────────────────────────────────────── */
  async function boot() {
    // A terminal's code is always typed here: a code carried in a link is a
    // code somebody else could have sent.
    if (!request) return body.dataset.path === '/device' ? enterCode('') : nothing()
    const out = await call('POST', '/auth/api/claim', { request }, true)
    const b = out.body
    if (out.status === 200 && b.request) return opened(b)
    if (out.status === 409) return claimed()
    if (out.status === 403 && b.error === 'use_code') return enterCode('')
    if (out.status === 410) return expired()
    if (out.status === 404) return unknown()
    if (out.status === 0) return unreachable(boot)
    return problem(b.message || 'This sign-in could not be opened.')
  }

  function opened(s) {
    summary = s
    request = s.request
    drawWho()
    const back = query.get('continue') === '1'
    const refused = query.get('denied') === '1'
    // A reload must not replay a provider's answer: the URL keeps the request and nothing else.
    if (back || refused) history.replaceState(null, '', `${location.pathname}?request=${encodeURIComponent(request)}`)
    // The server's word outranks the URL's: a request it has closed cannot be retried.
    if (s.stage === 'denied') return denied(false)
    if (refused) return denied(true)
    if (s.stage === 'done') return finishedElsewhere()
    if (back || s.stage === 'provider') return resume()
    return first()
  }

  /* A passkey request's screens live in auth-enrol.js; these are the page's parts it borrows. */
  const passkeyIntent = () => Boolean(summary && summary.intent === 'passkey')
  const what = () => (passkeyIntent() ? 'request' : 'sign-in')
  const setEnrol = (enrol) => (summary = { ...summary, enrol: enrol || null })
  const enrolUi = () => ({ call, screen, head, button, sayer, field, form, submitter, busy, badge, links, notNow, outcome, toProvider, label, setEnrol, first, summary: () => summary })

  function first(note) {
    const intent = summary.intent
    if (intent === 'passkey') return window.cookrewAuthEnrol.start(enrolUi(), note)
    if (intent === 'link') return linkScreen(note)
    if (intent === 'github' || intent === 'google') return providerScreen(intent, note)
    if (intent === 'create') return create(note)
    return signIn(note)
  }

  /** A provider trip came back: ask the server what it said. */
  async function resume() {
    const live = screen([...head(null, 'Finishing up…', null), h('p', { class: 'wait' }, `Checking what ${label(summary.provider || summary.intent)} said.`)])
    const out = await call('POST', '/auth/api/continue', {})
    if (!live()) return
    if (out.status === 0) return unreachable(resume)
    return outcome(out, (text) => first(text), 'That did not finish. Try again.')
  }

  /* ── /device: the code from a terminal ──────────────────────────────────── */
  const tidyCode = (raw) => {
    const letters = String(raw).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)
    return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters
  }
  function enterCode(prefill) {
    const { said, say } = sayer()
    const code = field('Code', {
      class: 'code',
      value: tidyCode(prefill),
      maxlength: '9',
      autocomplete: 'one-time-code',
      autocapitalize: 'characters',
      placeholder: 'XXXX-XXXX',
      'data-focus': !prefill
    })
    code.input.addEventListener('input', () => {
      const tidy = tidyCode(code.input.value)
      if (tidy !== code.input.value) code.input.value = tidy
    })
    const { send, submit } = submitter('Continue', 'primary', async () => {
      const value = code.input.value
      if (value.length !== 9) return say('The code is eight letters, like BCDF-GHJK.')
      const out = await call('POST', '/auth/api/device', { code: value }, true)
      const b = out.body
      if (out.status === 200 && b.request) {
        history.replaceState(null, '', `${location.pathname}?request=${encodeURIComponent(b.request)}`)
        return opened(b)
      }
      if (out.status === 0) return say(NET)
      if (out.status === 429) return say(b.message || 'Too many tries. Wait a minute, then try again.')
      return say(b.message || 'That code is not right, or it has run out. Check your terminal and try again.')
    })
    screen([
      ...head('cookrew login', 'Enter the code shown in your terminal.', 'It connects this browser to the terminal that asked. Only enter a code you started yourself.'),
      form([code.row, send, said], submit),
      links(h('span', null, 'Not using a terminal? ', h('a', { href: `${PRODUCT}/` }, 'Go to cookrew.dev')))
    ])
    if (prefill) say('Check that this matches your terminal, then continue.', true)
  }

  /* ── sign in ────────────────────────────────────────────────────────────── */
  function providerButtons(say) {
    const list = (summary.providers || []).filter((p) => p && p.id)
    if (list.length === 0) return null
    return h(
      'div',
      { class: 'pair' },
      list.map((p) => {
        const b = button(p.label || label(p.id), '', () => busy(b, () => toProvider(p.id, say)), p.id)
        return b
      })
    )
  }

  async function toProvider(id, say) {
    const out = await call('POST', `/v2/oauth/${encodeURIComponent(id)}/start`, {})
    if (out.status === 201 && safe(out.body.authorizeUrl)) {
      say(`Taking you to ${host(id)}…`, true)
      location.assign(out.body.authorizeUrl)
      // Stay busy until the page goes; a second press would start a second trip.
      return new Promise(() => {})
    }
    return outcome(out, say)
  }

  function signIn(note) {
    const { said, say } = sayer()
    const prefill = summary.username || ''
    const user = field('Username', { name: 'username', autocomplete: 'username', maxlength: '32', value: prefill, 'data-focus': !prefill })
    const pass = field('Password', { type: 'password', name: 'password', autocomplete: 'current-password', maxlength: '256', 'data-focus': Boolean(prefill) })
    const passkey = canPasskey() ? button('Sign in with a passkey', 'primary', () => passkeyScreen(null), 'key') : null
    const providers = providerButtons(say)
    const { send, submit } = submitter('Sign in', passkey ? '' : 'primary', async () => {
      const username = user.input.value.trim().toLowerCase()
      const password = pass.input.value
      if (!username || !password) return say('Type your username and your password.')
      return outcome(await call('POST', '/v2/sessions', { username, password }), say, 'That username and password do not match.')
    })
    screen([
      ...head(null, 'Welcome back.', 'One account for every place you work.'),
      passkey,
      providers,
      passkey || providers ? h('p', { class: 'or' }, 'or use your password') : null,
      form([user.row, pass.row, send, said], submit),
      links(h('span', null, 'New to Cookrew? ', link('Create an account', () => create())), link('Can’t sign in?', () => recover())),
      links(notNow())
    ])
    if (note) say(note)
  }

  /* ── create ─────────────────────────────────────────────────────────────── */
  /** The name field's chip: is it free? Asked as they type, a moment after they stop. */
  function availability(name) {
    let timer = 0
    const mark = (text, ok) => {
      name.chip.textContent = text || ''
      name.chip.className = `chip ${ok ? 'ok' : 'no'}`
      name.chip.hidden = !text
    }
    const check = async () => {
      const value = name.input.value.trim()
      if (!value) return mark('')
      if (!USERNAME.test(value)) return mark('not allowed', false)
      const out = await call('HEAD', `/v2/accounts/${encodeURIComponent(value)}`)
      if (name.input.value.trim() !== value) return undefined
      if (out.status === 404) return mark('free', true)
      if (out.status === 200) return mark('taken', false)
      if (out.status === 410) return mark('unavailable', false)
      return mark('')
    }
    name.input.addEventListener('input', () => {
      const lower = name.input.value.toLowerCase()
      if (lower !== name.input.value) name.input.value = lower
      clearTimeout(timer)
      timer = setTimeout(check, 350)
    })
    cleanups.push(() => clearTimeout(timer))
    return mark
  }
  const nameRule = (username) =>
    USERNAME.test(username) ? '' : 'A username is lowercase letters, digits and dashes, up to 32, starting and ending with a letter or digit.'

  function create(note) {
    const { said, say } = sayer()
    const user = field('Username', { name: 'username', autocomplete: 'username', maxlength: '32', 'data-focus': true }, 'Lowercase letters, digits and dashes. This is how people find you.')
    const pass = field('Password', { type: 'password', autocomplete: 'new-password', maxlength: '256' }, '12 characters or more. A sentence works well.')
    const again = field('Confirm password', { type: 'password', autocomplete: 'new-password', maxlength: '256' })
    const providers = providerButtons(say)
    const { send, submit } = submitter('Create account', 'primary', async () => {
      const username = user.input.value.trim().toLowerCase()
      const password = pass.input.value
      const problemWith =
        nameRule(username) ||
        (password.length < 12 ? 'Use 12 characters or more for the password.' : '') ||
        (again.input.value !== password ? 'The two passwords do not match yet.' : '')
      if (problemWith) return say(problemWith)
      return outcome(await call('POST', '/v2/accounts', { username, password }), say)
    })
    const terms = LEGAL
      ? h(
          'p',
          { class: 'note' },
          'By creating an account you agree to the ',
          h('a', { href: `${PRODUCT}/terms`, target: '_blank', rel: 'noopener' }, 'Terms'),
          ' and the ',
          h('a', { href: `${PRODUCT}/privacy`, target: '_blank', rel: 'noopener' }, 'Privacy Policy'),
          '.'
        )
      : null
    screen([
      ...head(null, 'A place for your work.', 'Create a Cookrew account. You choose its name.'),
      providers,
      providers ? h('p', { class: 'or' }, 'or choose a name and password') : null,
      form([user.row, pass.row, again.row, send, said], submit),
      terms,
      links(h('span', null, 'Already have an account? ', link('Sign in', () => signIn())), notNow())
    ])
    availability(user)
    if (note) say(note)
  }

  /* ── a provider, as the first screen; and linking one ───────────────────── */
  function providerScreen(id, note) {
    const { said, say } = sayer()
    const lbl = label(id)
    const send = button(`Continue to ${lbl}`, 'primary', () => busy(send, () => toProvider(id, say)), id)
    screen([
      ...head(null, `Continue with ${lbl}.`, `You confirm on ${host(id)} and come straight back here. Cookrew never sees your ${lbl} password.`),
      send,
      said,
      h('p', { class: 'note' }, `New to Cookrew? You choose your Cookrew name next. A ${lbl} email never joins two accounts.`),
      links(link('Use another way', () => signIn()), notNow())
    ])
    if (note) say(note)
  }

  function linkScreen(note) {
    const { said, say } = sayer()
    const id = summary.provider
    const lbl = label(id)
    const user = summary.username || ''
    const send = button(`Continue to ${lbl}`, 'primary', () => busy(send, () => toProvider(id, say)), id)
    screen([
      h('span', { class: 'badge av', 'aria-hidden': 'true' }, (user[0] || '?').toUpperCase()),
      ...head('Link an account', `Link ${lbl} to @${user}.`, `After you confirm on ${host(id)}, ${lbl} becomes one more way into this account. Nothing else changes.`),
      send,
      said,
      links(notNow())
    ])
    if (note) say(note)
  }

  /* ── passkey: on its own, or as a rung of the ladder ────────────────────── */
  async function passkeyScreen(step) {
    const { said, say } = sayer()
    const waiting = h('p', { class: 'wait' }, 'Waiting for your passkey…')
    const retry = button('Try again', 'primary', () => passkeyScreen(step), 'key')
    retry.hidden = true
    const stop = new AbortController()
    const live = screen([
      badge('key'),
      ...head(step ? 'Two-step verification' : null, 'Use your passkey.', 'Your browser will ask for Touch ID, Face ID, Windows Hello or a security key.'),
      waiting,
      retry,
      said,
      links(link('Use another way', () => (step ? ladder(step) : signIn())), notNow())
    ])
    cleanups.push(() => stop.abort())
    const failed = (text) => {
      if (!live()) return
      waiting.hidden = true
      retry.hidden = false
      say(text)
    }
    if (!canPasskey()) return failed('Passkeys are not available in this browser. Use another way in.')
    const base = step ? `/v2/sessions/${encodeURIComponent(step.pending)}/passkey` : '/v2/sessions/passkey'
    const options = await call('GET', `${base}/options`)
    if (!live()) return undefined
    if (options.status !== 200) return outcome(options, failed, 'A passkey sign-in could not start just now.')
    const o = options.body
    let credential
    try {
      credential = await navigator.credentials.get({
        signal: stop.signal,
        publicKey: {
          challenge: unb64u(o.challenge),
          rpId: o.rpId,
          timeout: o.timeout,
          userVerification: o.userVerification,
          allowCredentials: step ? (o.allowCredentials || []).map((c) => ({ type: 'public-key', id: unb64u(c.id) })) : []
        }
      })
    } catch {
      return failed('No passkey was used. Try again, or use another way in.')
    }
    if (!live()) return undefined
    waiting.textContent = 'Checking…'
    const out = await call('POST', base, { credential: wireAssertion(credential) })
    if (!live()) return undefined
    return outcome(out, failed, 'That passkey did not open an account here.')
  }

  /* ── the ladder ─────────────────────────────────────────────────────────── */
  const RUNGS = {
    passkey: ['key', 'Use your passkey', 'Touch ID, Face ID or a security key'],
    totp: ['code', 'Enter a code from your authenticator', 'The six digits in your authenticator app'],
    approve: ['phone', 'Approve on another device', 'A Cookrew you are already signed in to'],
    recovery: ['life', 'Use a recovery code', 'One of the codes you saved']
  }
  const sessionPath = (step) => `/v2/sessions/${encodeURIComponent(step.pending)}`

  function ladder(step, note) {
    const { said, say } = sayer()
    const offered = (step.next || []).filter((k) => RUNGS[k])
    const usable = offered.filter((k) => k !== 'passkey' || canPasskey())
    const ways = usable.length > 0 ? usable : offered
    screen([
      ...head('One more step', 'Prove it’s you.', 'Choose how to finish signing in.'),
      h(
        'div',
        { class: 'rungs' },
        ways.map((k) =>
          h(
            'button',
            { type: 'button', class: 'rung', onclick: () => rung(step, k) },
            h('span', { class: 'ico', 'aria-hidden': 'true' }, svg(RUNGS[k][0])),
            h('span', null, h('b', null, RUNGS[k][1]), h('small', null, RUNGS[k][2])),
            svg('arrow')
          )
        )
      ),
      said,
      links(notNow())
    ])
    if (note) say(note)
  }
  function rung(step, kind) {
    if (kind === 'passkey') return passkeyScreen(step)
    if (kind === 'approve') return approve(step)
    return typedRung(step, kind)
  }

  function typedRung(step, kind) {
    const { said, say } = sayer()
    const totp = kind === 'totp'
    const code = totp
      ? field('Six-digit code', { class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', 'data-focus': true })
      : field('Recovery code', { class: 'mono', autocomplete: 'off', maxlength: '20', placeholder: 'ABCD-EFGH', 'data-focus': true })
    const { send, submit } = submitter('Verify', 'primary', async () => {
      const value = code.input.value.trim()
      if (!value) return say(totp ? 'Type the six digits.' : 'Type one of your recovery codes.')
      return outcome(await call('POST', `${sessionPath(step)}/${kind}`, { code: value }), say, 'That code did not work. Try again.')
    })
    if (totp) {
      code.input.addEventListener('input', () => {
        const digits = code.input.value.replace(/\D/g, '').slice(0, 6)
        if (digits !== code.input.value) code.input.value = digits
        if (digits.length === 6) submit()
      })
    }
    screen([
      ...(totp
        ? head('Two-step verification', 'Enter your code.', 'The six digits your authenticator app shows right now.')
        : head('Recovery code', 'Use a recovery code.', 'One of the recovery codes you saved. Each one works once.')),
      form([code.row, send, said], submit),
      links(link('Try another way', () => ladder(step)), notNow())
    ])
  }

  async function approve(step) {
    const back = () => links(link('Try another way', () => ladder(step)), notNow())
    const asking = screen([...head('Device approval', 'Asking your other device…', null), h('p', { class: 'wait' }, 'Sending the request.'), back()])
    const asked = await call('POST', `${sessionPath(step)}/approve`, {})
    if (!asking()) return undefined
    if (asked.status !== 202) return outcome(asked, (text) => ladder(step, text), 'Your other devices could not be asked just now.')
    const { said, say } = sayer()
    const until = asked.body.expiresAt || step.expiresAt
    const line = h('p', { class: 'wait' })
    const match = step.match === undefined || step.match === null ? null : String(step.match)
    const live = screen([
      ...head(
        'Device approval',
        'Check your other device.',
        asked.body.sentence || 'Open Cookrew on a device you are already signed in to, find this sign-in, and type the number below there.'
      ),
      // Read out as digits, not as a quantity: "four two", not "forty-two".
      match ? h('p', { class: 'match', role: 'status', 'aria-label': match.split('').join(' ') }, match) : null,
      match ? h('p', { class: 'cap mcap' }, 'Type this number on your other device') : null,
      h('div', { class: 'warn' }, 'Check the app and device named there. ', h('b', null, 'Never approve a sign-in you didn’t start.')),
      line,
      said,
      back()
    ])
    const tick = () => {
      const left = until - now()
      if (left <= 0) return ladder(step, 'That approval timed out. Ask again, or choose another way.')
      line.textContent = `Waiting for an approval · expires in ${clock(left)}`
      return undefined
    }
    tick()
    every(tick, 1000)
    let polling = false
    every(async () => {
      if (polling) return
      polling = true
      const out = await call('GET', sessionPath(step))
      polling = false
      if (!live() || out.status === 202) return
      if (out.status === 0) return say(NET)
      outcome(out, (text) => ladder(step, text), 'That sign-in was not approved.')
    }, 2000)
    return undefined
  }

  /* ── can't sign in ──────────────────────────────────────────────────────── */
  function recover() {
    const { said, say } = sayer()
    const prefill = summary.username || ''
    const user = field('Username', { autocomplete: 'username', maxlength: '32', value: prefill, 'data-focus': !prefill })
    const code = field('Recovery code', { class: 'mono', autocomplete: 'off', maxlength: '20', placeholder: 'ABCD-EFGH', 'data-focus': Boolean(prefill) })
    const { send, submit } = submitter('Continue', 'primary', async () => {
      const username = user.input.value.trim().toLowerCase()
      const value = code.input.value.trim()
      if (!username || !value) return say('Type your username and one recovery code.')
      return outcome(await call('POST', '/v2/recovery', { username, code: value }), say, 'That username and code do not match.')
    })
    screen([
      ...head('Recovery', 'Get back in.', 'Use one of the recovery codes you saved when you set up your account. Each one works once.'),
      form([user.row, code.row, send, said], submit),
      h('p', { class: 'note' }, 'No codes left? Sign in on a device you already use and approve this one from there.'),
      links(link('Back to sign in', () => signIn()), notNow())
    ])
  }

  /* ── a new provider identity: choose a name ─────────────────────────────── */
  function chooseName(answer) {
    const { said, say } = sayer()
    const lbl = label(answer.provider)
    const name = field('Username', { autocomplete: 'username', maxlength: '32', value: answer.suggest || '', 'data-focus': true }, 'Lowercase letters, digits and dashes.')
    const { send, submit } = submitter('Create account', 'primary', async () => {
      const username = name.input.value.trim().toLowerCase()
      const rule = nameRule(username)
      if (rule) return say(rule)
      return outcome(await call('POST', '/v2/oauth/claim', { ticket: answer.ticket, username }), say)
    })
    screen([
      ...head('Create your account', 'What should we call you?', `Your Cookrew name is yours. It doesn’t have to match your ${lbl} name.`),
      answer.email ? h('p', { class: 'warn' }, `${lbl} says your email is `, h('b', null, answer.email), '. Cookrew never joins accounts by email.') : null,
      form([name.row, send, said], submit),
      h('p', { class: 'note' }, 'Already have an account? ', link('Sign in to it', () => signIn()), `, then link ${lbl} from Security.`),
      links(notNow())
    ])
    const mark = availability(name)
    if (answer.suggest) mark(answer.free ? 'free' : 'taken', Boolean(answer.free))
  }

  /* ── a second step, set up before the first session (auth UX 2026-11-09) ── */
  const setupPath = (step) => `/v2/sessions/${encodeURIComponent(step.pending)}/setup`

  function setupChoose(step, note) {
    const { said, say } = sayer()
    const ways = [
      canPasskey() ? ['passkey', 'key', 'Use a passkey', 'Touch ID, Face ID or a security key — both steps in one'] : null,
      ['totp', 'code', 'Use an authenticator app', 'Six digits from an app on your phone']
    ].filter(Boolean)
    screen([
      ...head('One more step', 'Add a second step.', 'Cookrew asks for two steps when you sign in. Set one up now; a passkey counts as both.'),
      h(
        'div',
        { class: 'rungs' },
        ways.map(([kind, icon, title, hint]) =>
          h(
            'button',
            { type: 'button', class: 'rung', onclick: () => (kind === 'passkey' ? setupPasskey(step) : setupTotp(step)) },
            h('span', { class: 'ico', 'aria-hidden': 'true' }, svg(icon)),
            h('span', null, h('b', null, title), h('small', null, hint)),
            svg('arrow')
          )
        )
      ),
      said,
      links(notNow())
    ])
    if (note) say(note)
  }

  /** The factor is in: the codes, then the session. */
  function setupDone(step, out, say) {
    if (out.status === 201 && Array.isArray(out.body.codes)) {
      return recoveryCodes(out.body.codes.map(String), () => setupFinish(step))
    }
    return outcome(out, say, 'That was not set up. Try again.')
  }

  async function setupFinish(step) {
    const { said, say } = sayer()
    const live = screen([...head(null, 'Finishing up…', null), h('p', { class: 'wait' }, 'Signing you in.'), said])
    const out = await call('POST', `${setupPath(step)}/finish`, { saved: true })
    if (!live()) return undefined
    return outcome(out, say, 'Signing in did not finish. Start again.')
  }

  async function setupPasskey(step) {
    const { said, say } = sayer()
    const waiting = h('p', { class: 'wait' }, 'Waiting for your passkey…')
    const live = screen([
      badge('key'),
      ...head('One more step', 'Make a passkey.', 'Your browser will ask for Touch ID, Face ID, Windows Hello or a security key.'),
      waiting,
      said,
      links(link('Use another way', () => setupChoose(step)), notNow())
    ])
    const options = await call('POST', `${setupPath(step)}/passkey/options`, {})
    if (!live()) return undefined
    if (options.status !== 200) return outcome(options, say, 'A passkey could not be started just now.')
    const made = await window.cookrewAuthEnrol.makePasskey(options.body)
    if (!live()) return undefined
    if (made.error) {
      waiting.hidden = true
      return say(made.error)
    }
    waiting.textContent = 'Saving the passkey…'
    const name = window.cookrewAuthEnrol.nameGuess()
    return setupDone(step, await call('POST', `${setupPath(step)}/passkey`, { name, credential: made.credential }), say)
  }

  /** The QR the authenticator scans: rows of 0/1 from the registry, drawn as SVG. */
  function qrPicture(rows) {
    const NS = 'http://www.w3.org/2000/svg'
    const quiet = 4
    const span = rows.length + quiet * 2
    const picture = doc.createElementNS(NS, 'svg')
    picture.setAttribute('viewBox', `0 0 ${span} ${span}`)
    picture.setAttribute('class', 'qr')
    picture.setAttribute('role', 'img')
    picture.setAttribute('aria-label', 'Scan this with your authenticator app')
    picture.setAttribute('shape-rendering', 'crispEdges')
    const paper = doc.createElementNS(NS, 'rect')
    paper.setAttribute('width', String(span))
    paper.setAttribute('height', String(span))
    paper.setAttribute('fill', '#fff')
    let d = ''
    rows.forEach((line, y) => {
      for (let x = 0; x < line.length; x += 1) if (line[x] === '1') d += `M${x + quiet} ${y + quiet}h1v1h-1z`
    })
    const ink = doc.createElementNS(NS, 'path')
    ink.setAttribute('d', d)
    ink.setAttribute('fill', '#14110a')
    picture.append(paper, ink)
    return picture
  }

  async function setupTotp(step) {
    const { said, say } = sayer()
    const live = screen([...head('One more step', 'Setting up your authenticator…', null), said])
    const started = await call('POST', `${setupPath(step)}/totp`, {})
    if (!live()) return undefined
    if (started.status !== 201) return outcome(started, say, 'The authenticator could not be set up just now.')
    const code = field('Six-digit code', { class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', 'data-focus': true })
    const { said: said2, say: say2 } = sayer()
    const { send, submit } = submitter('Verify', 'primary', async () => {
      const value = code.input.value.trim()
      if (!value) return say2('Type the six digits your app shows.')
      return setupDone(step, await call('POST', `${setupPath(step)}/totp/confirm`, { code: value }), say2)
    })
    code.input.addEventListener('input', () => {
      const digits = code.input.value.replace(/\D/g, '').slice(0, 6)
      if (digits !== code.input.value) code.input.value = digits
      if (digits.length === 6) submit()
    })
    const rows = Array.isArray(started.body.qr) ? started.body.qr : []
    screen([
      ...head('One more step', 'Scan this with your authenticator app.', 'Then type the six digits it shows.'),
      rows.length > 0 ? qrPicture(rows) : null,
      h('p', { class: 'note' }, 'Or type this key: ', h('code', { class: 'mono' }, String(started.body.secret || ''))),
      form([code.row, send, said2], submit),
      links(link('Use another way', () => setupChoose(step)), notNow())
    ])
    return undefined
  }

  /* ── through ────────────────────────────────────────────────────────────── */
  function success(answer) {
    over = true
    const onward = () => handoff(answer.handoff)
    if (Array.isArray(answer.codes) && answer.codes.length > 0) return recoveryCodes(answer.codes.map(String), onward)
    return onward()
  }

  function recoveryCodes(codes, onward) {
    const { said, say } = sayer()
    const text = `Cookrew recovery codes\n\n${codes.join('\n')}\n\nEach code opens your account once. Keep them somewhere safe.\n`
    const copy = button('Copy', '', () =>
      navigator.clipboard.writeText(text).then(
        () => say('Copied.', true),
        () => say('Copying is not allowed here. Download them instead.')
      ),
    'copy')
    const save = button('Download .txt', '', () => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
      const a = h('a', { href: url, download: 'cookrew-recovery-codes.txt', hidden: true })
      body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      say('Saved as cookrew-recovery-codes.txt.', true)
    }, 'download')
    const next = button('Continue', 'primary', onward)
    next.disabled = true
    const box = h('input', { type: 'checkbox', onchange: () => (next.disabled = !box.checked) })
    screen([
      ...head('Account protection', 'Save a way back in.', 'These recovery codes are shown once. Keep them somewhere safe, apart from this device.'),
      h('ul', { class: 'codes', 'aria-label': 'Recovery codes' }, codes.map((c) => h('li', null, c))),
      h('div', { class: 'pair' }, copy, save),
      h('label', { class: 'check' }, box, 'I saved them somewhere safe.'),
      next,
      said,
      h('p', { class: 'note' }, 'Each code opens your account once, even without your password or your devices.')
    ])
  }

  function handoff(way) {
    over = true
    const kind = way && way.kind
    const passkey = passkeyIntent()
    if (kind === 'web' && safe(way.url)) {
      const title = passkey ? 'Passkey made.' : 'Signed in.'
      screen([badge('check'), ...head(null, title, `Taking you back to ${summary.returnHost || 'cookrew.dev'}${passkey ? ' to add it' : ''}…`), go('Continue', way.url, 'primary')])
      location.replace(way.url)
      return
    }
    if (kind === 'app' && safe(way.url)) {
      screen([
        badge('check'),
        ...head(null, 'Opening Cookrew…', `Your browser may ask to open the Cookrew app. Allow it, and the app ${passkey ? 'adds the passkey to your account' : 'finishes signing you in'}.`),
        go('Open Cookrew', way.url, 'primary'),
        safe(way.fallback) ? go('Cookrew did not open? Continue here', way.fallback, '') : null,
        h('p', { class: 'note' }, 'The way back carries a one-use code only the app that asked can spend. No password or token is shown here.')
      ])
      // Once, by itself; after that the buttons are the person's to press.
      later(() => location.assign(way.url), 400)
      return
    }
    screen([
      badge('check'),
      ...head(
        null,
        'You’re signed in.',
        kind === 'cli' ? 'Go back to your terminal. cookrew login finishes on its own, and you can close this tab.' : 'You can close this tab.'
      )
    ])
  }

  /* ── not now, and the ends that are not success ─────────────────────────── */
  function notNow() {
    return link('Not now', async () => {
      const out = await call('POST', '/auth/api/cancel', {})
      if (out.status === 200 && out.body.status === 'cancelled') return cancelled(out.body)
      if (out.status === 410) return expired()
      const said = $screen.querySelector('.said')
      if (said) {
        said.classList.remove('calm')
        said.textContent = out.status === 0 ? NET : out.body.message || 'That could not be cancelled just now.'
      }
      return undefined
    })
  }

  function cancelled(answer) {
    over = true
    const way = answer.handoff || {}
    const where =
      way.kind === 'web'
        ? `Taking you back to ${(summary && summary.returnHost) || 'cookrew.dev'}…`
        : way.kind === 'app'
          ? 'The Cookrew app has been told.'
          : way.kind === 'cli'
            ? 'Your terminal will say so.'
            : ''
    screen([badge('x', true), ...head(null, 'Cancelled.', `${passkeyIntent() ? 'No passkey was added.' : 'Nothing was signed in.'} ${where}`), way.kind === 'app' ? go('Back to Cookrew', way.url, '') : null])
    if (way.kind === 'web' && safe(way.url)) later(() => location.replace(way.url), 900)
    if (way.kind === 'app' && safe(way.url)) later(() => location.assign(way.url), 400)
  }

  /** The one thing left to do once a request is over: start again where it began. */
  function restart() {
    if (summary && summary.client === 'cli') return h('p', { class: 'note' }, 'Run cookrew login again in your terminal.')
    if (passkeyIntent() && summary.client === 'desktop') return h('p', { class: 'note' }, 'Open Security in the Cookrew app and add the passkey again.')
    if (summary && summary.client === 'desktop') return h('p', { class: 'note' }, 'Open the Cookrew app and choose Sign in again.')
    return go('Back to cookrew.dev', `${PRODUCT}/${passkeyIntent() ? 'me#security' : ''}`, 'primary')
  }

  /** A screen that ends the request: a mark, what happened, and the one way on. */
  function ending(icon, title, lede, onward) {
    over = true
    screen([icon ? badge(icon, icon !== 'check') : null, ...head(null, title, lede), onward === undefined ? restart() : onward])
  }
  const expired = () => ending('clock', `This ${what()} timed out.`, `Start again from ${from()}.`)
  const claimed = () =>
    ending('x', 'Open in another browser.', 'This sign-in is already being finished in another browser, and for your safety it works in one only. Finish it there, or start again.')
  const unknown = () =>
    ending(null, 'This sign-in link doesn’t work.', 'It may be mistyped, or already used. Start again from cookrew.dev, the Cookrew app or cookrew login.')
  const finishedElsewhere = () =>
    ending('check', `This ${what()} is already finished.`, 'There is nothing more to do here. You can close this tab.', null)

  function denied(retry) {
    if (!retry) return ending('x', `This ${what()} was denied.`, `It was turned down and can’t be used again. Start again from ${from()}.`)
    if (passkeyIntent()) return window.cookrewAuthEnrol.notConfirmed(enrolUi())
    const provider = summary && (summary.provider || (summary.intent === 'github' || summary.intent === 'google' ? summary.intent : null))
    return screen([
      badge('x', true),
      ...head(null, 'Sign-in was not completed.', `${provider ? label(provider) : 'The provider'} did not confirm it, or it was cancelled there. Nothing was signed in.`),
      button('Try again', 'primary', () => first()),
      links(link('Use another way', () => signIn()), notNow())
    ])
  }

  function nothing() {
    screen([
      ...head(null, 'Nothing to sign in to here.', 'This page opens when cookrew.dev, the Cookrew app or cookrew login sends you. Start there.'),
      go('Go to cookrew.dev', `${PRODUCT}/`, 'primary'),
      links(h('span', null, 'Signing in a terminal? ', h('a', { href: '/device' }, 'Enter its code')))
    ])
  }

  function unreachable(retry) {
    screen([...head(null, 'Can’t reach Cookrew.', NET), button('Try again', 'primary', () => retry())])
  }

  function problem(text) {
    screen([...head(null, 'Something went wrong.', text), restart()])
  }

  /* ── the clock, and coming back from the back button ────────────────────── */
  setInterval(() => {
    if (!over && summary && typeof summary.expiresAt === 'number' && now() >= summary.expiresAt) expired()
  }, 1000)
  // A page restored from the back/forward cache holds a sign-in that has moved on.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload()
  })

  boot().catch(() => problem('This page hit a problem it did not expect. Reload to try again.'))
})()
