// READING A PAGE, AND PRESSING ONE ELEMENT OF IT (main/dom-mirror.ts): the
// device sends a ref and a verb; nothing else reaches the page.
import { describe, expect, it, vi } from 'vitest'
import { actOnMirror, blockOf, captureMirror, mirrorSend, pixelProbe } from '../src/main/dom-mirror'

const ax = (over: Record<string, unknown>) => ({ nodeId: '1', ...over })

describe('an AX node as a block', () => {
  it('a heading keeps its level and its text', () => {
    expect(blockOf(ax({ role: { value: 'heading' }, name: { value: 'Report' }, backendDOMNodeId: 7, properties: [{ name: 'level', value: { value: 2 } }] }) as never))
      .toEqual({ ref: 7, role: 'heading', text: 'Report', level: 2 })
  })

  it('a field says its label and what it holds', () => {
    expect(blockOf(ax({ role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'a@b.c' }, backendDOMNodeId: 8 }) as never))
      .toMatchObject({ ref: 8, role: 'field', text: 'Email', value: 'a@b.c' })
  })

  it('a link keeps a usable address and drops one that could run code', () => {
    expect(blockOf(ax({ role: { value: 'link' }, name: { value: 'Docs' }, description: { value: 'https://example.com/d' }, backendDOMNodeId: 9 }) as never)).toMatchObject({ href: 'https://example.com/d' })
    expect(blockOf(ax({ role: { value: 'link' }, name: { value: 'Bad' }, description: { value: 'javascript:alert(1)' }, backendDOMNodeId: 10 }) as never)?.href).toBeUndefined()
  })

  it('ignored nodes and roles the mirror does not draw are left out', () => {
    expect(blockOf(ax({ ignored: true, role: { value: 'button' }, backendDOMNodeId: 1 }) as never)).toBeNull()
    expect(blockOf(ax({ role: { value: 'generic' }, backendDOMNodeId: 2 }) as never)).toBeNull()
    expect(blockOf(ax({ role: { value: 'button' } } as never))).toBeNull()
  })
})

describe('the page', () => {
  it('is in reading order and says when it was cut', async () => {
    const nodes = [
      ax({ role: { value: 'heading' }, name: { value: 'Inbox' }, backendDOMNodeId: 1, properties: [{ name: 'level', value: { value: 1 } }] }),
      ax({ role: { value: 'paragraph' }, name: { value: 'Two new messages' }, backendDOMNodeId: 2 }),
      ax({ role: { value: 'button' }, name: { value: 'Archive' }, backendDOMNodeId: 3 })
    ]
    const send = vi.fn(async () => ({ nodes }))
    const page = await captureMirror({ send }, 'https://example.com/inbox', 'Inbox')
    expect(page.blocks.map((b) => b.text)).toEqual(['Inbox', 'Two new messages', 'Archive'])
    expect(page.truncated).toBe(false)
    expect(page.pixelOnly).toBe(false)
  })

  it('says the screen is the better source when a canvas or frame is there', async () => {
    const send = vi.fn(async () => ({ nodes: [] }))
    const page = await captureMirror({ send, probe: async () => ['canvas'] }, 'u', 't')
    expect(page.pixelOnly).toBe(true)
  })

  it('a probe that fails is not evidence either way', async () => {
    const send = vi.fn(async () => ({ nodes: [] }))
    const page = await captureMirror({ send, probe: async () => { throw new Error('gone') } }, 'u', 't')
    expect(page.pixelOnly).toBe(false)
  })

  it('a read the page refuses throws, so the caller keeps its stream', async () => {
    const send = vi.fn(async () => { throw new Error('no target') })
    await expect(captureMirror({ send }, 'u', 't')).rejects.toThrow()
  })
})

describe('pressing an element', () => {
  const ok = (answer: unknown = { object: { objectId: 'obj-1' } }) => vi.fn(async (_method: string, _params: Record<string, unknown>) => answer)

  it('resolves the ref and calls OUR function, never the caller’s', async () => {
    const send = ok()
    expect(await actOnMirror({ send }, { ref: 42, act: 'press' })).toEqual({ ok: true })
    expect(send.mock.calls.map(([method]) => method)).toEqual(['DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject'])
    const [, call] = send.mock.calls.find(([method]) => method === 'Runtime.callFunctionOn')!
    expect(String(call.functionDeclaration)).toContain('this.click()')
    expect(call.arguments).toEqual([])
  })

  it('types through the prototype setter, so the page sees a person’s change', async () => {
    const send = ok()
    expect(await actOnMirror({ send }, { ref: 7, act: 'type', value: 'hello' })).toEqual({ ok: true })
    const [, call] = send.mock.calls.find(([method]) => method === 'Runtime.callFunctionOn')!
    expect(String(call.functionDeclaration)).toContain("new Event('input'")
    expect(call.arguments).toEqual([{ value: 'hello' }])
  })

  it('refuses an unknown verb, a bad ref, and a type with nothing to type', async () => {
    const send = ok()
    expect(await actOnMirror({ send }, { ref: 1, act: 'eval' as never })).toMatchObject({ ok: false })
    expect(await actOnMirror({ send }, { ref: 0, act: 'press' })).toMatchObject({ ok: false })
    expect(await actOnMirror({ send }, { ref: 1, act: 'type' })).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('says an element is gone when CDP cannot resolve it', async () => {
    const send = vi.fn(async (method: string) => method === 'DOM.resolveNode' ? ({}) : ({}))
    expect(await actOnMirror({ send }, { ref: 3, act: 'press' })).toMatchObject({ ok: false, why: 'That element is gone.' })
  })
})

describe('the pixel probe', () => {
  it('asks only our own fixed expression', async () => {
    const asked: string[] = []
    const probe = pixelProbe(async (expression) => {
      asked.push(expression)
      return ['canvas', 'div']
    })
    expect(await probe()).toEqual(['canvas', 'div'])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain("querySelectorAll('canvas,video,iframe,embed,object')")
    expect(asked[0]).not.toContain('${')
  })
})

describe('the CDP a mirror may reach', () => {
  it('passes the four methods a mirror needs and refuses everything else', async () => {
    const inner = vi.fn(async () => ({}))
    const send = mirrorSend(inner)
    for (const method of ['Accessibility.getFullAXTree', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject']) {
      await send(method, {})
    }
    expect(inner).toHaveBeenCalledTimes(4)
    for (const forbidden of ['Runtime.evaluate', 'Page.navigate', 'Network.getCookies', 'Input.dispatchKeyEvent']) {
      await expect(send(forbidden, {})).rejects.toThrow('not part of a mirror')
    }
    expect(inner).toHaveBeenCalledTimes(4)
  })
})
