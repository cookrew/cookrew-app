import { describe, expect, it } from 'vitest'
import { summarizePathReports } from '../src/main/path-report-summary'
import { pathReportLine } from '../src/main/path-reports'
import type { StoredPathReport } from '../src/shared/path-report'

const report: StoredPathReport = {
  at: 1,
  receivedAt: 2,
  device: 'secret-device-192.168.2.40',
  plane: 'LAN',
  permission: 'unsupported',
  browser: 'private-mac.local',
  attempts: [{ name: '192.168.2.40:8643', outcome: 'private.example', detail: 'token-canary', ms: 4 }],
  probes: [{ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 12 }]
}

describe('local path-report summary', () => {
  it('emits fixed vocabulary and numbers, never free text or addresses', () => {
    const result = summarizePathReports([report])
    expect(result).toEqual([{ receivedAt: 2, plane: 'LAN', permission: 'unsupported', context: 'unknown', attempts: 1, probes: [{ kind: 'rtc', outcome: 'answered', ms: 50 }] }])
    const text = JSON.stringify(result)
    for (const secret of ['192.168', 'private', 'token-canary', 'secret-device']) expect(text).not.toContain(secret)
  })

  it('quantizes timings into fixed buckets rather than passing attacker-selected numbers', () => {
    const timed = { ...report, probes: [
      { kind: 'rtc' as const, name: 'x', outcome: 'answered', ms: 3232236072 },
      { kind: 'rtc' as const, name: 'x', outcome: 'answered', ms: 1234 },
      { kind: 'rtc' as const, name: 'x', outcome: 'answered', ms: -1 }
    ] }
    expect(summarizePathReports([timed])[0].probes.map((p) => p.ms)).toEqual(['over-120s', 2000, null])
  })

  it('does not copy a relay-selected device name or sender-controlled outcome into logs', () => {
    const hostile = { ...report, device: 'private.example', probes: [{ kind: 'rtc', name: 'x', outcome: '192.168.2.40', ms: 3 }] } as StoredPathReport
    const line = pathReportLine(hostile)
    expect(line).not.toContain('private.example')
    expect(line).not.toContain('192.168')
  })

  it('maps untrusted enum-looking values to unknown', () => {
    const hostile = { ...report, plane: '198.51.100.1', probes: [{ kind: 'secret', outcome: '198.51.100.2', ms: NaN }] } as unknown as StoredPathReport
    expect(summarizePathReports([hostile])).toEqual([{ receivedAt: 2, plane: 'unknown', permission: 'unsupported', context: 'unknown', attempts: 1, probes: [{ kind: 'unknown', outcome: 'unknown', ms: null }] }])
  })
})
