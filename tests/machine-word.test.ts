import { describe, expect, it } from 'vitest'
import { TheMachine, thisMachine } from '../src/shared/machine-word'

describe('what the app calls the computer it runs on', () => {
  it('says Mac on a Mac', () => {
    expect(thisMachine('darwin')).toBe('this Mac')
    expect(TheMachine('darwin')).toBe('This Mac')
  })

  it('never says Mac anywhere else (box user test 2, bug 15)', () => {
    expect(thisMachine('linux')).toBe('this computer')
    expect(TheMachine('win32')).toBe('This computer')
  })
})
