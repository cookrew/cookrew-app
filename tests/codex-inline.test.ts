import { describe, expect, it } from 'vitest'
import { CODEX_INLINE_FLAG, codexInlineLine } from '../src/main/codex-inline'

describe('codexInlineLine', () => {
  it('runs a bare codex in inline mode', () => {
    expect(codexInlineLine('codex')).toBe(`codex ${CODEX_INLINE_FLAG}`)
  })

  it('puts the flag right after the binary, ahead of a resume subcommand', () => {
    expect(codexInlineLine('codex resume 01a1cdcf-c5cb-7740-bac6-5dd5a852ee62')).toBe(
      `codex ${CODEX_INLINE_FLAG} resume 01a1cdcf-c5cb-7740-bac6-5dd5a852ee62`
    )
  })

  it("keeps the card's own options after the flag", () => {
    expect(codexInlineLine('codex --yolo -m gpt-5.6-sol')).toBe(`codex ${CODEX_INLINE_FLAG} --yolo -m gpt-5.6-sol`)
  })

  it('keeps leading whitespace as it was', () => {
    expect(codexInlineLine('  codex resume abc')).toBe(`  codex ${CODEX_INLINE_FLAG} resume abc`)
  })

  it('leaves a card that already chose its screen mode alone', () => {
    expect(codexInlineLine('codex --no-alt-screen')).toBe('codex --no-alt-screen')
    expect(codexInlineLine('codex -c tui.alternate_screen=always')).toBe('codex -c tui.alternate_screen=always')
    expect(codexInlineLine(`codex ${CODEX_INLINE_FLAG} resume abc`)).toBe(`codex ${CODEX_INLINE_FLAG} resume abc`)
  })

  it('still runs inline when only a quoted prompt names the option', () => {
    expect(codexInlineLine('codex "fix the tui.alternate_screen bug"')).toBe(`codex ${CODEX_INLINE_FLAG} "fix the tui.alternate_screen bug"`)
    expect(codexInlineLine("codex -c 'tui.alternate_screen=always'")).toBe("codex -c 'tui.alternate_screen=always'")
  })

  it('touches nothing that is not codex', () => {
    expect(codexInlineLine('claude --resume abc')).toBe('claude --resume abc')
    expect(codexInlineLine('codexx')).toBe('codexx')
    expect(codexInlineLine('opencode')).toBe('opencode')
    expect(codexInlineLine('')).toBe('')
  })

  it('is the -c form, so it applies wherever codex reads global options', () => {
    expect(CODEX_INLINE_FLAG).toBe('-c tui.alternate_screen=never')
  })
})
