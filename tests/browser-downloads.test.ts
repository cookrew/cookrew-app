// A BROWSER CARD'S DOWNLOADS ARE FOR THE AGENT TOO.
//
// Left alone a headless Chrome saves into ~/Downloads and tells nobody: six
// Telegram files landed there on 2026-11-06 and no agent could say where they
// went. Each card now saves into its own directory and names every file there.
// Measured on Chrome 157: `allow` overwrites a second file of the same name,
// so Chrome is told to use its guid and the name is ours to give.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserDownloadsDir,
  DownloadWatcher,
  downloadFileName,
  downloadsReport,
  listDownloads
} from '../src/main/browser-downloads'

type Handler = (params: Record<string, unknown>) => void

function fakeCdp(sendResult: () => Promise<unknown> = () => Promise.resolve({})) {
  const handlers = new Map<string, Handler>()
  return {
    on: (method: string, cb: Handler) => void handlers.set(method, cb),
    send: vi.fn((_method: string, _params?: Record<string, unknown>) => sendResult()),
    fire: (method: string, params: Record<string, unknown>) => handlers.get(method)?.(params)
  }
}

describe('downloadFileName', () => {
  it('leaves an ordinary name alone', () => {
    expect(downloadFileName('goat-usdc-usdt-workers.json')).toBe('goat-usdc-usdt-workers.json')
  })

  it('keeps a Chinese name, which is most of what arrives in a chat', () => {
    expect(downloadFileName('合同 最终版.pdf')).toBe('合同-最终版.pdf')
  })

  it('leaves nothing a shell would act on in a pasted path', () => {
    expect(downloadFileName('line_break $(x).txt')).toBe('line_break-x.txt')
    expect(downloadFileName('a`b`;c&d.txt')).toBe('a-b-c-d.txt')
  })

  it('cannot leave the directory or hide in it', () => {
    expect(downloadFileName('../../evil.sh')).toBe('evil.sh')
    expect(downloadFileName('.bashrc')).toBe('bashrc')
  })

  it('drops the invisible characters that disguise an extension', () => {
    expect(downloadFileName('invoice‮fdp.exe')).toBe('invoice-fdp.exe')
    expect(downloadFileName('a\x1b[2Jb.txt')).toBe('a-2Jb.txt')
  })

  it('stays under a file name limit in bytes, extension kept', () => {
    const name = downloadFileName(`${'𠀋'.repeat(200)}.pdf`)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(240)
    expect(name.endsWith('.pdf')).toBe(true)
  })

  it('still gives something to a name with nothing left in it', () => {
    expect(downloadFileName('...')).toBe('download')
    expect(downloadFileName('')).toBe('download')
  })
})

describe('browserDownloadsDir', () => {
  it('is one directory per card, outside the folder macOS guards', () => {
    expect(browserDownloadsDir('card-1')).toBe(path.join(homedir(), '.cookrew', 'downloads', 'card-1'))
    expect(browserDownloadsDir('card-1', '/root')).toBe('/root/card-1')
  })
})

describe('DownloadWatcher', () => {
  let dir: string

  beforeEach(() => {
    dir = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-downloads-')), 'card')
  })

  const finish = (cdp: ReturnType<typeof fakeCdp>, guid: string, name: string, body: string): void => {
    cdp.fire('Browser.downloadWillBegin', { guid, suggestedFilename: name, url: 'https://x.test/f' })
    writeFileSync(path.join(dir, guid), body)
    cdp.fire('Browser.downloadProgress', { guid, state: 'completed', receivedBytes: body.length, totalBytes: body.length })
  }

  it('asks Chrome for guid names in this card\'s directory, with events', async () => {
    const cdp = fakeCdp()
    await new DownloadWatcher(dir).attach(cdp)
    expect(cdp.send).toHaveBeenCalledWith('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: dir,
      eventsEnabled: true
    })
    expect(existsSync(dir)).toBe(true)
  })

  it('listens before it asks, so the first event is not missed', async () => {
    const cdp = fakeCdp()
    const order: string[] = []
    const on = cdp.on
    cdp.on = (method, cb) => { order.push(method); on(method, cb) }
    cdp.send.mockImplementation(async (method) => { order.push(method); return {} })
    await new DownloadWatcher(dir).attach(cdp)
    expect(order.at(-1)).toBe('Browser.setDownloadBehavior')
  })

  it('a card still works when Chrome refuses, and the refusal is not silent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cdp = fakeCdp(() => Promise.reject(new Error('no such method')))
    await expect(new DownloadWatcher(dir).attach(cdp)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no such method'))
    error.mockRestore()
  })

  it('gives a finished file its name', async () => {
    const cdp = fakeCdp()
    await new DownloadWatcher(dir).attach(cdp)
    finish(cdp, 'guid-1', 'report.json', '{}')
    expect(readdirSync(dir)).toEqual(['report.json'])
  })

  it('never lets a second file of the same name take the first one\'s place', async () => {
    const cdp = fakeCdp()
    await new DownloadWatcher(dir).attach(cdp)
    finish(cdp, 'guid-1', 'same.json', 'first')
    finish(cdp, 'guid-2', 'same.json', 'second')
    expect(readdirSync(dir).sort()).toEqual(['same-2.json', 'same.json'])
    expect(readFileSync(path.join(dir, 'same.json'), 'utf8')).toBe('first')
    expect(readFileSync(path.join(dir, 'same-2.json'), 'utf8')).toBe('second')
  })

  it('reports what is still arriving, and forgets it when it lands or stops', async () => {
    const cdp = fakeCdp()
    const watcher = new DownloadWatcher(dir)
    await watcher.attach(cdp)
    cdp.fire('Browser.downloadWillBegin', { guid: 'g', suggestedFilename: 'big.bin' })
    cdp.fire('Browser.downloadProgress', { guid: 'g', state: 'inProgress', receivedBytes: 10, totalBytes: 40 })
    expect(watcher.active()).toEqual([{ name: 'big.bin', receivedBytes: 10, totalBytes: 40 }])
    cdp.fire('Browser.downloadProgress', { guid: 'g', state: 'canceled', receivedBytes: 10, totalBytes: 40 })
    expect(watcher.active()).toEqual([])
  })

  it('never prints a page\'s raw name, it reaches the agent\'s terminal', async () => {
    const cdp = fakeCdp()
    const watcher = new DownloadWatcher(dir)
    await watcher.attach(cdp)
    cdp.fire('Browser.downloadWillBegin', { guid: 'g', suggestedFilename: 'a\x1b]0;owned\x07.txt' })
    expect(watcher.active()[0].name).toBe('a-0-owned.txt')
  })

  it('names a file Chrome announced without saying what it is called', async () => {
    const cdp = fakeCdp()
    await new DownloadWatcher(dir).attach(cdp)
    finish(cdp, 'guid-1', undefined as unknown as string, '{}')
    expect(readdirSync(dir)).toEqual(['download'])
  })

  it('leaves the file where it is when the name cannot be given', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cdp = fakeCdp()
    await new DownloadWatcher(dir).attach(cdp)
    cdp.fire('Browser.downloadWillBegin', { guid: 'gone', suggestedFilename: 'a.txt' })
    expect(() => cdp.fire('Browser.downloadProgress', { guid: 'gone', state: 'completed' })).not.toThrow()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('listDownloads', () => {
  it('is empty for a card that never saved anything', () => {
    expect(listDownloads('/nonexistent/cookrew-downloads')).toEqual([])
  })

  it('gives absolute paths, newest first, without files still arriving', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-downloads-'))
    writeFileSync(path.join(dir, 'old.txt'), 'a')
    writeFileSync(path.join(dir, 'new.txt'), 'bb')
    writeFileSync(path.join(dir, 'part.bin.crdownload'), 'c')
    mkdirSync(path.join(dir, 'not-a-file'))
    utimesSync(path.join(dir, 'old.txt'), new Date(1000), new Date(1000))
    utimesSync(path.join(dir, 'new.txt'), new Date(2000), new Date(2000))
    expect(listDownloads(dir).map((f) => [f.path, f.bytes])).toEqual([
      [path.join(dir, 'new.txt'), 2],
      [path.join(dir, 'old.txt'), 1]
    ])
    expect(listDownloads(dir)[0].modifiedAt).toBe(statSync(path.join(dir, 'new.txt')).mtimeMs)
  })
})

describe('downloadsReport', () => {
  it('says where files will land when there are none, so the next step is known', () => {
    expect(downloadsReport('/d/card', [], [])).toBe('No downloads yet. They land in /d/card')
  })

  it('puts one path per line, ready to read', () => {
    const report = downloadsReport(
      '/d/card',
      [{ path: '/d/card/a.json', bytes: 4170, modifiedAt: Date.UTC(2026, 10, 6, 2, 52) }],
      [{ name: 'big.bin', receivedBytes: 10, totalBytes: 40 }]
    )
    expect(report.split('\n')).toEqual([
      'downloading big.bin (10 of 40 bytes)',
      '/d/card/a.json\t4170 bytes\t2026-11-06T02:52:00.000Z'
    ])
  })

  it('does not invent a total Chrome does not know', () => {
    expect(downloadsReport('/d', [], [{ name: 'x', receivedBytes: 5, totalBytes: 0 }])).toBe('downloading x (5 bytes)')
  })
})
