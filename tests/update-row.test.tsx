// THE UPDATE ROWS in ⋯: a switch, and a way to the download page when there is
// something to download. Where the bridge has no such call the row is not there.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateRowsView } from '../src/renderer/src/UpdateRow'

const draw = (on: boolean, version: string | null): string =>
  renderToStaticMarkup(
    <UpdateRowsView
      status={{ on, available: version === null ? null : { version, url: `https://github.com/cookrew/cookrew-app/releases/tag/v${version}` } }}
      onToggle={() => undefined}
      onOpen={() => undefined}
    />
  )

describe('UpdateRowsView', () => {
  it('says the switch is on, and what it sends', () => {
    const html = draw(true, null)
    expect(html).toContain('Check for updates on')
    expect(html).toContain('GitHub')
    expect(html).toContain('aria-pressed="true"')
  })

  it('off reads off', () => {
    expect(draw(false, null)).toContain('Check for updates off')
  })

  it('offers the version it found', () => {
    expect(draw(true, '0.5.0')).toContain('Download Cookrew 0.5.0')
  })

  it('offers nothing when nothing was found', () => {
    expect(draw(true, null)).not.toContain('Download')
  })
})
