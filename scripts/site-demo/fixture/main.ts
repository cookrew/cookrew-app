import { cookrew } from '@repo/src/renderer/src/api'
import { seed } from './seed'
// The seed builds the cast before the App reads anything.
await seed(cookrew() as never, { page: `http://notes.example/release-notes.html` })
await import('@repo/src/renderer/src/main.tsx')
