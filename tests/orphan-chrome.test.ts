// The app half of the Chrome leak: a headless Chromium whose Electron parent
// died hard is still running, holding its profile and its renderers.
import { describe, expect, it } from 'vitest'
import { orphanChromePids, reapOrphanChrome } from '../src/main/orphan-chrome'

const BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = '/Users/drej/Library/Application Support/cookrew/interactive-browser'

const ps = [
  `  201     1 ${BIN} --headless=new --user-data-dir=${ROOT}/card-a`,
  `  202     1 ${BIN} --type=renderer --user-data-dir=${ROOT}/card-a`,
  `  203  7000 ${BIN} --headless=new --user-data-dir=${ROOT}/card-b`,
  `  204     1 ${BIN} --headless=new --user-data-dir=/var/folders/T/cookrew-dom-probe-x`,
  `  205     1 /bin/sh -c "tail -f ${ROOT}/card-a/Log"`,
  ''
].join('\n')

describe('orphanChromePids — the app’s own leftovers', () => {
  it('takes the card’s browser and its helpers once the app is gone', () => {
    expect(orphanChromePids(ps, ROOT)).toEqual([201, 202])
  })

  it('leaves a Chromium whose app is running', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(203)
  })

  it('is scoped to this app, so a test-launcher leftover is not touched', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(204)
  })

  it('never kills a non-browser that merely names the profile', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(205)
  })
})

describe('reapOrphanChrome — the boot sweep', () => {
  it('kills exactly the planned pids and reports them', () => {
    const killed: number[] = []
    const pids = reapOrphanChrome(ROOT, {
      ps: () => `  11     1 ${BIN} --user-data-dir=${ROOT}/a\n  12   500 ${BIN} --user-data-dir=${ROOT}/b\n`,
      kill: (pid) => killed.push(pid)
    })
    expect(pids).toEqual([11])
    expect(killed).toEqual([11])
  })

  it('boot never fails because ps did', () => {
    expect(
      reapOrphanChrome(ROOT, {
        ps: () => {
          throw new Error('no ps')
        },
        kill: () => {
          throw new Error('unreachable')
        }
      })
    ).toEqual([])
  })
})
