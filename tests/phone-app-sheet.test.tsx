// ⋯ → PHONE APP: the QR the native phone app scans to join as a trusted phone.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../src/renderer/src/api', () => ({ isRemoteMode: () => false, cookrew: () => ({}) }))

const { PhoneAskView, PhoneCodeView } = await import('../src/renderer/src/PhoneAppSheet')

const URL_ = 'https://cookrew.dev/join#K7QM-2XPD'

describe('the code, as the phone scans it', () => {
  it('draws the link as a QR, black on white, and prints the code for a person who types it', () => {
    const html = renderToStaticMarkup(<PhoneCodeView code="K7QM-2XPD" url={URL_} left="9:41" onAgain={() => undefined} />)
    expect(html).toContain('<svg')
    expect(html).toContain('fill="#ffffff"')
    expect(html).toMatch(/<path d="M\d/)
    expect(html).toContain('K7QM-2XPD')
    expect(html).toContain('9:41 left')
    // One phone, once: the code is spent at the join.
    expect(html).toContain('works once')
  })

  it('says it ran out and offers another, with no QR left on screen', () => {
    const html = renderToStaticMarkup(<PhoneCodeView code="K7QM-2XPD" url={URL_} left={null} onAgain={() => undefined} />)
    expect(html).not.toContain('<svg')
    expect(html).toContain('GET A NEW CODE')
  })
})

describe('asking for one', () => {
  const ask = (over: Partial<Parameters<typeof PhoneAskView>[0]> = {}) =>
    renderToStaticMarkup(
      <PhoneAskView
        account="password"
        sealed
        platform="darwin"
        password=""
        busy={false}
        error={null}
        onPassword={() => undefined}
        onAsk={() => undefined}
        {...over}
      />
    )

  it('takes the account password, since a trusted phone enters every machine', () => {
    const html = ask()
    expect(html).toContain('type="password"')
    expect(html).toContain('every Mac')
    expect(html).toContain('GET A CODE')
  })

  it('a passwordless account asks for no password here', () => {
    expect(ask({ account: 'passwordless' })).not.toContain('type="password"')
  })

  it('without an account, or on a plain line, there is nothing to mint', () => {
    expect(ask({ account: 'none' })).not.toContain('GET A CODE')
    expect(ask({ sealed: false })).not.toContain('GET A CODE')
    expect(ask({ sealed: false })).not.toContain('type="password"')
  })

  it('says it is checking until the machine has said what it is, and never that the line is plain', () => {
    const html = ask({ account: null, sealed: false })
    expect(html).toContain('Checking')
    expect(html).not.toContain('encrypted')
    expect(html).not.toContain('GET A CODE')
  })

  it('shows the refusal', () => {
    expect(ask({ error: 'That is not the account password.' })).toContain('role="alert"')
  })
})
