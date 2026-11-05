import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreflightView } from '../src/renderer/src/first-run/Preflight'
import { FirstScreenView } from '../src/renderer/src/first-run/FirstScreen'
import { HintCard } from '../src/renderer/src/first-run/FirstRunHints'
import { FirstWaitView } from '../src/renderer/src/first-run/FirstWait'
import { AccessRowsView, EndpointFormView } from '../src/renderer/src/first-run/AccessRows'
import { ACCESS_ROWS } from '../src/shared/agent-access'
import { ENDPOINT_COPY, EXAMPLE_TASKS, FIRST_SCREEN_COPY, HINT_COPY, PREFLIGHT_COPY, TOOL_NOTES, WAIT_COPY } from '../src/shared/first-run-copy'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../src/shared/preflight'

const green: ToolFacts = {
  claude: 'found', claudeSignedIn: true, codex: 'found', codexSignedIn: true, pi: 'found', opencode: 'found', herdr: 'found', tmux: 'found',
  chrome: 'found', magpie: 'found', ollama: 'found', brew: 'found', npm: 'found', host: 'herdr', platform: 'darwin', arch: 'arm64'
}
const gaps: ToolFacts = { ...green, codex: 'missing', codexSignedIn: null, pi: 'found', herdr: 'missing', tmux: 'missing', host: 'direct', ollama: 'missing' }
const none: ToolFacts = { ...gaps, claude: 'missing', claudeSignedIn: null, pi: 'missing', opencode: 'missing' }
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
    expect(html.match(/class="fr-row /g)).toHaveLength(8)
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

  it('marks the check that came back from Skip with the same screen', () => {
    expect(view(none)).toContain(PREFLIGHT_COPY.SKIP)
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

  it('lets go of them when the person asks to check again: a prompt it cannot read must not lock the screen', () => {
    const html = view(gaps, { running: { line: 'brew install tmux', lastLine: '', oauth: false, url: null }, released: true })
    expect(html).not.toMatch(/class="fr-fix"[^>]*disabled=""|disabled=""[^>]*class="fr-fix"/)
  })

  it('says why a press did nothing', () => {
    expect(view(gaps, { error: 'the Setup card did not appear on the canvas' })).toContain('role="alert"')
  })
})

describe('the first screen', () => {
  const screen = (folder: string | null): string =>
    renderToStaticMarkup(<FirstScreenView folder={folder} problem={null} onChoose={vi.fn()} onExample={vi.fn()} onCheck={vi.fn()} onLater={vi.fn()} />)

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

describe('the first screen after a skip or a dead agent (bugs 3, 6)', () => {
  const screen = (problem: string | null): string =>
    renderToStaticMarkup(<FirstScreenView folder={null} problem={problem} onChoose={vi.fn()} onExample={vi.fn()} onCheck={vi.fn()} onLater={vi.fn()} />)

  it('always has the way back to the tool check, and a way to look around', () => {
    expect(screen(null)).toContain(FIRST_SCREEN_COPY.RECHECK)
    expect(screen(null)).toContain(FIRST_SCREEN_COPY.LATER)
  })

  it('says why the agent did not take the task', () => {
    expect(screen('Claude Code stopped before it took your task.')).toContain('Claude Code stopped before it took your task.')
  })

  it('shows what to do and the last lines, as the card would', () => {
    const html = renderToStaticMarkup(
      <FirstScreenView folder={null} problem="pi stopped (exit 1)." detail={{ fix: 'Its last lines are below. Send again to start it again.', lines: ['Error: no model', '<b>raw</b>'] }} onChoose={vi.fn()} onExample={vi.fn()} onCheck={vi.fn()} onLater={vi.fn()} />
    )
    expect(html).toContain('Its last lines are below.')
    expect(html).toContain('Error: no model')
    expect(html).not.toContain('<b>raw</b>')
  })

  it('says what the workspace is called now that it has a folder', () => {
    const html = renderToStaticMarkup(<FirstScreenView folder="/Users/new/my-site" problem={null} onChoose={vi.fn()} onExample={vi.fn()} onCheck={vi.fn()} onLater={vi.fn()} />)
    expect(html).toContain(FIRST_SCREEN_COPY.named('my-site'))
  })
})

describe('an agent that is waiting (bug 4)', () => {
  const view = (wait: 'starting' | 'choice' | 'sign-in' | 'consent', children?: React.ReactNode): string =>
    renderToStaticMarkup(
      <FirstWaitView task={{ state: 'holding', id: 'a', words: 'write a readme', harness: 'Claude Code', wait }} onCancel={vi.fn()} onEndpoint={vi.fn()}>
        {children}
      </FirstWaitView>
    )

  it('says a choice is waiting, in place of RESTING, and shows the task it is holding', () => {
    const html = view('choice')
    expect(html).toContain(WAIT_COPY.choice.title('Claude Code'))
    expect(html).toContain('write a readme')
    expect(html).not.toMatch(/resting/i)
  })

  it('tells a sign-in apart, and offers the road for a person with no account', () => {
    const html = view('sign-in')
    expect(html).toContain(WAIT_COPY['sign-in'].title('Claude Code'))
    expect(html).toContain(WAIT_COPY.NO_ACCOUNT)
    expect(view('choice')).not.toContain(WAIT_COPY.NO_ACCOUNT)
  })

  it('says which row to take on the consent, whose default row exits', () => {
    expect(view('consent')).toContain('Yes, I accept')
  })

  it('shows the live screen to answer in, once there is something to answer', () => {
    expect(view('choice', <i id="pane" />)).toContain('id="pane"')
    expect(view('starting', <i id="pane" />)).not.toContain('id="pane"')
  })

  it('can always be called off', () => {
    expect(view('starting')).toContain(WAIT_COPY.CANCEL)
  })
})

describe('the road with no account', () => {
  const none = { rows: ACCESS_ROWS, active: null }
  const form = { protocol: 'anthropic' as const, baseUrl: '', key: '', model: '', simple: false }
  const fields = (over: Partial<Parameters<typeof EndpointFormView>[0]> = {}): string =>
    renderToStaticMarkup(<EndpointFormView form={form} busy={false} problem={null} onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} {...over} />)

  it('lists every row it is given: a credits row is one more entry', () => {
    const rows = [...ACCESS_ROWS, { id: 'credits', title: 'Use Cookrew credits', does: 'Pay as you go.', form: 'endpoint' as const }]
    const html = renderToStaticMarkup(<AccessRowsView state={{ rows, active: null }} onOpen={vi.fn()} onRemove={vi.fn()} />)
    expect(html).toContain(ENDPOINT_COPY.HEAD)
    expect(html).toContain('Use your own endpoint')
    expect(html).toContain('Use Cookrew credits')
  })

  it('asks for the address, the key and the model, with the key masked', () => {
    const html = fields()
    expect(html).toContain(ENDPOINT_COPY.URL)
    expect(html).toContain(ENDPOINT_COPY.MODEL)
    expect(html).toMatch(/type="password"/)
    expect(html).toContain('autoComplete="off"')
  })

  it('says each protocol runs on which tool, and what Codex needs', () => {
    expect(fields()).toContain(ENDPOINT_COPY.ANTHROPIC)
    expect(fields()).toContain(ENDPOINT_COPY.OPENAI)
  })

  it('tells the truth about Claude Code on someone else’s Anthropic-style endpoint, and offers simple mode', () => {
    const html = fields({ form: { ...form, baseUrl: 'https://llm.example.com' } })
    expect(html).toContain(ENDPOINT_COPY.THIRD_PARTY)
    expect(html).toContain(ENDPOINT_COPY.SIMPLE)
    expect(html).toMatch(/type="checkbox"/)
    expect(ENDPOINT_COPY.THIRD_PARTY).toMatch(/Pi/)
  })

  it('keeps that out of the way on Anthropic’s own API, and for an OpenAI-style one', () => {
    expect(fields({ form: { ...form, baseUrl: 'https://api.anthropic.com' } })).not.toContain(ENDPOINT_COPY.THIRD_PARTY)
    expect(fields({ form: { ...form, protocol: 'openai' } })).not.toContain(ENDPOINT_COPY.SIMPLE)
  })

  it('shows why it was refused, and waits while it asks', () => {
    expect(fields({ problem: 'The endpoint refused that key.' })).toContain('role="alert"')
    expect(fields({ busy: true })).toContain(ENDPOINT_COPY.SAVING)
  })

  it('stays out of an existing person’s Routing panel until they have one', () => {
    expect(renderToStaticMarkup(<AccessRowsView state={none} whenActive onOpen={vi.fn()} onRemove={vi.fn()} />)).toBe('')
    const active = { id: 'endpoint', label: 'Your endpoint', protocol: 'openai' as const, model: 'm', host: 'a.example', tools: ['Pi'] }
    expect(renderToStaticMarkup(<AccessRowsView state={{ ...none, active }} whenActive onOpen={vi.fn()} onRemove={vi.fn()} />)).toContain('a.example')
  })

  it('shows what is on, without the key, and how to take it off', () => {
    const html = renderToStaticMarkup(
      <AccessRowsView state={{ ...none, active: { id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', model: 'm-1', host: 'api.example.com', tools: ['Claude Code', 'Pi'] } }} onOpen={vi.fn()} onRemove={vi.fn()} />
    )
    expect(html).toContain('api.example.com')
    expect(html).toContain('m-1')
    expect(html).toContain(ENDPOINT_COPY.REMOVE)
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
