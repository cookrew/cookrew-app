import { describe, expect, it } from 'vitest'
import {
  parseServeAddress,
  orchLineCommand,
  orchTerminalNode,
  type ImportFace,
  type ServeTarget
} from '../src/main/import-session'

const TARGET: ServeTarget = { origin: 'http://192.168.1.20:8639', slug: 'research-crew' }
const FACE: ImportFace = {
  name: 'Research Crew',
  serviceId: 'svc-research-crew',
  slug: 'research-crew',
  door: 'Conductor',
  access: 'account',
  version: 1,
  agents: 4
}

describe('import a served team — the caller enters through one door', () => {
  it('parses the address an owner hands out, with or without a scheme', () => {
    expect(parseServeAddress('http://192.168.1.20:8639/research-crew')).toEqual(TARGET)
    expect(parseServeAddress('192.168.1.20:8639/research-crew')).toEqual(TARGET)
    expect(parseServeAddress('  http://192.168.1.20:8639/research-crew  ')).toEqual(TARGET)
  })

  it('refuses addresses that claim more than one door', () => {
    expect(parseServeAddress('')).toBeNull()
    expect(parseServeAddress('http://a.example/')).toBeNull()
    expect(parseServeAddress('http://a.example/two/deep')).toBeNull()
    expect(parseServeAddress('http://user:pw@a.example/slug')).toBeNull()
    expect(parseServeAddress('http://a.example/slug?x=1')).toBeNull()
    expect(parseServeAddress('http://a.example/UPPER')).toBeNull()
    expect(parseServeAddress('ftp://a.example/slug')).toBeNull()
  })

  it('the placed command is JSON-quoted argv with no payment state', () => {
    const command = orchLineCommand('/app/orch-line.mjs', TARGET, 'Research Crew')
    expect(command).toBe(
      'node "/app/orch-line.mjs" "--origin" "http://192.168.1.20:8639" "--slug" "research-crew" "--name" "Research Crew"'
    )
    expect(command).not.toContain('pay')
  })

  it('places exactly ONE terminal — the orch, marked orch, named for the team', () => {
    const node = orchTerminalNode(FACE, TARGET, '/app/orch-line.mjs', 'term_x', '/work', {
      x: 10,
      y: 10
    })
    expect(node.kind).toBe('terminal')
    expect(node.name).toBe('Research Crew')
    expect(node.orch).toBe(true)
    expect(node.preset).toBe('Remote')
    expect(node.command).toContain('orch-line.mjs')
    expect(node.command).toContain('research-crew')
  })
})
