// THE GAUGES AS THEY ARE DRAWN. Static markup, the house way (no DOM env); what
// a real browser does with them, the render census included, is the QA run.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GaugeList, GaugeRow } from '../src/renderer/src/zoom/MachineGauges'
import type { MachineGauges as Reading } from '../src/shared/machine-gauges'

const GB = 1024 ** 3
const reading = (over: Partial<Reading> = {}): Reading => ({
  at: 1,
  cpuPercent: 34,
  memory: { usedBytes: 14.4 * GB, totalBytes: 16 * GB, swapUsedBytes: 9 * GB, kernelLevel: 2 },
  disk: { freeBytes: 212e9, totalBytes: 994e9 },
  gpuPercent: 12,
  gpuAbsent: false,
  ...over
})
const html = (r: Reading | null | undefined): string => renderToStaticMarkup(<GaugeRow reading={r} />)
const list = (machines: { id: string; name: string; local: boolean; online: boolean }[] = []): string =>
  renderToStaticMarkup(<GaugeList localName="This Mac" machines={machines} />)
const other = (over: Partial<{ id: string; name: string; online: boolean }> = {}) => ({ id: 'm2', name: 'Studio', local: false, online: true, ...over })

describe('a reading', () => {
  it('draws all four gauges', () => {
    const page = html(reading())
    for (const word of ['CPU', '34%', 'MEM', '14.4/16 GB', 'swap 9.0 GB', 'DISK', '212 GB free', 'GPU', '12%']) expect(page).toContain(word)
  })
  it('the memory gauge carries the tone, and the swap words carry it too', () => {
    const page = html(reading())
    expect(page).toMatch(/data-gauge="memory"[^>]*data-tone="hot"/)
    expect(page).toMatch(/zv-gauge-sub/)
    expect(page).toMatch(/data-gauge="cpu"[^>]*data-tone="calm"/)
  })
  it('a bar is a transform on a leaf, so a new sample lays nothing out', () => {
    expect(html(reading())).toContain('transform:scaleX(0.34)')
  })
  it('a single gauge with no reading is marked, so its words may wrap in a narrow column instead of being cut', () => {
    expect(html(reading({ gpuPercent: null }))).toMatch(/data-gauge="gpu"[^>]*data-none/)
    expect(html(reading())).not.toContain('data-none')
  })
  it('says what it is to a screen reader', () => {
    expect(html(reading())).toContain('aria-label="CPU 34%"')
    expect(html(reading())).toContain('aria-label="MEM 14.4/16 GB, swap 9.0 GB"')
  })
  it('a GPU with no reading says so, with no bar and no 0%', () => {
    const page = html(reading({ gpuPercent: null }))
    expect(page).toMatch(/data-gauge="gpu"[^>]*>.*no reading/)
    expect(page).not.toMatch(/data-gauge="gpu"[^>]*>.*scaleX/)
    expect(page).not.toContain('>0%<')
  })
})

describe('a machine with no GPU', () => {
  it('says GPU none, muted like a missing number, with no bar and no no reading', () => {
    const page = html(reading({ gpuPercent: null, gpuAbsent: true }))
    expect(page).toMatch(/data-gauge="gpu"[^>]*data-none[^>]*>.*>GPU<.*>none</)
    expect(page).not.toContain('no reading')
    expect(page).not.toMatch(/data-gauge="gpu"[^>]*>.*scaleX/)
    expect(page).toContain('aria-label="GPU none"')
  })
  it('a GPU that could not be read still says no reading', () => {
    expect(html(reading({ gpuPercent: null, gpuAbsent: false }))).toMatch(/data-gauge="gpu"[^>]*>.*no reading/)
  })
})

describe('no reading at all', () => {
  it('one line says so, not four empty gauges', () => {
    const page = html(null)
    expect(page).toContain('no reading')
    expect(page.match(/no reading/g)).toHaveLength(1)
    expect(page).not.toContain('data-gauge')
  })
  it('before the first answer it is the gauges waiting, not a claim', () => {
    const page = html(undefined)
    expect(page).not.toContain('no reading')
    expect(page).toContain('data-waiting')
  })
})

describe('where they stand', () => {
  // EVERY DEVICE ON ONE CANVAS (owner 2026-11-11, answered "yes" to "one line under each machine's
  // name"): the panel over all machines is gone; each frame carries its own line, read only on the stop.
  it('under each machine’s name, one line each, and no panel over them all', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).not.toContain('<GaugePanel')
    expect(view).toContain('<MachineGaugeLine machineId="local" local />')
    expect(view).toMatch(/<MachineGaugeLine machineId=\{m\.id\}/)
    const leaf = readFileSync('src/renderer/src/zoom/MachineGauges.tsx', 'utf8')
    expect(leaf).toMatch(/export const MachineGaugeLine = memo\(/)
    expect(leaf).toMatch(/online && onStop \? gaugeStore\(\)\.watch/)
  })
  it('the leaf holds every subscription, so the view never hears a sample or a zoom step', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).not.toMatch(/useGauge|gaugeStore|gauge-store/)
    const leaf = readFileSync('src/renderer/src/zoom/MachineGauges.tsx', 'utf8')
    expect(leaf).toMatch(/export const MachineGaugeLine = memo\(/)
    expect(leaf).toMatch(/useSyncExternalStore\(zoomStore\.subscribe/)
  })
  it('its rows are memoised on primitives: a new fleet with the same names does not reach them', () => {
    expect(readFileSync('src/renderer/src/zoom/MachineGauges.tsx', 'utf8')).toMatch(/const MachineLine = memo\(function MachineLine\(\{ machineId, name, local = false, online = true \}/)
  })
  it('takes no gesture from the scene unless it has to scroll: a pinch that starts on it still reaches the overview', () => {
    const css = readFileSync('src/renderer/src/zoom/gauges.css', 'utf8')
    expect(css).toMatch(/\.zv-gauge-panel \{[^}]*pointer-events: none/)
    expect(css).toMatch(/\.zv-gauge-panel\[data-scrolls\] \{[^}]*pointer-events: auto/)
  })
  it('stands clear of a notch, as the zoom’s other top-anchored parts do', () => {
    expect(readFileSync('src/renderer/src/zoom/gauges.css', 'utf8')).toMatch(/top: calc\(12px \+ env\(safe-area-inset-top/)
  })
  it('nothing is painted per frame: the painter does not know them', () => {
    expect(readFileSync('src/renderer/src/zoom/zoom-frame.ts', 'utf8')).not.toMatch(/gauge/i)
  })
})

describe('the list', () => {
  it('this machine first, then the account’s others, each by name', () => {
    const page = list([other(), other({ id: 'm3', name: 'Mac mini' })])
    expect(page.indexOf('This Mac')).toBeLessThan(page.indexOf('Studio'))
    expect(page.indexOf('Studio')).toBeLessThan(page.indexOf('Mac mini'))
  })
  it('renders off the server snapshot with nothing asked', () => {
    expect(list()).toContain('data-waiting')
  })
  it('does not list this machine twice when the fleet names it too', () => {
    expect(list([{ id: 'me', name: 'This Mac', local: true, online: true }]).match(/zv-gauge-name/g)).toHaveLength(1)
  })
  it('a machine off its line says no reading and asks nobody', () => {
    const page = list([other({ online: false })])
    expect(page).toMatch(/Studio.*no reading/)
  })
})
