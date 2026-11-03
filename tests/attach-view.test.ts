import { beforeEach, describe, expect, it } from 'vitest'
import { attachView } from '../src/renderer/src/attach-view'

describe('attachView', () => {
  beforeEach(() => attachView.close())
  it('tapping an item opens it; tapping it again closes it; another item replaces it', () => {
    attachView.toggle('t1', 'b1', 'browser')
    expect(attachView.get()).toMatchObject({ terminalId: 't1', itemId: 'b1', full: false, rect: null })
    attachView.toggle('t1', 'n1', 'note')
    expect(attachView.get()?.itemId).toBe('n1')
    attachView.toggle('t1', 'n1', 'note')
    expect(attachView.get()).toBeNull()
  })
  it('closing for another terminal leaves this one open', () => {
    attachView.toggle('t1', 'b1', 'browser')
    attachView.close('t2')
    expect(attachView.get()?.terminalId).toBe('t1')
    attachView.close('t1')
    expect(attachView.get()).toBeNull()
  })
  it('only a browser goes full window, and the slot rect is kept', () => {
    attachView.toggle('t1', 'n1', 'note')
    attachView.full()
    expect(attachView.get()?.full).toBe(false)
    attachView.toggle('t1', 'b1', 'browser')
    attachView.place({ x: 1, y: 2, width: 300, height: 200 })
    attachView.full()
    expect(attachView.get()).toMatchObject({ full: true, rect: { width: 300 } })
    attachView.full(false)
    expect(attachView.get()?.full).toBe(false)
  })
  it('an unchanged rect does not publish a new view', () => {
    attachView.toggle('t1', 'b1', 'browser')
    attachView.place({ x: 1, y: 2, width: 3, height: 4 })
    const before = attachView.get()
    attachView.place({ x: 1, y: 2, width: 3, height: 4 })
    expect(attachView.get()).toBe(before)
  })
})
