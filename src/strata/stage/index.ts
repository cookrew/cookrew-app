// The stage (motion lane). Usher renders <Stage> and calls useAnchor on every
// drawn item; see docs/strata-2026-10-21/glide/motion.html §10.
export { Stage } from './Stage'
export { useAnchor } from './anchors'
export { flightLog, stageRest, type FlightRecord } from './telemetry'
export { FAN, LEVEL3, fanTotal } from './motion'
export { pathKey } from './plan'
