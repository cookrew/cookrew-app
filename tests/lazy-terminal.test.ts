import { describe, expect, it, vi } from 'vitest'
import { LazyTerminalAttachments } from '../src/main/lazy-terminal'

function harness(over: { attached?: boolean; working?: boolean } = {}) {
  let attached = over.attached ?? false
  let working = over.working ?? false
  const attach = vi.fn(() => {
    attached = true
    return true
  })
  const detach = vi.fn(() => {
    attached = false
  })
  const watchWorking = vi.fn()
  const lazy = new LazyTerminalAttachments({
    attach,
    detach,
    isWorking: () => working,
    watchWorking
  })
  return {
    lazy,
    attach,
    detach,
    watchWorking,
    attached: () => attached,
    setWorking: (value: boolean) => {
      working = value
    }
  }
}

describe('LazyTerminalAttachments', () => {
  it('does not open a PTY when startup observes a working agent', () => {
    const h = harness({ working: true })
    h.lazy.observeStatus('t1', 'working')
    expect(h.watchWorking).toHaveBeenCalledWith('t1')
    expect(h.attach).not.toHaveBeenCalled()
  })

  it('attaches on the first zoomed transcript and detaches after the last idle viewer', () => {
    const h = harness()
    expect(h.lazy.acquire('t1')).toBe(true)
    expect(h.lazy.acquire('t1')).toBe(true)
    expect(h.lazy.viewerCount('t1')).toBe(2)

    h.lazy.release('t1')
    expect(h.detach).not.toHaveBeenCalled()
    h.lazy.release('t1')
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.attached()).toBe(false)
  })

  it('keeps the mirror after zoom-out only while the agent is working', () => {
    const h = harness({ working: true })
    h.lazy.acquire('t1')
    h.lazy.release('t1')
    expect(h.detach).not.toHaveBeenCalled()

    h.setWorking(false)
    h.lazy.observeStatus('t1', 'idle')
    expect(h.detach).toHaveBeenCalledOnce()
  })

  it('does not count a viewer when attachment fails', () => {
    const detach = vi.fn()
    const lazy = new LazyTerminalAttachments({
      attach: () => false,
      detach,
      isWorking: () => false,
      watchWorking: () => undefined
    })
    expect(lazy.acquire('missing')).toBe(false)
    expect(lazy.viewerCount('missing')).toBe(0)
    expect(detach).not.toHaveBeenCalled()
  })

  it('does not treat blocked, idle, or done as active work', () => {
    const h = harness()
    for (const status of ['blocked', 'idle', 'done'] as const) {
      h.lazy.observeStatus('t1', status)
    }
    expect(h.watchWorking).not.toHaveBeenCalled()
    expect(h.attach).not.toHaveBeenCalled()
  })
})
