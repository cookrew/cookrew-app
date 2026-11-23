import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { parseAst } from 'rollup/parseAst'

// npm can successfully finish with an optional platform package missing.
// Exercise the native parts that Vite needs before trusting the install.
parseAst(transformSync('export const value: number = 1', { loader: 'ts' }).code)
const require = createRequire(import.meta.url)
if (!statSync(require('electron')).isFile()) {
  throw new Error('The Electron executable is missing from the dependency tree')
}
