// E2 probe — real-parser uuid pairing across every claude terminal.
// Run with: npx tsx scratchpad/qa-p1-e2-probe.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { parseClaudeTrace, traceIndexOf } from '../src/shared/trace-blocks.ts'
import { mergeCheckpointRows } from '../src/renderer/src/transcript.ts'
import { pinAnchors } from '../src/shared/version-pin.ts'

const home = homedir()
const wsRoot = path.join(home, '.cookrew', 'workspaces')
const projDir = (cwd) => path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'))

let terms = 0
let mispaired = 0
let paired = 0
let segmentDropped = 0
let pinDrawn = 0
let pinOmitted = 0
let pinWrong = 0
const details = []

for (const ws of readdirSync(wsRoot)) {
  const f = path.join(wsRoot, ws, 'workspace.json')
  if (!existsSync(f)) continue
  const doc = JSON.parse(readFileSync(f, 'utf8'))
  for (const n of doc.nodes ?? []) {
    if (n.kind !== 'terminal' || !(n.command ?? '').includes('claude')) continue
    const sid = n.claudeSessionId
    if (!sid) continue
    const sessionFile = path.join(projDir(n.cwd ?? ''), `${sid}.jsonl`)
    const ledgerFile = path.join(home, '.cookrew', 'turns', `${n.id}.jsonl`)
    if (!existsSync(sessionFile) || !existsSync(ledgerFile)) continue
    const blocks = parseClaudeTrace(readFileSync(sessionFile, 'utf8').split('\n'))
    if (blocks.length === 0) continue
    const entries = traceIndexOf(blocks)
    const idOf = new Map(entries.map((e) => [e.index, e.id]))
    const records = readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r.index === 'number')
    const rows = mergeCheckpointRows(records, entries)
    terms++
    let localMis = 0
    for (const row of rows) {
      if (!row.record || !row.record.uuid) continue
      if (row.record.uuid === idOf.get(row.index)) paired++
      else { mispaired++; localMis++ }
    }
    const uuidRecords = new Set(records.filter((r) => r.uuid).map((r) => r.uuid))
    const traceIds = new Set(entries.map((e) => e.id))
    for (const u of uuidRecords) if (!traceIds.has(u)) segmentDropped++
    // pins
    const pinFile = path.join(home, '.cookrew', 'pins', `${n.id}.json`)
    if (existsSync(pinFile)) {
      const pins = JSON.parse(readFileSync(pinFile, 'utf8'))
      const anchors = pinAnchors(pins, rows)
      pinDrawn += anchors.length
      pinOmitted += pins.length - anchors.length
      for (const p of pins) {
        if (!p.atUuid) continue
        const at = rows.findIndex((r) => r.id === p.atUuid)
        if (at >= 0) {
          const drawn = anchors.find((a) => a.version === p.version)
          if (!drawn || Math.abs(drawn.frac - at / rows.length) > 1e-9) pinWrong++
        }
      }
    }
    if (localMis > 0) details.push(`${n.id.slice(0, 8)}: ${localMis} mispaired`)
  }
}

console.log(JSON.stringify({ terms, paired, mispaired, segmentDropped, pinDrawn, pinOmitted, pinWrong, details }, null, 1))
