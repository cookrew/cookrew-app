/* auth.cookrew.dev — adding a passkey: the screens of a `passkey` request.
 *
 * Loaded between auth-kit.js and auth.js, which hands it the page's own
 * helpers (`ui`) when a request opened by a signed-in Cookrew asks to add a
 * passkey. Two screens and nothing else:
 *
 *   PROVE   an account with no password proves it is the owner with a provider
 *           it already linked — the same round trip every other "add a way
 *           back in" asks of it. The registry holds what that earns; this
 *           script never sees it.
 *   CREATE  navigator.credentials.create with the registry's options, whose
 *           rpId is the product's host, so the passkey opens the account here
 *           and on cookrew.dev. The registry verifies it and holds it until
 *           the Cookrew that asked writes it.
 *
 * Every refusal is the registry's own sentence, or one that says what to do.
 */
;(() => {
  'use strict'
  const { unb64u, b64u, canPasskey, h } = window.cookrewAuthKit

  /** A name the person will recognise in Security later. They can change it. */
  function nameGuess() {
    const ua = navigator.userAgent || ''
    if (/iPhone/.test(ua)) return 'Face ID on this iPhone'
    if (/iPad/.test(ua)) return 'Passkey on this iPad'
    if (/Android/.test(ua)) return 'Passkey on this Android phone'
    if (/Mac OS X|Macintosh/.test(ua)) return 'Touch ID on this Mac'
    if (/Windows/.test(ua)) return 'Windows Hello on this PC'
    return 'Passkey'
  }

  const wireCredential = (credential) => ({
    id: credential.id,
    rawId: b64u(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: b64u(credential.response.clientDataJSON),
      attestationObject: b64u(credential.response.attestationObject)
    }
  })

  const publicKeyOf = (o) => ({
    challenge: unb64u(o.challenge),
    rp: o.rp,
    user: { id: unb64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    authenticatorSelection: o.authenticatorSelection,
    attestation: o.attestation,
    timeout: o.timeout,
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ type: 'public-key', id: unb64u(c.id) }))
  })

  /** What a browser's refusal means to the person holding it. */
  function refusalOf(error) {
    const name = error && error.name
    if (name === 'InvalidStateError') return 'This browser or security key already holds a passkey for this account. Use another one, or close this tab.'
    if (name === 'NotSupportedError') return 'This browser cannot make that kind of passkey. Try Safari, Chrome, Edge or Firefox.'
    if (name === 'SecurityError') return 'This browser refused to make a passkey for cookrew.dev here. Open the link in your usual browser and try again.'
    return 'No passkey was made. Press Create passkey to try again.'
  }

  function start(ui, note) {
    const s = ui.summary()
    const user = s.username || ''
    const enrol = s.enrol || { needs: 'ready', providers: [] }
    const top = [h('span', { class: 'badge av', 'aria-hidden': 'true' }, (user[0] || '?').toUpperCase())]
    if (!canPasskey()) {
      return ui.screen([
        ...top,
        ...ui.head('Security', `Add a passkey to @${user}.`, 'Passkeys are not available in this browser. Open this link in Safari, Chrome, Edge or Firefox on a device with Touch ID, Face ID, Windows Hello or a security key.'),
        ui.links(ui.notNow())
      ])
    }
    return enrol.needs === 'provider' ? prove(ui, top, user, enrol.providers || [], note) : create(ui, top, user, note)
  }

  function prove(ui, top, user, providers, note) {
    const { said, say } = ui.sayer()
    const names = providers.map((id) => ui.label(id)).join(' or ')
    const buttons = providers.map((id) => {
      const b = ui.button(`Continue with ${ui.label(id)}`, providers.length === 1 ? 'primary' : '', () => ui.busy(b, () => ui.toProvider(id, say)), id)
      return b
    })
    ui.screen([
      ...top,
      ...ui.head(
        'Security',
        `Add a passkey to @${user}.`,
        names
          ? `First prove it’s you with ${names}, the way this account signs in. You come straight back here, and then your browser asks for Touch ID.`
          : 'This account has no way to prove it is you on this page. Add the passkey from a device signed in with a password.'
      ),
      buttons.length > 1 ? h('div', { class: 'pair' }, buttons) : buttons[0] || null,
      said,
      ui.links(ui.notNow())
    ])
    if (note) say(note)
  }

  function create(ui, top, user, note) {
    const { said, say } = ui.sayer()
    const name = ui.field('Name', { maxlength: '64', value: nameGuess(), autocomplete: 'off' }, 'How this passkey is listed in Security.')
    const { send, submit } = ui.submitter('Create passkey', 'primary', () => ceremony(ui, name.input.value, say))
    ui.screen([
      ...top,
      ...ui.head(
        'Security',
        `Add a passkey to @${user}.`,
        'Your browser will ask for Touch ID, Face ID, Windows Hello or a security key. After that, the passkey signs you in to Cookrew.'
      ),
      ui.form([name.row, send, said], submit),
      ui.links(ui.notNow())
    ])
    if (note) say(note)
  }

  /** A proof that ran out or was spent sends the person back to prove it again, saying so. */
  function again(ui, out) {
    const s = ui.summary()
    ui.setEnrol({ needs: 'provider', providers: out.body.providers || (s.enrol && s.enrol.providers) || [] })
    return start(ui, out.body.message)
  }

  async function ceremony(ui, rawName, say) {
    const label = String(rawName || '').trim()
    if (label.length > 64) return say('Keep the name to 64 characters or fewer.')
    const options = await ui.call('POST', '/auth/api/passkey/options', {})
    if (options.status === 403 && options.body.error === 'step_up') return again(ui, options)
    if (options.status !== 200) return ui.outcome(options, say, 'A passkey could not be started just now. Try again.')
    let credential
    try {
      credential = await navigator.credentials.create({ publicKey: publicKeyOf(options.body) })
    } catch (error) {
      // Told to the registry by name only, so a failure here shows in its log.
      void ui.call('POST', '/auth/api/passkey', { failed: String((error && error.name) || 'unknown') })
      return say(refusalOf(error))
    }
    if (!credential) return say(refusalOf(null))
    say('Saving the passkey…', true)
    const out = await ui.call('POST', '/auth/api/passkey', { name: label, credential: wireCredential(credential) })
    if (out.status === 403 && out.body.error === 'step_up') return again(ui, out)
    return ui.outcome(out, say, 'That passkey was not added. Press Create passkey to try again.')
  }

  /** The provider said no, or the person cancelled there: nothing was added, and the way on. */
  function notConfirmed(ui) {
    return ui.screen([
      ui.badge('x', true),
      ...ui.head(null, 'That was not confirmed.', 'The provider did not confirm it, or it was cancelled there. No passkey was added.'),
      ui.button('Try again', 'primary', () => ui.first()),
      ui.links(ui.notNow())
    ])
  }

  /**
   * A passkey from the registry's creation options, for the sign-in set-up
   * (auth.js): the wire credential, or the sentence a refusal means.
   */
  async function makePasskey(options) {
    try {
      const credential = await navigator.credentials.create({ publicKey: publicKeyOf(options) })
      return credential ? { credential: wireCredential(credential) } : { error: refusalOf(null) }
    } catch (error) {
      return { error: refusalOf(error) }
    }
  }

  window.cookrewAuthEnrol = Object.freeze({ start, notConfirmed, makePasskey, nameGuess })
})()
