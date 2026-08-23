import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  changeOf,
  commitLabel,
  discard,
  isStaged,
  emptyStateFor,
  speakList,
  stageFrom,
  toggleAgent
} from '../src/renderer/src/grant-stage'
import {
  EXPORT_COPY,
  GRANT_COPY,
  REVOKE_COPY,
  clearsFieldOn,
  fill,
  pasteMessage
} from '../src/renderer/src/grant-copy'
import { exportStateOf } from '../src/renderer/src/grant-state'
import { canGrant } from '../src/renderer/src/GrantPanel'
import { stripComments } from './support/module-imports'

/**
 * THE GRANTING SURFACE, where its behaviour is decidable without a browser.
 *
 * Velvet split the gates deliberately: four need a real drive and are Magpie's,
 * three are assertions about the store and are asserted in
 * tests/grant-atlas-gates.test.ts. This file covers the third category she did
 * not have to name — the surface's own LOGIC, which is neither pixels nor the
 * store: what the commit button says, which way a failure was moving, and the
 * absence of a control.
 *
 * The absence checks are the interesting ones. "There is no select-all" cannot
 * be proven by using the surface — you can only fail to find one — so it is
 * asserted against the source, the same shape as the listener-reach sweep. A
 * bulk-grant control is precisely the accident this whole surface is built to
 * prevent, and its absence is a feature that must fail the build when removed.
 */

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'src')
const read = (file: string): string => readFileSync(path.join(SRC, file), 'utf8')
/**
 * CODE ONLY — comments may DISCUSS the control they must not contain.
 *
 * The first draft of these absence checks scanned the raw source and fired on
 * the very sentences explaining why the control is absent ("no select-all,
 * EVER"; "no autoFocus"). That is the species this branch keeps finding: a
 * guard that passes or fails on something adjacent to the thing it names. The
 * same stripper the listener-reach sweep uses fixes it here.
 */
const code = (file: string): string => stripComments(read(file))

const AGENTS: Record<string, string> = {
  'node-tinker': 'Tinker',
  'node-forge': 'Forge',
  'node-magpie': 'Magpie'
}
const nameOf = (id: string): string => AGENTS[id] ?? id

describe('§5 · ticks are staged, and nothing is granted until commit', () => {
  it('starts from what the record says', () => {
    const state = stageFrom(['node-forge'])
    expect(isStaged(state, 'node-forge')).toBe(true)
    expect(changeOf(state).clean).toBe(true)
  })

  it('a tick is a change that has not happened yet', () => {
    const state = toggleAgent(stageFrom([]), 'node-forge')
    expect(changeOf(state)).toMatchObject({ added: ['node-forge'], removed: [], clean: false })
  })

  it('discarding returns to the record — a staged grant is not a grant', () => {
    const staged = toggleAgent(toggleAgent(stageFrom(['node-forge']), 'node-tinker'), 'node-forge')
    expect(changeOf(staged).clean).toBe(false)
    expect(changeOf(discard(staged)).clean).toBe(true)
  })

  it('toggling is immutable — the prior state is still usable', () => {
    const before = stageFrom([])
    const after = toggleAgent(before, 'node-forge')
    expect(isStaged(before, 'node-forge')).toBe(false)
    expect(isStaged(after, 'node-forge')).toBe(true)
  })
})

describe('§5 · the commit carries the change, not a question', () => {
  it('names the caller, the count, and the consequence in words', () => {
    const state = toggleAgent(toggleAgent(stageFrom([]), 'node-tinker'), 'node-forge')
    expect(commitLabel('Kestrel', state, nameOf)).toEqual({
      button: 'GRANT KESTREL 2 AGENTS',
      consequence: 'Kestrel will be able to call Tinker and Forge.'
    })
  })

  it('says AGENT, not AGENTS, for one', () => {
    const state = toggleAgent(stageFrom([]), 'node-forge')
    expect(commitLabel('Kestrel', state, nameOf)?.button).toBe('GRANT KESTREL 1 AGENT')
  })

  it('offers nothing to commit when nothing is ticked', () => {
    // The control is absent rather than disabled-and-inert: there is no change
    // to confirm, so there is nothing to press.
    expect(commitLabel('Kestrel', stageFrom(['node-forge']), nameOf)).toBeNull()
  })

  it('a pure removal says so, and names what is lost', () => {
    const state = toggleAgent(stageFrom(['node-forge', 'node-tinker']), 'node-forge')
    expect(commitLabel('Kestrel', state, nameOf)).toEqual({
      button: 'UPDATE KESTREL TO 1 AGENT',
      consequence: 'Kestrel will be able to call Tinker, and will lose Forge.'
    })
  })

  it('removing everything is stated plainly rather than as "0 agents"', () => {
    const state = toggleAgent(stageFrom(['node-forge']), 'node-forge')
    expect(commitLabel('Kestrel', state, nameOf)).toEqual({
      button: 'REVOKE EVERY AGENT FROM KESTREL',
      consequence: 'Kestrel will not be able to call anything.'
    })
  })

  it('speaks a list the way a person would say it', () => {
    expect(speakList(['Tinker'])).toBe('Tinker')
    expect(speakList(['Tinker', 'Forge'])).toBe('Tinker and Forge')
    expect(speakList(['Tinker', 'Forge', 'Magpie'])).toBe('Tinker, Forge and Magpie')
    expect(speakList([])).toBe('nothing')
  })
})

describe('§7 · a failed commit branches on the DIRECTION of the change', () => {
  it('a removal that fails reports that they STILL HAVE ACCESS', () => {
    // The pair that matters. "Access is unchanged" is reassurance when the
    // change added access, and buries the fact that matters when it removed it.
    const removing = toggleAgent(stageFrom(['node-forge']), 'node-forge')
    expect(changeOf(removing).direction).toBe('remove')
    expect(fill(GRANT_COPY.errorCommitRemove.text, { name: 'Kestrel' })).toContain(
      'Kestrel still has access'
    )
  })

  it('an addition that fails reports that nothing was given', () => {
    const adding = toggleAgent(stageFrom([]), 'node-forge')
    expect(changeOf(adding).direction).toBe('add')
    expect(fill(GRANT_COPY.errorCommitAdd.text, { name: 'Kestrel' })).toContain(
      'was not given anything'
    )
  })

  it('a MIXED change reports as a removal — the frightening half first', () => {
    const mixed = toggleAgent(toggleAgent(stageFrom(['node-forge']), 'node-forge'), 'node-tinker')
    expect(changeOf(mixed)).toMatchObject({ added: ['node-tinker'], removed: ['node-forge'] })
    expect(changeOf(mixed).direction).toBe('remove')
  })

  it('the revoke failure leads with the frightening half too', () => {
    const text = fill(GRANT_COPY.errorRevoke.text, { name: 'Kestrel' })
    expect(text.indexOf('still have access')).toBeLessThan(text.indexOf('Try again'))
  })
})

describe('§6 · the revoke copy, and what it reports afterwards', () => {
  it('states the ruling, unsoftened', () => {
    expect(fill(REVOKE_COPY.line, { name: 'Kestrel' })).toBe(
      'Kestrel can’t call your agents. Any call in progress stops.'
    )
  })

  it('reports what actually happened, with the count', () => {
    expect(REVOKE_COPY.stopped(0)).toBe('No calls were running.')
    expect(REVOKE_COPY.stopped(1)).toBe('Stopped 1 call that was running.')
    expect(REVOKE_COPY.stopped(3)).toBe('Stopped 3 calls that were running.')
  })
})

describe('§4 · the paste messages name the problem', () => {
  it('names the algorithm rather than saying "invalid"', () => {
    expect(pasteMessage({ reason: 'wrongtype', type: 'RSA' }).text).toBe(
      'That’s a RSA key. Cookrew callers use ed25519.'
    )
  })

  it('a private key is the ONLY refusal that clears the field', () => {
    // Leaving a private key on screen is the harm continuing after we have
    // named it. Every other refusal leaves the paste so it can be fixed.
    expect(clearsFieldOn({ reason: 'private' })).toBe(true)
    for (const reason of ['notakey', 'malformed'] as const) {
      expect(clearsFieldOn({ reason })).toBe(false)
    }
    expect(clearsFieldOn({ reason: 'wrongtype', type: 'RSA' })).toBe(false)
  })

  it('tells the owner what to do about the exposure, not just that it happened', () => {
    const text = pasteMessage({ reason: 'private' }).text
    expect(text).toContain("Cookrew hasn't stored it")
    expect(text).toContain('replace the pair')
  })
})

// ---------------------------------------------------------------------------
// ABSENCE. These cannot be proven by using the surface — you can only fail to
// find the control — so they are asserted against the source, the same shape as
// the listener-reach sweep.
// ---------------------------------------------------------------------------

describe('the absence checks look at code, not at prose about the code', () => {
  it('the stripper removes the very sentences that would false-positive', () => {
    // Without this these checks fire on the comments EXPLAINING the absence,
    // which is a guard failing on something adjacent to what it names.
    expect(read('GrantPanel.tsx')).toMatch(/select[- ]?all/i)
    expect(code('GrantPanel.tsx')).not.toMatch(/select[- ]?all/i)
    expect(read('EnrolSheet.tsx')).toContain('autoFocus')
    expect(code('EnrolSheet.tsx')).not.toContain('autoFocus')
  })
})

describe('§0 · no bulk grant exists, and its absence must fail the build', () => {
  it('the staging model has no operation that ticks more than one agent', () => {
    // The single most important line in the deck. `toggleAgent` takes ONE node
    // id and is the only mutator; anything taking a list would be a select-all
    // wearing a different name.
    const source = code('grant-stage.ts')
    for (const banned of ['selectAll', 'toggleAll', 'grantAll', 'tickAll', 'stageAll']) {
      expect(source, `grant-stage.ts must not export ${banned}`).not.toContain(banned)
    }
    // Exactly one mutator, and it is singular.
    const mutators = source.match(/^export function \w+/gm) ?? []
    expect(mutators).toContain('export function toggleAgent')
  })

  it('the panel offers no control that grants every agent at once', () => {
    const panel = code('GrantPanel.tsx')
    expect(panel).not.toMatch(/select[- ]?all/i)
    expect(panel).not.toMatch(/GRANT ALL/i)
  })

  it('but revoke-all IS offered, because the asymmetry is the design', () => {
    // Removing access should be frictionless. commitLabel's zero case is the
    // whole-caller revoke, stated plainly.
    const state = toggleAgent(stageFrom(['node-forge']), 'node-forge')
    expect(commitLabel('Kestrel', state, nameOf)?.button).toContain('REVOKE EVERY AGENT')
  })
})

describe('§2 · the surface is desktop-owner-only, and ABSENT elsewhere', () => {
  it('canGrant is false without the owner bridge', () => {
    // A greyed-out list of who is enrolled still discloses who is enrolled, on
    // the device most likely to be lying on a table. So the entry point does
    // not render at all — asserted here, and driven by Magpie on the phone.
    expect(canGrant({})).toBe(false)
    expect(canGrant({ grantList: () => undefined })).toBe(false)
    expect(canGrant({ grantEnrol: () => undefined })).toBe(false)
  })

  it('canGrant is true only with the owner-only channels present', () => {
    expect(canGrant({ grantList: () => undefined, grantEnrol: () => undefined })).toBe(true)
  })

  it('the entry point is gated on it at the call site', () => {
    // A canGrant() that nothing consults would be a check that never runs.
    expect(code('App.tsx').replace(/\s+/g, ' ')).toContain(
      "view === 'agents' && canGrant()"
    )
  })
})

describe('§3 · the enrol sheet does not collect a reflex', () => {
  it('the primary is not autofocused and the sheet is not a form', () => {
    // Enter must not fire enrolment: a <form> submits from any field, which is
    // exactly the reflex the attestation exists to refuse. Magpie drives this
    // for real; this stops it regressing between drives.
    const sheet = code('EnrolSheet.tsx')
    expect(sheet).not.toContain('autoFocus')
    expect(sheet).not.toMatch(/<form/)
    expect(sheet).not.toContain("type=\"submit\"")
  })

  it('the button states the claim the click makes', () => {
    expect(code('EnrolSheet.tsx')).toContain('I COMPARED THESE · ENROL')
  })

  it('and says plainly that enrolling grants nothing', () => {
    expect(code('EnrolSheet.tsx')).toContain('Enrolling grants nothing')
  })
})

describe('§7 · which empty state a first-time owner is shown, and in what order', () => {
  it('nothing exportable comes FIRST — it is the actual next step', () => {
    // Enrolling somebody before any agent is exportable produces a caller with
    // nothing to grant, so the order is the teaching.
    expect(emptyStateFor({ agents: [], callers: [] })).toBe('no-export')
    expect(emptyStateFor({ agents: [], callers: ['someone'] })).toBe('no-export')
  })

  it('then "nobody can call", which states the default out loud', () => {
    expect(emptyStateFor({ agents: ['a'], callers: [] })).toBe('no-callers')
  })

  it('and no empty state once there is something to show', () => {
    expect(emptyStateFor({ agents: ['a'], callers: ['someone'] })).toBe('none')
  })
})

describe('the export entry point — Magpie give-up reason 1, first inch', () => {
  it('VELVET\'S SENTENCE 6 IS ON THE SURFACE, verbatim', () => {
    // Her audit's most important line. Exporting is safe by construction and
    // version-pin.ts opens with exactly this — as a CODE COMMENT that has never
    // been said to an author. It is the number-one reason not to export, it is
    // already true, and it costs nothing to say.
    expect(EXPORT_COPY.safety).toBe(
      'Callers get a copy. Your original conversation is never touched, never sent, ' +
        'and never resumed by anyone else.'
    )
    // And it is rendered as prose, not hidden behind a hover.
    expect(code('ExportToggle.tsx')).toContain('EXPORT_COPY.safety')
    expect(code('ExportToggle.tsx')).toContain('ex-safety')
  })

  it('access is legible AT REST, in the words she specified', () => {
    // "{n} callers" or "Nobody can call this" — the question is asked in a
    // glance, so an answer that costs a click is an answer nobody has.
    expect(EXPORT_COPY.atRest(0, true)).toBe('Nobody can call this')
    expect(EXPORT_COPY.atRest(1, true)).toBe('1 caller')
    expect(EXPORT_COPY.atRest(3, true)).toBe('3 callers')
    expect(EXPORT_COPY.atRest(0, false)).toBe('Not exportable')
  })

  it('an unread roster renders NOTHING rather than claiming "not exportable"', () => {
    // An unread roster and an unexported agent are different facts. Rendering
    // the second when we only know the first tells an author their agent is
    // private when it may be reachable from the internet.
    expect(exportStateOf(null, 'node-forge')).toBeNull()
  })

  it('reads one agent out of the roster, and defaults an absent one to closed', () => {
    const roster = {
      workspaceId: 'w1',
      callers: [],
      revoked: [],
      live: [],
      agents: [{ nodeId: 'node-forge', callers: ['kestrel'], inFlight: 2 }]
    }
    expect(exportStateOf(roster, 'node-forge')).toEqual({
      exportable: true,
      callers: 1,
      inFlight: 2
    })
    // Present roster, absent agent: genuinely not exported.
    expect(exportStateOf(roster, 'node-tinker')).toEqual({
      exportable: false,
      callers: 0,
      inFlight: 0
    })
  })

  it('the control is an INVITATION when off, not a checkbox', () => {
    // Magpie's finding was that zero of forty controls mentioned export at all.
    // A checkbox states a setting; this has to say there is something here.
    expect(EXPORT_COPY.turnOn).toBe('Let people call this agent')
    expect(code('ExportToggle.tsx')).not.toMatch(/type="checkbox"/)
  })

  it('and points at the next step once it is on', () => {
    expect(EXPORT_COPY.next).toContain('WHO CAN CALL')
    expect(EXPORT_COPY.onHint).toContain('nobody can call it until you grant someone')
  })
})

describe('the PUBLISH seam is stated, not mocked up', () => {
  it('says plainly what is not built', () => {
    // The honest repair for "no control mentions selling" is not a dead button
    // that opens nothing — an author who presses that learns we are unreliable,
    // which is worse than the gap.
    expect(EXPORT_COPY.publishSeam).toContain('isn’t built yet')
    expect(EXPORT_COPY.publishSeam).toMatch(/price|payout|listing/)
  })

  it('promises no scrub report, because this control publishes nothing', () => {
    // Velvet's scrub line belongs to the publish lane. Showing it here would be
    // a string whose behaviour does not exist — the defect this program keeps
    // finding — because exporting publishes nothing.
    const surface = [code('ExportToggle.tsx'), code('grant-copy.ts')].join('\n')
    expect(surface).not.toContain('strips secrets')
    expect(surface).not.toMatch(/shows you the report/)
  })

  it('ships no control that claims to price, sell or publish', () => {
    const surface = code('ExportToggle.tsx')
    for (const claim of ['PUBLISH', 'SET PRICE', 'SELL', 'PAYOUT']) {
      expect(surface, `no control may claim ${claim} in this lane`).not.toContain(claim)
    }
  })
})
