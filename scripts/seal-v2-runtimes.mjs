// cookrew-seal/2 vectors in every JS runtime it runs in: Node, Electron's own
// Node (the main process: terminus and openStream), and Chrome (the phone page
// and the console). Swift is watch/Tests (swift test). Exits non-zero on any
// failure, and prints what ran where.
//
// Run: node scripts/seal-v2-runtimes.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { connectCdp, launchChrome } from './perf-cdp.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = path.join(root, 'tests/runtime/seal2-runtime-check.ts')
const vectors = readFileSync(path.join(root, 'tests/fixtures/seal-v2-vectors.json'), 'utf8')
const work = mkdtempSync(path.join(tmpdir(), 'seal2-runtimes-'))
const reports = []

const inProcess = async (label, command, args, env = {}) => {
  const bundle = path.join(work, 'check.mjs')
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
  const runner = path.join(work, 'run.mjs')
  writeFileSync(
    runner,
    `import { runSeal2Checks } from ${JSON.stringify(bundle)}\nconst report = await runSeal2Checks(${vectors}, ${JSON.stringify(label)} + ' ' + JSON.stringify(process.versions.electron ? { electron: process.versions.electron, node: process.versions.node } : { node: process.versions.node }))\nconsole.log(JSON.stringify(report))\n`
  )
  const ran = spawnSync(command, [runner], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  const line = ran.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { runtime: label, passed: [], failed: [`did not run: ${ran.stderr.slice(0, 400)}`], skipped: [] }
  }
}

const inChrome = async () => {
  const bundle = path.join(work, 'check.js')
  await build({ entryPoints: [entry], bundle: true, format: 'iife', globalName: 'SealCheck', platform: 'browser', outfile: bundle, logLevel: 'silent' })
  const script = readFileSync(bundle, 'utf8')
  // Loopback is a secure context, so WebCrypto is there as it is on https.
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>seal2</title>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const profile = mkdtempSync(path.join(tmpdir(), 'seal2-chrome-'))
  const chrome = await launchChrome({ userDataDir: profile })
  try {
    const browser = await connectCdp(chrome.browserWs)
    const { targetId } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` })
    const page = await connectCdp(`ws://127.0.0.1:${chrome.port}/devtools/page/${targetId}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const version = await browser.send('Browser.getVersion')
    const evaluated = await page.send('Runtime.evaluate', {
      expression: `${script}\nSealCheck.runSeal2Checks(${vectors}, ${JSON.stringify(`chrome ${version.product}`)}).then((r) => JSON.stringify(r))`,
      awaitPromise: true,
      returnByValue: true
    }, 60_000)
    if (evaluated.exceptionDetails) return { runtime: 'chrome', passed: [], failed: [`threw: ${JSON.stringify(evaluated.exceptionDetails).slice(0, 400)}`], skipped: [] }
    return JSON.parse(evaluated.result.value)
  } finally {
    const gone = new Promise((resolve) => chrome.child.once('exit', resolve))
    chrome.child.kill('SIGKILL')
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))])
    server.close()
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // A profile Chrome is still letting go of is the temp dir's to clear.
    }
  }
}

try {
  reports.push(await inProcess('node', process.execPath, []))
  reports.push(await inProcess('electron-main', path.join(root, 'node_modules/.bin/electron'), [], { ELECTRON_RUN_AS_NODE: '1' }))
  reports.push(await inChrome())
} finally {
  rmSync(work, { recursive: true, force: true })
}

let failed = 0
for (const report of reports) {
  console.log(`\n${report.runtime}: ${report.passed.length} passed, ${report.failed.length} failed, ${report.skipped.length} skipped`)
  for (const name of report.passed) console.log(`  ok    ${name}`)
  for (const name of report.failed) console.log(`  FAIL  ${name}`)
  for (const name of report.skipped) console.log(`  skip  ${name}`)
  failed += report.failed.length
}
process.exit(failed === 0 ? 0 : 1)
