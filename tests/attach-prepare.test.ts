// THE FILES A PHONE PICKED, MADE READY TO GO UP (prompt/attach-prepare.ts):
// each one kept, compressed, or refused with its reason, one at a time, with
// progress and a way to stop. The browser's codecs and canvas are stood in for.
import { describe, expect, it } from 'vitest'
import { AttachStopped, prepareAttachments, sendOneByOne, type Compressors } from '../src/renderer/src/prompt/attach-prepare'
import { MAC_LIMIT, RELAY_LIMIT } from '../src/shared/attachment-limit'

const MB = 1024 * 1024

/** A file of `size` bytes without allocating them. */
const sized = (name: string, type: string, size: number): File => {
  const file = new File([], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}
const blobOf = (size: number, type = 'video/mp4'): Blob => {
  const blob = new Blob([], { type })
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

interface Calls {
  readonly videoBps: number[]
  readonly images: string[]
}

const fakes = (over: Partial<Compressors> = {}): { compressors: Compressors; calls: Calls } => {
  const calls: Calls = { videoBps: [], images: [] }
  const compressors: Compressors = {
    probeVideo: async () => ({ seconds: 60, width: 1920, height: 1080 }),
    encodeVideo: async (_file, plan, progress) => {
      calls.videoBps.push(plan.videoBps)
      progress(0.5)
      progress(1)
      return blobOf(((plan.videoBps + plan.audioBps) * 60) / 8)
    },
    probeImage: async () => ({ width: 4032, height: 3024 }),
    encodeImage: async (file) => {
      calls.images.push(file.name)
      return blobOf(700 * 1024, 'image/jpeg')
    },
    ...over
  }
  return { compressors, calls }
}

describe('a video', () => {
  it('goes up compressed, as an .mp4 under its own name, with its progress said', async () => {
    const { compressors } = fakes()
    const seen: string[] = []
    const [ready] = await prepareAttachments([sized('IMG_0042.MOV', 'video/quicktime', 180 * MB)], {
      limit: MAC_LIMIT,
      onProgress: (p) => seen.push(`${p.name} ${p.index}/${p.total} ${Math.round(p.fraction * 100)}`)
    }, compressors)
    expect(ready.name).toBe('IMG_0042.mp4')
    expect(ready.type).toBe('video/mp4')
    expect(ready.size).toBeLessThan(20 * MB)
    expect(seen).toEqual(['IMG_0042.MOV 1/1 0', 'IMG_0042.MOV 1/1 50', 'IMG_0042.MOV 1/1 100'])
  })

  it('is tried once more at a lower bitrate when the encoder overshoots the path', async () => {
    let tries = 0
    const { compressors, calls } = fakes({
      encodeVideo: async (_file, plan) => {
        calls.videoBps.push(plan.videoBps)
        tries += 1
        return blobOf(tries === 1 ? 5 * MB : 3 * MB)
      }
    })
    const [ready] = await prepareAttachments([sized('clip.mp4', 'video/mp4', 40 * MB)], { limit: RELAY_LIMIT }, compressors)
    expect(ready.size).toBe(3 * MB)
    expect(calls.videoBps).toHaveLength(2)
    expect(calls.videoBps[1]).toBeLessThan(calls.videoBps[0])
  })

  it('that still does not fit is refused, naming the path', async () => {
    const { compressors } = fakes({ encodeVideo: async () => blobOf(5 * MB) })
    await expect(prepareAttachments([sized('clip.mp4', 'video/mp4', 40 * MB)], { limit: RELAY_LIMIT }, compressors)).rejects.toThrow(
      /^clip\.mp4 is still 5 MB compressed; through the relay attachments stop at 4 MB/
    )
  })

  it('too long is refused before any encoding', async () => {
    const { compressors, calls } = fakes({ probeVideo: async () => ({ seconds: 900, width: 1920, height: 1080 }) })
    await expect(prepareAttachments([sized('long.mp4', 'video/mp4', 900 * MB)], { limit: MAC_LIMIT }, compressors)).rejects.toThrow(
      'long.mp4 is 15:00 long; a video can be up to 10:00'
    )
    expect(calls.videoBps).toEqual([])
  })

  it('this browser cannot compress goes as it is when it fits, and is refused saying why when not', async () => {
    const cannot = fakes({ encodeVideo: async () => Promise.reject(new Error('no H.264 encoder')) }).compressors
    const [small] = await prepareAttachments([sized('a.mp4', 'video/mp4', 30 * MB)], { limit: MAC_LIMIT }, cannot)
    expect(small.name).toBe('a.mp4')
    await expect(prepareAttachments([sized('b.mp4', 'video/mp4', 300 * MB)], { limit: MAC_LIMIT }, cannot)).rejects.toThrow(
      'b.mp4 is 300 MB and this browser could not make it smaller; the Mac takes attachments up to 100 MB'
    )
    const unreadable = fakes({ probeVideo: async () => null }).compressors
    const [kept] = await prepareAttachments([sized('c.mkv', 'video/x-matroska', 2 * MB)], { limit: MAC_LIMIT }, unreadable)
    expect(kept.name).toBe('c.mkv')
  })

  it('compressed larger than it was is sent as it was', async () => {
    const { compressors } = fakes({ encodeVideo: async () => blobOf(50 * MB) })
    const [ready] = await prepareAttachments([sized('done.mp4', 'video/mp4', 45 * MB)], { limit: MAC_LIMIT }, compressors)
    expect(ready.name).toBe('done.mp4')
    expect(ready.size).toBe(45 * MB)
  })
})

describe('a picture', () => {
  it('a phone photo goes up as a smaller .jpg; a screenshot goes untouched', async () => {
    const { compressors, calls } = fakes({
      probeImage: async (file) => (file.name === 'shot.png' ? { width: 1080, height: 2340 } : { width: 4032, height: 3024 })
    })
    const [photo, shot] = await prepareAttachments(
      [sized('IMG_1.HEIC.jpeg', 'image/jpeg', 6 * MB), sized('shot.png', 'image/png', 800 * 1024)],
      { limit: MAC_LIMIT },
      compressors
    )
    expect(photo.name).toBe('IMG_1.HEIC.jpg')
    expect(photo.type).toBe('image/jpeg')
    expect(photo.size).toBe(700 * 1024)
    expect(shot.name).toBe('shot.png')
    expect(calls.images).toEqual(['IMG_1.HEIC.jpeg'])
  })

  it('one the browser cannot read is treated as a file', async () => {
    const { compressors } = fakes({ probeImage: async () => null })
    await expect(prepareAttachments([sized('odd.png', 'image/png', 120 * MB)], { limit: MAC_LIMIT }, compressors)).rejects.toThrow(
      'odd.png is 120 MB; the Mac takes attachments up to 100 MB'
    )
  })
})

describe('any other file', () => {
  it('goes as it is within the path, and is refused past it', async () => {
    const { compressors } = fakes()
    const [doc] = await prepareAttachments([sized('a.pdf', 'application/pdf', 3 * MB)], { limit: RELAY_LIMIT }, compressors)
    expect(doc.name).toBe('a.pdf')
    await expect(prepareAttachments([sized('b.zip', 'application/zip', 6 * MB)], { limit: RELAY_LIMIT }, compressors)).rejects.toThrow(
      /^b\.zip is 6 MB; through the relay attachments stop at 4 MB/
    )
  })
})

describe('stopping', () => {
  it('stops between files and inside an encode, and says so as its own AttachStopped, never a network AbortError', async () => {
    const stop = new AbortController()
    const { compressors, calls } = fakes({
      encodeVideo: async (_file, plan, _progress, signal) => {
        calls.videoBps.push(plan.videoBps)
        stop.abort()
        if (signal.aborted) throw new DOMException('stopped', 'AbortError')
        return blobOf(MB)
      }
    })
    const files = [sized('one.mp4', 'video/mp4', 90 * MB), sized('two.mp4', 'video/mp4', 90 * MB)]
    await expect(prepareAttachments(files, { limit: MAC_LIMIT, signal: stop.signal }, compressors)).rejects.toMatchObject({
      name: 'AttachStopped'
    })
    expect(calls.videoBps).toHaveLength(1)
  })
})

describe('what the box says while it works', () => {
  it('is short enough for a phone: which of how many, and how far', async () => {
    const { compressingSaid } = await import('../src/renderer/src/prompt/attach-prepare')
    expect(compressingSaid({ fraction: 0.456, index: 1, total: 1 })).toBe('compressing · 46%')
    expect(compressingSaid({ fraction: 1, index: 2, total: 3 })).toBe('compressing 2/3 · 100%')
  })
})

describe('sending a batch', () => {
  it('makes each file ready and sends it before touching the next, the paths in order', async () => {
    const order: string[] = []
    const { compressors } = fakes({
      encodeVideo: async (file, plan, progress) => {
        order.push(`compress ${file.name}`)
        progress(0.5)
        return blobOf(((plan.videoBps + plan.audioBps) * 60) / 8)
      }
    })
    const notes: string[] = []
    const paths = await sendOneByOne(
      [sized('a.mp4', 'video/mp4', 90 * MB), sized('b.mp4', 'video/mp4', 90 * MB)],
      async (ready) => {
        order.push(`send ${ready[0].name}`)
        return [`/att/${ready[0].name}`]
      },
      { limit: MAC_LIMIT, onNote: (said, compressing) => notes.push(`${said ?? '-'}${compressing ? ' ✕' : ''}`) },
      compressors
    )
    expect(order).toEqual(['compress a.mp4', 'send a.mp4', 'compress b.mp4', 'send b.mp4'])
    expect(paths).toEqual(['/att/a.mp4', '/att/b.mp4'])
    expect(notes).toEqual([
      '- ✕',
      'compressing 1/2 · 0% ✕',
      'compressing 1/2 · 50% ✕',
      'uploading 1/2…',
      '- ✕',
      'compressing 2/2 · 0% ✕',
      'compressing 2/2 · 50% ✕',
      'uploading 2/2…'
    ])
  })

  it('a stop sends nothing more, and is an AttachStopped — the box says nothing of it', async () => {
    const stop = new AbortController()
    const sent: string[] = []
    const { compressors } = fakes()
    const sending = sendOneByOne(
      [sized('a.pdf', 'application/pdf', MB), sized('b.pdf', 'application/pdf', MB)],
      async (ready) => {
        sent.push(ready[0].name)
        stop.abort()
        return ['/att/a.pdf']
      },
      { limit: MAC_LIMIT, signal: stop.signal, onNote: () => undefined },
      compressors
    )
    await expect(sending).rejects.toBeInstanceOf(AttachStopped)
    expect(sent).toEqual(['a.pdf'])
  })
})
