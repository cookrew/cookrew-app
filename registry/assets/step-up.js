/* cookrew.dev/me — proving it is you before a sensitive act, for every kind of account.
 *
 * Changing or setting a password, adding or removing a way back in, taking a
 * device off, adding a machine, "not me" and deleting the account ask for a
 * proof once the sign-in is more than five minutes old. This is the one place
 * /me answers that ask:
 *
 *   AN ACCOUNT WITH A PASSWORD types it here, once, and the act goes on.
 *   AN ACCOUNT WITHOUT ONE is taken to auth.cookrew.dev for that one act — a
 *     passkey, else its provider, else an authenticator or recovery code — and
 *     brought back here, where the act it started finishes.
 *
 * WHAT CROSSES THE TRIP: the act and what it was about (a device id, the name
 * typed to confirm a deletion), in this tab's sessionStorage — never a
 * password. What comes back is the act in the query and a one-use proof id in
 * the fragment, scrubbed from the address bar before anything else runs. The
 * id is worth nothing without this browser's session: the registry spends it
 * only for the sitting that made the trip, for that act, once.
 */
;(() => {
  'use strict'
  const KEY = 'cr_stepup'
  /** A trip older than this is not finished on landing: the proof is good for five minutes anyway. */
  const TRIP_MS = 15 * 60 * 1000
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const ACTS = ['change-password', 'add-factor', 'remove-factor', 'revoke-device', 'delete-account', 'mint-join-code', 'not-me']
  const TRIP_LINE = 'Cookrew opens auth.cookrew.dev to confirm it — with your passkey, your sign-in provider or a code — and brings you back here to finish.'

  const toast = (message, ms) => window.cookrewAccount?.toast?.(message, ms)
  const me = () => document.getElementById('me')
  /** Does this account have a password to type here? The page says; the registry decides. */
  const hasPassword = () => me()?.dataset.hasPassword === '1'
  const handlers = new Map()

  /** Was this answer the registry asking for a proof, rather than refusing the act? */
  function asked(out) {
    const error = out && out.body && out.body.error
    if (out.status === 401 && error === 'step_up') return true
    return out.status === 403 && (error === 'step_up' || error === 'provider_required' || error === 'password_required')
  }

  const save = (record) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(record))
      return true
    } catch {
      return false
    }
  }
  /** The trip this tab started, read once and forgotten. */
  const take = () => {
    try {
      const raw = sessionStorage.getItem(KEY)
      sessionStorage.removeItem(KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  /**
   * TO AUTH.COOKREW.DEV FOR ONE ACT. `resume` is what to finish on the way
   * back — its `kind` names a handler registered with `on`; nothing secret
   * goes in it. `quiet` skips the question when the page already asked it.
   */
  async function prove(act, resume, sentence, quiet) {
    if (!quiet && !confirm(`${sentence || 'Prove it is you first.'}\n\n${TRIP_LINE}`)) return false
    if (!save({ act, resume, at: Date.now() })) {
      toast('This browser will not keep the page’s place, so it cannot come back to finish. Allow site data for cookrew.dev, then try again.', 8000)
      return false
    }
    const through = window.cookrewAccount?.throughAuthSite
    const going = through ? await through('step-up', { act }) : false
    if (!going) {
      take()
      toast('Confirming that is not available here yet. Try again in a moment.', 6000)
    }
    return going
  }

  /**
   * RUN AN ACT, PROVING IT WHEN ASKED. `send(proof)` makes the call with the
   * proof's fields ({}, {current}, or {stepUp}). Answers the last answer, or
   * null when the page is leaving for the proof.
   */
  async function run({ act, send, resume }) {
    const out = await send({})
    if (!asked(out)) return out
    const sentence = (out.body && out.body.message) || 'Prove it is you first.'
    if (hasPassword()) {
      const current = prompt(`${sentence} Type your password to go on.`)
      if (current === null || current === '') return out
      return send({ current })
    }
    return (await prove(act, resume, sentence)) ? null : out
  }

  /** Would this act pass on the last five minutes alone? null when the registry cannot say. */
  async function fresh(act) {
    try {
      const res = await fetch(`/v2/me/step-up/${encodeURIComponent(act)}`, { credentials: 'same-origin' })
      if (res.status !== 200) return null
      const body = await res.json()
      return body && body.fresh === true
    } catch {
      return null
    }
  }

  const on = (kind, handler) => handlers.set(kind, handler)

  /** Back from auth.cookrew.dev: scrub the address, then finish what this tab started. */
  function landed() {
    const saved = take()
    const query = new URLSearchParams(location.search)
    const act = query.get('stepped')
    const hash = location.hash.startsWith('#stepup=') ? new URLSearchParams(location.hash.slice(1)) : null
    if (act === null && hash === null) return
    const id = hash ? hash.get('stepup') : null
    query.delete('stepped')
    const rest = query.toString()
    try {
      history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`)
    } catch {
      // The proof is already out of the address and into this closure.
    }
    if (!ACTS.includes(act) || typeof id !== 'string' || !UUID.test(id)) return
    const resume = saved && saved.act === act && Date.now() - Number(saved.at) < TRIP_MS ? saved.resume : null
    const handler = resume && handlers.get(resume.kind)
    if (!handler) {
      toast('Confirmed. Do it again now — this lasts five minutes.', 6000)
      return
    }
    handler(resume, id)
  }

  // Every script on the page has registered its handlers by then: they are deferred.
  document.addEventListener('DOMContentLoaded', landed)

  window.cookrewStepUp = Object.freeze({ asked, run, prove, fresh, on, landed })
})()
