/* auth.cookrew.dev — confirming it is you, for one act on cookrew.dev/me.
 *
 * Loaded between auth-kit.js and auth.js, which hands it the page's own
 * helpers (`ui`) when a `step-up` request asks. One screen and nothing else:
 * the act in words, and the ways THIS account can prove it for THIS act —
 *
 *   a passkey, when the account has one (and the only way for a first
 *     password on such an account);
 *   else the provider the account signs in with, a round trip that comes
 *     straight back here;
 *   else a code: the authenticator, or a recovery code.
 *
 * The rungs themselves are the sign-in ladder's own screens (auth.js), reached
 * with a ladder the registry opens for this request alone. Nothing this page
 * proves counts until cookrew.dev, in the browser that asked, spends the code
 * that comes back — so this script never holds anything worth stealing.
 */
;(() => {
  'use strict'
  const { canPasskey, h, svg } = window.cookrewAuthKit

  /** Copy for each way, in the ladder's own words. */
  const WAYS = {
    passkey: ['key', 'Use your passkey', 'Touch ID, Face ID or a security key'],
    totp: ['code', 'Enter a code from your authenticator', 'The six digits in your authenticator app'],
    recovery: ['life', 'Use a recovery code', 'One of the codes you saved. It is used up.']
  }

  const row = (icon, title, small, onclick) =>
    h(
      'button',
      { type: 'button', class: 'rung', onclick },
      h('span', { class: 'ico', 'aria-hidden': 'true' }, svg(icon)),
      h('span', null, h('b', null, title), h('small', null, small)),
      svg('arrow')
    )

  /** Open (or reopen) this request's ladder, then climb the chosen rung. */
  async function climb(ui, kind, say) {
    const out = await ui.call('POST', '/auth/api/step-up', {})
    if (out.status !== 200 || !out.body.pending) return ui.outcome(out, say, 'That could not start just now. Try again.')
    return ui.rung({ pending: out.body.pending, next: out.body.next || [], expiresAt: out.body.expiresAt }, kind)
  }

  function start(ui, note) {
    const s = ui.summary()
    const step = s.step || { sentence: 'Prove it is you.', passkey: false, providers: [], codes: [] }
    const user = s.username || ''
    const { said, say } = ui.sayer()
    const rows = []
    if (step.passkey && canPasskey()) rows.push(row(...WAYS.passkey, () => climb(ui, 'passkey', say)))
    const providers = (step.providers || []).map((id) => {
      const b = ui.button(`Continue with ${ui.label(id)}`, rows.length === 0 ? 'primary' : '', () => ui.busy(b, () => ui.toProvider(id, say)), id)
      return b
    })
    for (const kind of step.codes || []) {
      if (WAYS[kind]) rows.push(row(...WAYS[kind], () => climb(ui, kind, say)))
    }
    const none = rows.length === 0 && providers.length === 0
    ui.screen([
      h('span', { class: 'badge av', 'aria-hidden': 'true' }, (user[0] || '?').toUpperCase()),
      ...ui.head(
        'Confirm it’s you',
        step.sentence,
        none
          ? step.passkey
            ? 'This account confirms this with its passkey, and passkeys are not available in this browser. Open this link in Safari, Chrome, Edge or Firefox.'
            : 'This account has no passkey, provider or code to confirm with here.'
          : `For @${user}. Then you go straight back to ${s.returnHost || 'cookrew.dev'} to finish.`
      ),
      providers.length > 1 ? h('div', { class: 'pair' }, providers) : providers[0] || null,
      providers.length > 0 && rows.length > 0 ? h('p', { class: 'or' }, 'or') : null,
      rows.length > 0 ? h('div', { class: 'rungs' }, rows) : null,
      said,
      ui.links(ui.notNow())
    ])
    if (note) say(note)
  }

  /** The provider said no, or the person cancelled there: nothing changed, and the way on. */
  function notConfirmed(ui) {
    return ui.screen([
      ui.badge('x', true),
      ...ui.head(null, 'That was not confirmed.', 'The provider did not confirm it, or it was cancelled there. Nothing was changed.'),
      ui.button('Try again', 'primary', () => ui.first()),
      ui.links(ui.notNow())
    ])
  }

  window.cookrewAuthStep = Object.freeze({ start, notConfirmed })
})()
