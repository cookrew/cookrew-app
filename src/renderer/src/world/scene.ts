// The three.js side of the world view: scene, camera, and the islands.
//
// Framework-free on purpose — World.tsx owns React state and the frame loop,
// this file owns everything that touches a GPU, so the two can be reasoned
// about (and torn down) separately.
//
// DEPTH IS THE POINT. An isometric projection is parallel: far is the same
// size as near, by construction, which is exactly why the canvas views have no
// distance in them. Here the camera is a real perspective one and the scene
// carries exponential fog, so a workspace you have not touched in a week is
// literally dim and small — the map says "you have let this go" without a word.

import * as THREE from 'three'
import { PHASE_COLOUR, towerHeight, type WorldPlace } from './fleet'

export const SKY = 0x06070c
/** Lighter than the sky on purpose: fog has to be something, or far is just
 *  black and the depth cue is lost with it. */
const HAZE = 0x121a2e
const GRID_NEAR = 0x2a3550
const GRID_FAR = 0x121829
const ISLAND = 0x171b26
const ISLAND_RIM = 0x39465f

export interface WorldHandles {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  resize: (w: number, h: number) => void
  dispose: () => void
}

export function createWorld(canvas: HTMLCanvasElement): WorldHandles {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  // 1.5 is the kit's own cap and the right one here too: a 3x phone display
  // triples the fragment cost for a scene whose whole look is soft haze.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.setClearColor(SKY, 1)

  const scene = new THREE.Scene()
  // Exponential rather than linear: linear fog has a visible start plane, and
  // the far end of an avenue should dissolve, not hit a wall.
  scene.fog = new THREE.FogExp2(HAZE, 0.00072)

  const camera = new THREE.PerspectiveCamera(52, 1, 1, 6000)
  camera.position.set(0, 120, 320)

  scene.add(new THREE.AmbientLight(0xaab4cc, 1.5))
  const key = new THREE.DirectionalLight(0xffffff, 1.9)
  key.position.set(120, 260, 180)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x6f8fb8, 0.9)
  rim.position.set(-180, 90, -200)
  scene.add(rim)

  // The floor: two grids, the near one brighter. It is what gives the eye a
  // ruler for distance, and it is the reason the scene reads as a place
  // rather than as objects on black.
  const near = new THREE.GridHelper(4000, 80, GRID_NEAR, GRID_NEAR)
  const nearMat = near.material as THREE.Material
  nearMat.transparent = true
  nearMat.opacity = 0.42
  near.position.y = -60
  scene.add(near)
  const far = new THREE.GridHelper(12000, 60, GRID_FAR, GRID_FAR)
  const farMat = far.material as THREE.Material
  farMat.transparent = true
  farMat.opacity = 0.2
  far.position.y = -62
  scene.add(far)

  const resize = (w: number, h: number): void => {
    camera.aspect = w / Math.max(1, h)
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  const dispose = (): void => {
    near.geometry.dispose()
    nearMat.dispose()
    far.geometry.dispose()
    farMat.dispose()
    renderer.dispose()
  }
  return { scene, camera, renderer, resize, dispose }
}

export interface FleetObjects {
  group: THREE.Group
  /** Meshes a ray may hit, with what they stand for. */
  pickables: THREE.Object3D[]
  placeOf: Map<number, string>
  agentOf: Map<number, string>
  /** Beacons pulse; nothing else in the scene moves. */
  tick: (seconds: number) => void
  dispose: () => void
}

/**
 * One island per workspace, one tower per agent.
 *
 * Geometry and materials are shared and the meshes are plain: at a hundred
 * agents this is a few hundred draw calls, which a GPU does not notice — the
 * SVG board could not orbit at all (measured: 56 ms to rebuild 1287 paths),
 * and that difference is the whole reason this view is three.js.
 */
export function buildFleet(places: readonly WorldPlace[]): FleetObjects {
  const group = new THREE.Group()
  const pickables: THREE.Object3D[] = []
  const placeOf = new Map<number, string>()
  const agentOf = new Map<number, string>()
  const beacons: THREE.Mesh[] = []
  const owned: Array<{ dispose: () => void }> = []

  const towerGeo = new THREE.BoxGeometry(7, 1, 7)
  const beaconGeo = new THREE.CylinderGeometry(1.6, 1.6, 150, 8, 1, true)
  owned.push(towerGeo, beaconGeo)

  const islandMat = new THREE.MeshLambertMaterial({ color: ISLAND })
  const rimMat = new THREE.MeshBasicMaterial({ color: ISLAND_RIM, transparent: true, opacity: 0.55 })
  const activeRimMat = new THREE.MeshBasicMaterial({ color: 0xffd600, transparent: true, opacity: 0.85 })
  owned.push(islandMat, rimMat, activeRimMat)

  const towerMats = new Map<number, THREE.MeshLambertMaterial>()
  const matFor = (colour: number): THREE.MeshLambertMaterial => {
    const found = towerMats.get(colour)
    if (found) return found
    const made = new THREE.MeshLambertMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.45 })
    towerMats.set(colour, made)
    owned.push(made)
    return made
  }

  for (const place of places) {
    const island = new THREE.Group()
    island.position.set(place.at.x, place.at.y, place.at.z)

    const slabGeo = new THREE.CylinderGeometry(place.radius, place.radius * 0.86, 9, 40)
    owned.push(slabGeo)
    const slab = new THREE.Mesh(slabGeo, islandMat)
    island.add(slab)
    pickables.push(slab)
    placeOf.set(slab.id, place.id)

    const ringGeo = new THREE.TorusGeometry(place.radius + 1.5, 0.9, 6, 56)
    owned.push(ringGeo)
    const ring = new THREE.Mesh(ringGeo, place.active ? activeRimMat : rimMat)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 4.6
    island.add(ring)

    for (const agent of place.agents) {
      const h = towerHeight(agent.turnCount)
      const tower = new THREE.Mesh(towerGeo, matFor(PHASE_COLOUR[agent.phase]))
      // The shared unit box is scaled rather than rebuilt per agent: one
      // geometry, a hundred towers.
      tower.scale.y = h
      tower.position.set(
        agent.at.x * (place.radius - 10),
        4.5 + h / 2,
        agent.at.z * (place.radius - 10)
      )
      island.add(tower)
      pickables.push(tower)
      agentOf.set(tower.id, agent.id)
      placeOf.set(tower.id, place.id)

      if (agent.phase === 'waiting') {
        // The only thing in this world that moves. A shaft of light stands
        // over the agent that wants a person, and it is visible from the far
        // end of the avenue — which is the whole job of the world view.
        const beacon = new THREE.Mesh(
          beaconGeo,
          new THREE.MeshBasicMaterial({
            color: PHASE_COLOUR.waiting,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            depthWrite: false
          })
        )
        owned.push(beacon.material as THREE.Material)
        beacon.position.set(tower.position.x, 4.5 + 75, tower.position.z)
        island.add(beacon)
        beacons.push(beacon)
      }
    }
    group.add(island)
  }

  const tick = (seconds: number): void => {
    for (let i = 0; i < beacons.length; i++) {
      const mat = beacons[i].material as THREE.MeshBasicMaterial
      mat.opacity = 0.18 + 0.2 * (0.5 + 0.5 * Math.sin(seconds * 2.2 + i))
    }
  }
  const dispose = (): void => {
    for (const item of owned) item.dispose()
    group.clear()
  }
  return { group, pickables, placeOf, agentOf, tick, dispose }
}

/** Screen position of a world point, or null when it is behind the camera. */
export function project(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number
): { x: number; y: number; depth: number } | null {
  const v = point.clone().project(camera)
  if (v.z > 1) return null
  return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, depth: v.z }
}
