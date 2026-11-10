import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE MACHINES LEVEL LOADS WITHOUT THE APP. The console's entry draws the way
 * in and the account's machines; one machine is the whole app (the canvas,
 * the terminal, the transcript) and is a chunk asked for later. That only
 * holds while nothing the entry imports STATICALLY reaches the app, so the
 * entry's static import graph is walked here and held to that.
 */

const SRC = path.join(__dirname, '..', 'src')
const ENTRY = path.join(SRC, 'renderer', 'src', 'console-main.tsx')

const resolveLocal = (from: string, spec: string): string | null => {
  const base = path.resolve(path.dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Static imports only: `import x from`, `import 'x'`, `export … from`. A dynamic `import(` is a chunk boundary. */
function staticImports(file: string): { local: string[]; packages: string[] } {
  const text = readFileSync(file, 'utf8')
  const local: string[] = []
  const packages: string[] = []
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
  for (const match of text.matchAll(pattern)) {
    const spec = match[1]
    if (!spec.startsWith('.')) packages.push(spec)
    else if (!/\.css$/.test(spec)) {
      const found = resolveLocal(file, spec)
      if (found) local.push(found)
    }
  }
  return { local, packages }
}

function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const walk = (file: string): void => {
    if (files.has(file)) return
    files.add(file)
    const found = staticImports(file)
    found.packages.forEach((name) => packages.add(name))
    found.local.forEach(walk)
  }
  walk(entry)
  return { files, packages }
}

describe('what the console loads before anyone opens a machine', () => {
  const { files, packages } = closure(ENTRY)
  const names = [...files].map((file) => path.relative(SRC, file).split(path.sep).join('/'))

  it('is the console’s own levels and the plumbing they need', () => {
    expect(names).toContain('renderer/src/console/console-wiring.ts')
    expect(names).toContain('renderer/src/console/ConsoleShell.tsx')
    expect(names).toContain('renderer/src/console/ConsoleDevicesView.tsx')
  })

  it('is not the app: no canvas, no api object, no terminal, no transcript', () => {
    for (const heavy of [
      'renderer/src/App.tsx',
      'renderer/src/api.ts',
      'renderer/src/remote-api.ts',
      'renderer/src/demo-api.ts',
      'renderer/src/TerminalOverlay.tsx',
      'renderer/src/TranscriptView.tsx',
      'renderer/src/zoom/ZoomView.tsx',
      'renderer/src/zoom/use-zoom-fleet.ts',
      'renderer/src/zoom/zoom-store.ts',
      'renderer/src/console/ConsoleMachine.tsx'
    ]) {
      expect(names, heavy).not.toContain(heavy)
    }
    expect(names.length).toBeLessThan(60)
  })

  it('pulls in React and nothing else from outside', () => {
    expect([...packages].sort()).toEqual(['react', 'react-dom/client'])
  })

  it('the wiring comes first, so the page is the console before anything else asks', () => {
    const text = readFileSync(ENTRY, 'utf8')
    const first = /^import [^\n]+$/m.exec(text)?.[0] ?? ''
    expect(first).toContain("'./console/console-wiring'")
  })

  it('the page carries no inline script: its mode and its hosts are plain meta tags', () => {
    const page = readFileSync(path.join(SRC, 'renderer', 'console.html'), 'utf8')
    expect(page).toContain('<meta name="cookrew-mode" content="console" />')
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(1)
    expect(scripts[0][1]).toContain('src="/src/console-main.tsx"')
    expect(scripts[0][2].trim()).toBe('')
    expect(page).not.toMatch(/\son[a-z]+=/i)
    expect(page).not.toContain('style=')
  })
})
