// A HARNESS NOTICE IS NOT THE OWNER SPEAKING (phone report 2026-11-01).
//
// When a background task finishes, Claude Code wakes the agent with a
// user-role <task-notification> block. Cookrew read it as the owner's prompt:
// the card said "You: <task-notification>", CHAT drew the XML as the owner's
// bubble, and the checkpoint was titled from it ("Task completion for task_id
// abfe…"). It stays a checkpoint (Claude counts it as a turn), so these pin
// what each surface SAYS about it, with the block exactly as a session file
// holds it.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { isHarnessNotice, noticeLine } from '../src/shared/harness-notice'
import { checkpointViewModel, turnViewOf } from '../src/renderer/src/turn-view-model'
import { checkpointTitle } from '../src/renderer/src/checkpoint-sync'
import { checkpointRowTitle, type CheckpointRow } from '../src/renderer/src/stream/stream-rows'
import { buildTitlePrompt } from '../src/shared/sous'
import { TranscriptRow } from '../src/renderer/src/TranscriptRow'
import { PastTurnView } from '../src/renderer/src/nodes/TurnPager'
import type { TraceBlock } from '../src/shared/trace-blocks'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'

const NOTICE = [
  '<task-notification>',
  '<task-id>abfe529184a5ed</task-id>',
  '<tool-use-id>toolu_01CbzwEarWPNFMcqqya7ZmDR</tool-use-id>',
  '<output-file>/private/tmp/claude-501/tasks/abfe529184a5ed.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "Review socket leak fix diff" finished</summary>',
  '<note>A task-notification fires each time this agent stops with no live background children of its own.</note>',
  '</task-notification>'
].join('\n')
const SAID = 'Agent "Review socket leak fix diff" finished'

describe('recognising one', () => {
  it('the block as a session file holds it', () => {
    expect(isHarnessNotice(NOTICE)).toBe(true)
    expect(noticeLine(NOTICE)).toBe(SAID)
  })
  it('only its head, as the stream index stores it', () => {
    expect(isHarnessNotice('<task-notification>')).toBe(true)
    expect(noticeLine('<task-notification>')).toBe('Background task reported back')
  })
  it('a status without a summary', () => {
    expect(noticeLine('<task-notification>\n<status>failed</status>\n</task-notification>')).toBe(
      'Background task failed'
    )
  })
  it('never a prompt the owner typed, even one that talks about the tag', () => {
    expect(isHarnessNotice('why does <task-notification> show up as me?')).toBe(false)
    expect(isHarnessNotice('fix the build')).toBe(false)
    expect(isHarnessNotice(null)).toBe(false)
  })
})

describe('the card: no "You:" line for it', () => {
  it('a latest checkpoint started by a notice has no ask; what it says is the title', () => {
    const model = checkpointViewModel({ prompt: NOTICE, reply: 'CLI and ports 5173, 8639 and 8643' })
    expect(model?.ask).toBeNull()
    expect(model?.title).toBe(SAID)
    expect(model?.latest?.text).toBe('CLI and ports 5173, 8639 and 8643')
  })
  it('a Sous title still wins when there is one', () => {
    expect(checkpointViewModel({ prompt: NOTICE, reply: 'ok', title: 'Socket leak review done' })?.title).toBe(
      'Socket leak review done'
    )
  })
  it('a live turn started by a notice has no ask either', () => {
    const activity = { phase: 'thinking', prompt: NOTICE, title: null, reply: null } as unknown as TerminalActivity
    const model = turnViewOf(activity)
    expect(model.ask).toBeNull()
    expect(model.title).toBe(SAID)
  })
  it('the owner\'s own prompt keeps its "You:" line', () => {
    expect(checkpointViewModel({ prompt: 'fix the build', reply: 'done' })?.ask).toBe('fix the build')
  })
})

describe('the checkpoint title is not made from the XML', () => {
  const record = { index: 5, prompt: NOTICE, reply: '' } as unknown as TurnRecord
  it('in both title modes, without a Sous title', () => {
    expect(checkpointTitle(record, 'precise')).toBe(SAID)
    expect(checkpointTitle(record, 'conclusion')).toBe(SAID)
  })
  it('the rail row, from the stored head alone', () => {
    const row = { index: 5, promptHead: '<task-notification>' } as unknown as CheckpointRow
    expect(checkpointRowTitle(row, 'precise')).toBe('Background task reported back')
    expect(checkpointRowTitle(row, 'conclusion')).toBe('Background task reported back')
  })
  it('Sous is told there was no request, and what reported back', () => {
    const prompt = buildTitlePrompt({ prompt: NOTICE, tools: [], lines: [] })
    expect(prompt).toContain(`a background task reported back: ${SAID}`)
    expect(prompt).not.toContain('task-id')
    expect(prompt).not.toContain('<task-notification>')
  })
})

describe('CHAT: a quiet line, not the owner\'s bubble', () => {
  const block = {
    id: 'u5',
    index: 5,
    prompt: NOTICE,
    reply: 'CLI and ports 5173, 8639 and 8643',
    activity: [],
    startedAt: 0,
    endedAt: 1
  } as unknown as TraceBlock
  const html = renderToStaticMarkup(
    <TranscriptRow id={5} block={block} active={false} placeholderHeight={undefined} titleMode="precise" translated={null} />
  )
  it('no prompt bubble and no XML', () => {
    expect(html).not.toContain('ctx-block-prompt')
    expect(html).not.toContain('task-notification&gt;')
    expect(html).not.toContain('toolu_01')
  })
  it('one notice line saying what woke the agent, and the reply as the agent\'s', () => {
    expect(html).toContain('class="ctx-block-notice"')
    expect(html).toContain('Agent &quot;Review socket leak fix diff&quot; finished')
    expect(html).toContain('ctx-chat-bubble')
  })
  it('the owner\'s own prompt is still their bubble', () => {
    const own = renderToStaticMarkup(
      <TranscriptRow
        id={4}
        block={{ ...block, index: 4, prompt: 'fix the build' }}
        active={false}
        placeholderHeight={undefined}
        titleMode="precise"
        translated={null}
      />
    )
    expect(own).toContain('class="ctx-block-prompt"')
    expect(own).not.toContain('ctx-block-notice')
  })
})

describe('a past turn on the card pager', () => {
  it('says Task:, never You:', () => {
    const html = renderToStaticMarkup(
      <PastTurnView record={{ index: 5, prompt: NOTICE, reply: 'ok', startedAt: 0, endedAt: 1 } as unknown as TurnRecord} />
    )
    expect(html).not.toContain('You:')
    expect(html).toContain('Task:')
    expect(html).toContain(SAID.replace(/"/g, '&quot;'))
  })
})
