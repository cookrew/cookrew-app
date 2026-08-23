/**
 * Static import edges of a TypeScript source, and where they resolve to.
 *
 * WHY THIS EXISTS RATHER THAN A REGEX OVER NAMES. The sweep this feeds used to
 * look for the grant operations BY NAME in the listener sources. Magpie proved
 * that blind with a one-line mutant: rename `enrol` to `admitCaller`, call it
 * from mobile-api.ts, and the sweep passes while enrolment is genuinely on the
 * wire. It cannot be repaired with a better pattern, because the thing being
 * renamed IS the thing being searched for — the name list and the code drift
 * apart silently and the sweep reports the drift as safety.
 *
 * An import edge does not have that property. Whatever the operation is called,
 * a listener that can reach it must import the module that holds it, and the
 * module's PATH is not something a rename of the operation changes.
 *
 * Everything here is deliberately behind a port so the sweep can be run against
 * a synthetic tree. A conformance test that cannot be shown to fail is
 * decoration; the mutants that prove this one fires live in the test file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** The filesystem the walk reads through — real on the tree, virtual in tests. */
export interface SourcePort {
  read(file: string): string | null
  exists(file: string): boolean
  isDirectory(file: string): boolean
  readDir(dir: string): string[]
}

/** One `import`/`export ... from`/`require`/`import()` in a source file. */
export interface ImportEdge {
  /** The module specifier as written, or null for an unresolvable dynamic one. */
  specifier: string | null
  /** 1-indexed line, for a message that points at the edge. */
  line: number
  /**
   * `import type` — or a named clause whose every binding is `type`-prefixed.
   *
   * A type-only import is erased before the code runs, so it carries no reach.
   * Excluding it is what keeps the sweep from firing on `import type
   * { AgentExport }`, which the gate legitimately needs to read a grant.
   */
  typeOnly: boolean
  /** `import * as ns` — the whole module surface, every binding it has. */
  namespace: boolean
  /** Imported names (pre-`as`), 'default' for a default import. Type-only ones dropped. */
  bindings: readonly string[]
  /**
   * A dynamic `import(expr)` / `require(expr)` whose argument is not a literal.
   *
   * The honest residual, stated where it is produced: this is not statically
   * resolvable, so the walk cannot say where it goes. The sweep reports it as a
   * BLOCK rather than walking past it — an edge nobody can follow is the one
   * place a grant could hide from a static proof, and treating it as absent
   * would be the same mistake as the name list.
   */
  computed: boolean
}

/** Comments may DISCUSS an import; only code may make one. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/**
 * A well-formed import clause holds only identifiers, braces, commas, `*`,
 * `as` and `type`. Anything else means the lazy match ran off the end of an
 * `export function` into some later `from '...'`, and the edge is spurious.
 */
const CLAUSE_SHAPE = /^[\sA-Za-z0-9_$,{}*]*$/

function parseClause(clause: string): Pick<ImportEdge, 'typeOnly' | 'namespace' | 'bindings'> {
  const trimmed = clause.trim()
  if (/^type\b/.test(trimmed)) return { typeOnly: true, namespace: false, bindings: [] }
  if (/^\*\s+as\s+/.test(trimmed) || /,\s*\*\s+as\s+/.test(trimmed)) {
    return { typeOnly: false, namespace: true, bindings: [] }
  }
  const named = trimmed.match(/\{([\s\S]*)\}/)
  const bindings: string[] = []
  let valueSpecifiers = 0
  if (named) {
    for (const raw of named[1].split(',')) {
      const spec = raw.trim()
      if (spec.length === 0) continue
      if (/^type\s+/.test(spec)) continue
      valueSpecifiers += 1
      bindings.push(spec.split(/\s+as\s+/)[0].trim())
    }
  }
  const defaultBinding = trimmed.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim()
  if (defaultBinding.length > 0) {
    valueSpecifiers += 1
    bindings.push('default')
  }
  // A named clause that survived with nothing in it was all `type` specifiers.
  const typeOnly = named !== null && valueSpecifiers === 0
  return { typeOnly, namespace: false, bindings }
}

/**
 * Every module edge out of one source.
 *
 * Re-exports (`export { x } from './m'`) count: a re-export is reach, and
 * routing the grant through a barrel would otherwise launder it.
 */
export function parseImportEdges(rawSource: string): ImportEdge[] {
  const source = stripComments(rawSource)
  const edges: ImportEdge[] = []

  // Stepped by hand rather than with matchAll, and the reason is a bug this
  // very sweep shipped with. `export` also begins `export function foo(` — a
  // lazy scan from there runs to the NEXT `from '...'` anywhere below, and
  // matchAll then resumes AFTER that whole span, swallowing the real import
  // inside it. On a synthetic fixture whose imports come first this never
  // shows; on any real file it made the walk blind to every import that
  // followed the first exported function. So a rejected clause rewinds to just
  // past its keyword instead of consuming everything it spanned.
  const fromClause = /\b(import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = fromClause.exec(source)) !== null) {
    if (!CLAUSE_SHAPE.test(m[2])) {
      fromClause.lastIndex = m.index + m[1].length
      continue
    }
    edges.push({
      specifier: m[3],
      line: lineOf(source, m.index),
      computed: false,
      ...parseClause(m[2])
    })
  }

  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g
  for (const m of source.matchAll(sideEffect)) {
    edges.push({
      specifier: m[1],
      line: lineOf(source, m.index ?? 0),
      typeOnly: false,
      namespace: true,
      bindings: [],
      computed: false
    })
  }

  const deferred = /\b(?:import|require)\s*\(\s*(?:(['"])([^'"]+)\1)?/g
  for (const m of source.matchAll(deferred)) {
    const literal = m[2]
    edges.push({
      specifier: literal ?? null,
      line: lineOf(source, m.index ?? 0),
      typeOnly: false,
      namespace: true,
      bindings: [],
      computed: literal === undefined
    })
  }

  return edges
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx']

/**
 * Where a specifier lands, or null when it leaves the tree.
 *
 * Bare specifiers ('electron', 'node:fs') resolve to null on purpose: the walk
 * does not descend into dependencies, and the electron surface is checked at
 * the import site instead — see the sweep.
 */
export function resolveSpecifier(fromFile: string, specifier: string, port: SourcePort): string | null {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ''))
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`
    if (port.exists(candidate) && !port.isDirectory(candidate)) return candidate
  }
  return null
}

/** Expand a root that may be a file or a directory into source files. */
export function sourceFiles(target: string, port: SourcePort): string[] {
  if (!port.exists(target)) return []
  if (!port.isDirectory(target)) return /\.tsx?$/.test(target) ? [target] : []
  return port
    .readDir(target)
    .flatMap((entry) => sourceFiles(path.join(target, entry), port))
}

/** The real tree. */
export function nodeSourcePort(): SourcePort {
  return {
    read: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    exists: (file) => existsSync(file),
    isDirectory: (file) => {
      try {
        return statSync(file).isDirectory()
      } catch {
        return false
      }
    },
    readDir: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    }
  }
}

/** A synthetic tree, for proving the sweep fires. Keys are absolute paths. */
export function virtualSourcePort(files: Readonly<Record<string, string>>): SourcePort {
  const paths = Object.keys(files)
  const dirs = new Set<string>()
  for (const file of paths) {
    for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      dirs.add(dir)
    }
  }
  return {
    read: (file) => files[file] ?? null,
    exists: (file) => file in files || dirs.has(file),
    isDirectory: (file) => dirs.has(file) && !(file in files),
    readDir: (dir) =>
      [...new Set(
        paths
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => f.slice(dir.length + 1).split('/')[0])
      )]
  }
}
