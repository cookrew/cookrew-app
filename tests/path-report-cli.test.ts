import { describe, expect, it } from 'vitest'
import { cmdPathReports, type SocketServerDeps } from '../src/main/socket-server'
import { createPathReportStore } from '../src/main/path-reports'
import type { CliRequest } from '../src/shared/model'

const request = (over: Partial<CliRequest> = {}): CliRequest => ({ id: 'test', cmd: 'path', args: ['reports'], flags: {}, terminalId: '', ...over })

describe('local path report command', () => {
  it('prints only fixed-vocabulary summaries, with no free text or address', () => {
    const store = createPathReportStore({ log: () => undefined })
    store.record({ deviceId: null }, { at: 1, plane: 'LAN', permission: 'unsupported', browser: 'secret.example', attempts: [], probes: [{ kind: 'rtc', name: '192.168.2.40', outcome: 'answered', ms: 7 }] })
    const output = cmdPathReports(request(), { pathReportStore: store } as unknown as SocketServerDeps)
    expect(output).toContain('answered')
    expect(output).not.toContain('192.168')
    expect(output).not.toContain('secret')
  })

  it('never offers full free-text output or alternate subcommands', () => {
    const deps = { pathReportStore: createPathReportStore() } as unknown as SocketServerDeps
    expect(() => cmdPathReports(request({ flags: { full: true } }), deps)).toThrow()
    expect(() => cmdPathReports(request({ args: ['other'] }), deps)).toThrow()
  })
})
