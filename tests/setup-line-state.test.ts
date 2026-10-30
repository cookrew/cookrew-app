import { describe, expect, it } from 'vitest'
import { observeOutput, runningLabel, runningView, startedLine } from '../src/renderer/src/routing/setup-line-state'

/**
 * THE SIGN-IN DETECTOR, against the sentences that fooled it.
 *
 * The owner's phone showed START relabelled "sign-in open in your browser": START types
 * `magpie autostart on`, magpie answers "magpie opens at login, in the tray", and the old
 * pattern matched "login". There was no sign-in anywhere — and had there been one, the page
 * was open in the Mac's browser, which a phone cannot reach.
 */
const feed = (line: string, ...chunks: string[]) =>
  chunks.reduce((w, c) => observeOutput(w, c), startedLine(line))

describe('a sign-in is a sign-in word AND a page to open', () => {
  it('does not read "opens at login" as a sign-in', () => {
    const w = feed('magpie autostart on', 'magpie autostart on\r\n', '✓ magpie opens at login, in the tray\r\n')
    const view = runningView(w)
    expect(view.oauth).toBe(false)
    expect(view.url).toBeNull()
    expect(runningLabel(view, 'magpie autostart on')).not.toMatch(/sign-in/)
  })

  it('does not read a URL in the typed line itself as a sign-in page', () => {
    const line = 'curl -fsSL https://usemagpie.ai/install.sh | sh'
    const w = feed(line, `${line}\r\n`, 'installing magpie — sign in later with magpie accounts add\r\n')
    expect(runningView(w).oauth).toBe(false)
    expect(runningView(w).url).toBeNull()
  })

  it('finds claude’s sign-in page and hands its URL to the panel', () => {
    const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz'
    const w = feed('claude login', 'claude login\r\n', "Browser didn't open? Use the url below to sign in:\r\n", `${url}\r\n`, 'Paste code here if prompted > ')
    const view = runningView(w)
    expect(view.oauth).toBe(true)
    expect(view.url).toBe(url)
    expect(runningLabel(view, 'claude login')).toBe('sign in — open the page')
  })

  it('prefers the page to the local callback server when both are printed', () => {
    const page = 'https://auth.openai.com/oauth/authorize?client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'
    const w = feed(
      'magpie accounts add codex',
      'magpie accounts add codex\r\n',
      'Starting local login server on http://localhost:1455.\r\n',
      `If your browser did not open, navigate to this URL to authenticate:\r\n\r\n${page}\r\n`
    )
    expect(runningView(w).url).toBe(page)
  })

  it('reads a URL coloured by the terminal, without its escape codes', () => {
    const url = 'https://claude.ai/oauth/authorize?x=1'
    const w = feed('claude login', 'claude login\r\n', `Sign in at \x1b[4m\x1b[36m${url}\x1b[0m\r\n`)
    expect(runningView(w).url).toBe(url)
  })
})

describe('the panel hands the page over as a link a phone can tap', () => {
  it('renders the sign-in page as an anchor, and nothing when there is no page', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { SignInLink } = await import('../src/renderer/src/routing/RoutingSections')
    const url = 'https://claude.ai/oauth/authorize?code=true&x=1'
    const html = renderToStaticMarkup(createElement(SignInLink, { running: { line: 'claude login', lastLine: '', oauth: true, url } }))
    expect(html).toContain(`href="${url.replace(/&/g, '&amp;')}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('claude.ai')
    expect(html).toContain('OPEN SIGN-IN PAGE')
    const none = renderToStaticMarkup(createElement(SignInLink, { running: { line: 'magpie autostart on', lastLine: '', oauth: false, url: null } }))
    expect(none).toBe('')
  })
})
