// Marks a harness brings as a file (renderer prompt/harness-logos/): Vite hands
// back the URL it serves, and the only use is an <img src>. Declared under
// shared/ because the renderer project AND the node one (tests import the
// components) both typecheck files that import these.
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
