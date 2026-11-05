import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreflightView } from '../src/renderer/src/first-run/Preflight'
import { FirstScreenView } from '../src/renderer/src/first-run/FirstScreen'
import { HintCard } from '../src/renderer/src/first-run/FirstRunHints'
import { FirstWaitView } from '../src/renderer/src/first-run/FirstWait'
import { AccessRowsView, EndpointFormView, editForm } from '../src/renderer/src/first-run/AccessRows'
import { ACCESS_ROWS } from '../src/shared/agent-access'
import { ENDPOINT_COPY, EXAMPLE_TASKS, FIRST_SCREEN_COPY, HINT_COPY, PREFLIGHT_COPY, SETUP_LINE_COPY, TOOL_NOTES, WAIT_COPY } from '../src/shared/first-run-copy'
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

  it('says a line is running, and offers the way to end it', () => {
    const html = view(gaps, { running: { line: 'brew install tmux', lastLine: '', oauth: false, url: null } })
    expect(html).toContain(SETUP_LINE_COPY.WAITING)
    expect(html).toContain(`>${SETUP_LINE_COPY.STOP}<`)
    expect(view(gaps)).not.toContain(`>${SETUP_LINE_COPY.STOP}<`)
  })

  it('N2: says out loud when the pane wants a password', () => {
    const html = view(gaps, { running: { line: 'brew install tmux', lastLine: 'Password:', oauth: false, url: null, asking: 'password' } })
    expect(html).toContain(SETUP_LINE_COPY.PASSWORD)
    expect(html).not.toContain(SETUP_LINE_COPY.WAITING)
  })

  it('N2: a refused press gets its sentence and the way to clear the pane, with the buttons left on', () => {
    const html = view(gaps, { error: SETUP_LINE_COPY.BUSY, stuck: true })
    expect(html).toContain(SETUP_LINE_COPY.BUSY)
    expect(html).toContain(`>${SETUP_LINE_COPY.STOP}<`)
    expect(html).not.toMatch(/class="fr-fix"[^>]*disabled=""|disabled=""[^>]*class="fr-fix"/)
  })

  it('says why a press did nothing', () => {
    expect(view(gaps, { error: 'the Setup card did not appear on the canvas' })).toContain('role="alert"')
  })
})

describe('a form problem lands where it can be seen (N8)', () => {
  // On the box the sentence was drawn, 250 px below the fold: "no message, no change".
  const form = { protocol: 'anthropic', baseUrl: '', key: 'k', model: 'm', simple: false } as const
  const html = (over: Partial<Parameters<typeof EndpointFormView>[0]>): string =>
    renderToStaticMarkup(<EndpointFormView form={form} busy={false} problem="Address is empty." onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} {...over} />)

  it('sits under the field it is about, marked for a screen reader', () => {
    const page = html({ problemField: 'baseUrl' })
    expect(page.indexOf('Address is empty.')).toBeLessThan(page.indexOf(ENDPOINT_COPY.KEY))
    expect(page).toMatch(/aria-invalid="true"/)
    expect(page.match(/role="alert"/g)).toHaveLength(1)
  })

  it('names each field so the one refused can take the focus', () => {
    const page = html({})
    for (const name of ['baseUrl', 'key', 'model']) expect(page).toContain(`name="${name}"`)
  })

  it('falls back to the foot of the form when it is about no field', () => {
    const page = html({})
    expect(page.indexOf('Address is empty.')).toBeGreaterThan(page.indexOf(ENDPOINT_COPY.MODEL))
  })
})

describe('the wait pane shows the whole of what it asks (N7)', () => {
  it('has room, and a box that scrolls past what type size cannot fit', () => {
    const css = readFileSync(path.join(__dirname, '../src/renderer/src/first-run/first-run.css'), 'utf8')
    const rule = css.slice(css.indexOf('.fr-wait .fr-setup > :last-child'))
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/overflow: auto/)
  })

  it('asks the screen for the whole of it', () => {
    const source = readFileSync(path.join(__dirname, '../src/renderer/src/first-run/FirstWait.tsx'), 'utf8')
    expect(source).toMatch(/<SetupScreen[^>]*fit="whole"/)
  })
})

describe('what the form says of the key is what the code does (N4)', () => {
  const form = { protocol: 'anthropic', baseUrl: '', key: '', model: '', simple: false } as const
  const note = (keyStore: 'keychain' | 'file'): string => renderToStaticMarkup(<EndpointFormView form={form} keyStore={keyStore} busy={false} problem={null} onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} />)

  it('says a private file, plainly, where it is one', () => {
    expect(note('file')).toContain('Stored in a private file on this computer')
    expect(note('file')).toContain('not encrypted')
    expect(note('file')).not.toMatch(/keychain|sealed/i)
  })

  it('names the keychain only where it holds the key', () => {
    expect(note('keychain')).toContain('keychain')
  })

  it('has lost the word that overclaimed', () => {
    expect(JSON.stringify(ENDPOINT_COPY)).not.toMatch(/seal/i)
  })
})

describe('a saved endpoint can be changed (N3)', () => {
  const active = { id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', model: 'm-1', host: 'api.example.com', baseUrl: 'https://api.example.com', simple: false, tools: ['Pi', 'Claude Code'] } as const
  const row = (onEdit = vi.fn()): string => renderToStaticMarkup(<AccessRowsView state={{ rows: ACCESS_ROWS, keyStore: 'file', active }} onOpen={vi.fn()} onEdit={onEdit} onRemove={vi.fn()} />)

  it('offers Edit beside Remove', () => {
    expect(row()).toContain(`>${ENDPOINT_COPY.EDIT}<`)
    expect(row()).toContain(`>${ENDPOINT_COPY.REMOVE}<`)
  })

  it('says what became of agents still on the old address', () => {
    const html = renderToStaticMarkup(<AccessRowsView state={{ rows: ACCESS_ROWS, keyStore: 'file', active }} note={ENDPOINT_COPY.MOVED} onOpen={vi.fn()} onRemove={vi.fn()} />)
    expect(html).toContain(ENDPOINT_COPY.MOVED)
  })

  it('opens the form on what is saved, with the key field empty and saying what empty means', () => {
    const form = editForm(active)
    expect(form).toEqual({ protocol: 'anthropic', baseUrl: 'https://api.example.com', key: '', model: 'm-1', simple: false })
    const html = renderToStaticMarkup(<EndpointFormView form={form} editing busy={false} problem={null} onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(html).toContain('value="https://api.example.com"')
    expect(html).toContain(ENDPOINT_COPY.KEY_KEEP)
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
  const none = { rows: ACCESS_ROWS, keyStore: 'file' as const, active: null }
  const form = { protocol: 'anthropic' as const, baseUrl: '', key: '', model: '', simple: false }
  const fields = (over: Partial<Parameters<typeof EndpointFormView>[0]> = {}): string =>
    renderToStaticMarkup(<EndpointFormView form={form} busy={false} problem={null} onChange={vi.fn()} onSave={vi.fn()} onCancel={vi.fn()} {...over} />)

  it('lists every row it is given: a credits row is one more entry', () => {
    const rows = [...ACCESS_ROWS, { id: 'credits', title: 'Use Cookrew credits', does: 'Pay as you go.', form: 'endpoint' as const }]
    const html = renderToStaticMarkup(<AccessRowsView state={{ rows, keyStore: 'file', active: null }} onOpen={vi.fn()} onRemove={vi.fn()} />)
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
    const active = { id: 'endpoint', label: 'Your endpoint', protocol: 'openai' as const, model: 'm', host: 'a.example', baseUrl: 'https://a.example', simple: false, tools: ['Pi'] }
    expect(renderToStaticMarkup(<AccessRowsView state={{ ...none, active }} whenActive onOpen={vi.fn()} onRemove={vi.fn()} />)).toContain('a.example')
  })

  it('shows what is on, without the key, and how to take it off', () => {
    const html = renderToStaticMarkup(
      <AccessRowsView state={{ ...none, active: { id: 'endpoint', label: 'Your endpoint', protocol: 'anthropic', model: 'm-1', host: 'api.example.com', baseUrl: 'https://api.example.com', simple: false, tools: ['Claude Code', 'Pi'] } }} onOpen={vi.fn()} onRemove={vi.fn()} />
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
