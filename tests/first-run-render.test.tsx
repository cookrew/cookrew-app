import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreflightView } from '../src/renderer/src/first-run/Preflight'
import { FirstScreenView } from '../src/renderer/src/first-run/FirstScreen'
import { HintCard } from '../src/renderer/src/first-run/FirstRunHints'
import { EXAMPLE_TASKS, FIRST_SCREEN_COPY, HINT_COPY, PREFLIGHT_COPY, TOOL_NOTES } from '../src/shared/first-run-copy'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../src/shared/preflight'

const green: ToolFacts = {
  claude: 'found', claudeSignedIn: true, codex: 'found', codexSignedIn: true, herdr: 'found', tmux: 'found',
  chrome: 'found', magpie: 'found', ollama: 'found', brew: 'found', npm: 'found', host: 'herdr', platform: 'darwin'
}
const gaps: ToolFacts = { ...green, codex: 'missing', codexSignedIn: null, herdr: 'missing', tmux: 'missing', host: 'direct', ollama: 'missing' }
const none: ToolFacts = { ...gaps, claude: 'missing', claudeSignedIn: null }
const view = (facts: ToolFacts | null, over: Partial<Parameters<typeof PreflightView>[0]> = {}): string =>
  renderToStaticMarkup(
    <PreflightView rows={facts ? preflightRows(facts) : null} running={null} error={null} onRun={vi.fn()} onCheck={vi.fn()} onContinue={vi.fn()} onSkip={vi.fn()} {...over} />
  )

describe('the tool check on screen', () => {
  it('asks for no account', () => {
    expect(view(gaps)).not.toMatch(/account|sign up|username|password/i)
  })

  it('draws one row per tool, each with its state', () => {
    const html = view(gaps)
    expect(html.match(/class="fr-row /g)).toHaveLength(6)
    expect(html).toContain(PREFLIGHT_COPY.FOUND)
    expect(html).toContain(PREFLIGHT_COPY.MISSING)
  })

  it('draws a press for each gap, and none for a found row', () => {
    expect(view(green)).not.toContain('fr-fix')
    expect(view(gaps).match(/class="fr-fix"/g)).toHaveLength(3)
    expect(view(gaps)).toContain('Install tmux')
  })

  it('says the plain consequence of no keeper', () => {
    expect(view(gaps)).toContain(TOOL_NOTES.NOT_KEPT)
  })

  it('marks the two optional tools, and only them', () => {
    expect(view(gaps).match(new RegExp(`>${PREFLIGHT_COPY.OPTIONAL}<`, 'g'))).toHaveLength(2)
  })

  it('reads a failed check as a calm row, with the way on open', () => {
    const html = view(UNKNOWN_FACTS)
    expect(html).toContain(PREFLIGHT_COPY.UNKNOWN)
    expect(html).not.toContain('fr-fix')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue/)
  })

  it('holds the way on only with neither agent tool, and says why', () => {
    const html = view(none)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue/)
    expect(html).toContain(PREFLIGHT_COPY.NEEDS_ONE)
    expect(html).toContain(PREFLIGHT_COPY.SKIP)
  })

  it('opens the way before the rows are read only as a wait, never a block', () => {
    const html = view(null)
    expect(html).toContain(PREFLIGHT_COPY.CHECKING)
    expect(html).not.toContain('class="fr-row ')
  })

  it('shows the line that is running on its own button', () => {
    const html = view(gaps, { running: { line: 'brew install tmux', lastLine: 'Pouring tmux', oauth: false, url: null } })
    expect(html).toContain('running… Pouring tmux')
  })

  it('holds every other fix while a line runs: its next key is that line’s, a password maybe', () => {
    const html = view(gaps, { running: { line: 'brew install tmux', lastLine: '', oauth: false, url: null } })
    expect(html.match(/class="fr-fix"[^>]*disabled=""|disabled=""[^>]*class="fr-fix"/g)).toHaveLength(3)
  })

  it('says why a press did nothing', () => {
    expect(view(gaps, { error: 'the Setup card did not appear on the canvas' })).toContain('role="alert"')
  })
})

describe('the first screen', () => {
  const screen = (folder: string | null): string =>
    renderToStaticMarkup(<FirstScreenView folder={folder} problem={null} onChoose={vi.fn()} onExample={vi.fn()} />)

  it('asks the one question, with the three examples', () => {
    const html = screen(null)
    expect(html).toContain(FIRST_SCREEN_COPY.ASK)
    for (const task of EXAMPLE_TASKS) expect(html).toContain(task)
    expect(html.match(/class="fr-example"/g)).toHaveLength(3)
  })

  it('has no field of its own: the words go in the app’s one prompt box', () => {
    const html = screen(null)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })

  it('offers the folder, then shows it', () => {
    expect(screen(null)).toContain(FIRST_SCREEN_COPY.FOLDER)
    expect(screen(null)).not.toContain('fr-folder-word')
    const html = screen('/Users/new/site')
    expect(html).toContain('site')
    expect(html).toContain('/Users/new/site')
    expect(html).toContain(FIRST_SCREEN_COPY.FOLDER_CHANGE)
  })
})

describe('the hints', () => {
  it('offers the phone with a way to say no', () => {
    const html = renderToStaticMarkup(<HintCard kind="phone" onGo={vi.fn()} onClose={vi.fn()} />)
    expect(html).toContain(HINT_COPY.PHONE_TITLE)
    expect(html).toContain(HINT_COPY.PHONE_GO)
    expect(html).toContain(HINT_COPY.NOT_NOW)
    expect(html).not.toContain('aria-modal')
  })

  it('teaches the second agent, and closes', () => {
    const html = renderToStaticMarkup(<HintCard kind="second" onGo={vi.fn()} onClose={vi.fn()} />)
    expect(html).toContain(HINT_COPY.SECOND_TITLE)
    expect(html).toContain(HINT_COPY.SECOND_GO)
  })
})
