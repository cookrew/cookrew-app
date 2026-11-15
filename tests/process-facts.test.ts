import { describe, expect, it } from 'vitest'
import { parseProcessLine, processFact } from '../src/main/process-facts'

describe('parseProcessLine', () => {
  it('a running process, with the start that tells it from a later one on the same pid', () => {
    expect(parseProcessLine('S+   Thu Nov  5 12:00:00 2026\n')).toEqual({ state: 'running', started: 'Thu Nov  5 12:00:00 2026' })
  })

  it('a zombie has ended, though its pid still answers a signal 0', () => {
    expect(parseProcessLine('Z    Thu Nov  5 12:00:00 2026\n')).toEqual({ state: 'gone' })
  })

  it('nothing listed is gone', () => {
    expect(parseProcessLine('  \n')).toEqual({ state: 'gone' })
  })
})

describe('processFact', () => {
  it('concludes nothing on Windows, where there is no POSIX ps to ask', async () => {
    await expect(processFact(process.pid, 'win32')).resolves.toEqual({ state: 'unknown' })
  })

  // Skipped on Windows: these read the real ps, which only POSIX hosts have.
  it.skipIf(process.platform === 'win32')('reads a real process', async () => {
    await expect(processFact(process.pid)).resolves.toMatchObject({ state: 'running' })
  })

  it.skipIf(process.platform === 'win32')('a pid nobody holds is gone', async () => {
    await expect(processFact(4_000_000)).resolves.toEqual({ state: 'gone' })
  })
})
