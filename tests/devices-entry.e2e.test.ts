import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP, launchBrowser, type Browser, type Tab } from './support/chrome-driver'
import { startDevicesEntryFixture } from './support/devices-entry-fixture'

const suite = process.env.COOKREW_DEVICES_ENTRY_E2E === '1' ? describe : describe.skip

const profileOpen = "!!document.querySelector('[aria-label=\"Profile @fixture\"]')"
const launchOpen = "!!document.querySelector('[aria-label=\"Launch settings\"]')"

suite('adding a computer from Launch settings', () => {
  let host: Awaited<ReturnType<typeof startDevicesEntryFixture>>
  let browser: Browser
  let tab: Tab
  beforeAll(async () => {
    host = await startDevicesEntryFixture()
    browser = await launchBrowser()
    tab = await browser.open(DESKTOP)
  }, 20_000)
  afterAll(async () => {
    try { await browser?.close() } finally { await host?.close() }
  })

  async function openDevicesFromLaunch(): Promise<void> {
    await tab.goto(host.url)
    await tab.click('button', 'Open launch settings')
    await tab.click('[aria-label="Launch settings"] button', 'Add a computer')
    await tab.until("document.querySelector('[aria-label=Devices]')", 'the account Devices tab is open')
  }

  it('opens Devices above the sheet and requires step-up before minting', async () => {
    await openDevicesFromLaunch()
    expect(await tab.evaluate<string>("document.querySelector('[role=tab][aria-selected=true]').textContent.trim()")).toBe('DEVICES')
    // The account layer stands above Launch settings by its own z-index, not by DOM order.
    const z = await tab.evaluate<number[]>(`[
      getComputedStyle(document.querySelector('[aria-label="Profile @fixture"]')).zIndex,
      getComputedStyle(document.querySelector('[aria-label="Launch settings"]')).zIndex
    ].map(Number)`)
    expect(z[0]).toBeGreaterThan(z[1])
    await tab.click('[aria-label=Devices] button', /ADD A (MAC|COMPUTER)/)
    expect(await tab.evaluate<boolean>("!!document.querySelector('input[type=password]')")).toBe(true)
    expect(await tab.evaluate<boolean>("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='MAKE A CODE').disabled")).toBe(true)
    expect(await tab.evaluate<unknown[]>('window.fixtureCalls')).toEqual([])
  }, 30_000)

  it('takes focus, and Escape closes only the account sheet', async () => {
    await openDevicesFromLaunch()
    await tab.until("document.activeElement.closest('[aria-label=\"Profile @fixture\"]')", 'focus moves into the account sheet')
    await tab.key('Escape')
    await tab.until(`!(${profileOpen})`, 'the account sheet closes')
    expect(await tab.evaluate<boolean>(launchOpen)).toBe(true)
  }, 30_000)
})
