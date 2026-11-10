/* auth.cookrew.dev — the account password, typed here to open your machines
 * in the console.
 *
 * Loaded between auth-kit.js and auth.js, which hands it the page's own
 * helpers (`ui`) when a `grant` request asks. One screen and nothing else:
 * whose machines, the password field, and the way back.
 *
 * The console's own page never takes this password: it draws what machines
 * send, so a password typed there could be read by a script that got into it.
 * A passkey is touched there in place; a password comes here. Nothing typed
 * on this page counts until the console that asked, in the browser that
 * asked, spends the code that goes back — so this script never holds
 * anything worth stealing, and never sees the pass.
 */
;(() => {
  'use strict'
  const { h } = window.cookrewAuthKit

  function start(ui, note) {
    const s = ui.summary()
    const user = s.username || ''
    const home = s.returnHost || 'the console'
    const { said, say } = ui.sayer()
    const pass = ui.field('Account password', {
      type: 'password',
      name: 'password',
      autocomplete: 'current-password',
      maxlength: '256',
      'data-focus': true
    })
    const { send, submit } = ui.submitter('Open my machines', 'primary', async () => {
      const password = pass.input.value
      if (!password) return say('Type your account password.')
      const out = await ui.call('POST', '/auth/api/grant', { password })
      const b = out.body || {}
      if (out.status === 401 && b.error === 'wrong') {
        pass.input.value = ''
        pass.input.focus()
        const left = Number(b.triesLeft)
        return say(left === 1 ? 'That is not the account password. One more try before a minute’s rest.' : 'That is not the account password.')
      }
      return ui.outcome(out, say, 'That did not go through. Try again.')
    })
    ui.screen([
      h('span', { class: 'badge av', 'aria-hidden': 'true' }, (user[0] || '?').toUpperCase()),
      ...ui.head(
        'Open your machines',
        'Type your account password.',
        `For @${user}. It opens every machine of this account in the console for 12 hours, then you go straight back to ${home}.`
      ),
      ui.form([pass.row, send, said], submit),
      h('p', { class: 'note' }, 'The console never asks for this password itself. If a page other than this one asks for it, do not type it.'),
      ui.links(ui.notNow())
    ])
    if (note) say(note)
  }

  window.cookrewAuthGrant = Object.freeze({ start })
})()
