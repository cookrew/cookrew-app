// THE UPDATE ROWS in ⋯: a switch, and a way to the download page when there is
// something to download. Where the bridge has no such call the row is not there.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateRowsView } from '../src/renderer/src/UpdateRow'
import type { UpdateInstall } from '../src/shared/update-check'

const draw = (on: boolean, version: string | null, install: UpdateInstall = 'page', auto = false): string =>
  renderToStaticMarkup(
    <UpdateRowsView
      status={{ on, auto, install, available: version === null ? null : { version, url: `https://github.com/cookrew/cookrew-app/releases/tag/v${version}` } }}
      onToggle={() => undefined}
      onOpen={() => undefined}
      onRestart={() => undefined}
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

  it('a build that installs itself calls the switch what it is', () => {
    const html = draw(true, null, 'page', true)
    expect(html).toContain('Automatic updates on')
    expect(html).toContain('downloads it')
  })

  it('shows the download under way, and it cannot be pressed', () => {
    const html = draw(true, '0.5.0', 'downloading', true)
    expect(html).toContain('Downloading Cookrew 0.5.0')
    expect(html).toContain('disabled')
  })

  it('offers the restart once it is downloaded', () => {
    const html = draw(true, '0.5.0', 'ready', true)
    expect(html).toContain('Restart to update to 0.5.0')
    expect(html).not.toContain('Download Cookrew')
  })
})
