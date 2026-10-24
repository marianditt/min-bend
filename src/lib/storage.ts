import {
  DEFAULT_RESOLUTION,
  type Curve,
  type FixPoint,
  type PhysicsConstants,
  type Setup,
  type Vec2,
} from '../solver/types'

export const STORAGE_KEY = 'min-bend:state'
export const STORAGE_VERSION = 2

export interface PersistedState {
  setup: Setup
  constants: PhysicsConstants
}

/** Upgrades a stored payload from `version` to `version + 1`. */
export type Migration = (state: Record<string, unknown>) => Record<string, unknown>

/**
 * Ordered migrations keyed by the version they upgrade FROM. When the stored
 * shape changes, add the upgrade here instead of dropping the user's saved work.
 */
const MIGRATIONS: Record<number, Migration> = {
  // v1 -> v2: per-curve interior point counts became one global resolution.
  1: (state) => {
    const setup = isRecord(state.setup) ? state.setup : {}
    return { ...state, setup: { ...setup, resolution: DEFAULT_RESOLUTION } }
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVec2(value: unknown): value is Vec2 {
  return (
    Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
  )
}

function sanitizeFixPoint(value: unknown): FixPoint | null {
  if (!isRecord(value) || !isVec2(value.pos)) return null
  const orientation = value.orientation
  if (orientation !== null && orientation !== undefined && !isVec2(orientation)) return null
  const fp: FixPoint = {
    pos: [value.pos[0], value.pos[1]],
    orientation: orientation ? [orientation[0], orientation[1]] : null,
  }
  if (value.posFree === true) fp.posFree = true
  return fp
}

function sanitizeCurve(value: unknown): Curve | null {
  if (!isRecord(value) || !Array.isArray(value.fixPoints) || !Array.isArray(value.spans)) return null

  const fixPoints: FixPoint[] = []
  for (const raw of value.fixPoints) {
    const fp = sanitizeFixPoint(raw)
    if (!fp) return null
    fixPoints.push(fp)
  }

  const spans: Vec2[][] = []
  for (const rawSpan of value.spans) {
    if (!Array.isArray(rawSpan)) return null
    const span: Vec2[] = []
    for (const rawPoint of rawSpan) {
      if (!isVec2(rawPoint)) return null
      span.push([rawPoint[0], rawPoint[1]])
    }
    spans.push(span)
  }

  const curve: Curve = { fixPoints, spans }
  if (value.targetLength === null) curve.targetLength = null
  else if (isFiniteNumber(value.targetLength)) curve.targetLength = value.targetLength
  if (value.hidden === true) curve.hidden = true
  return curve
}

function sanitizeSetup(value: unknown): Setup | null {
  if (!isRecord(value) || !Array.isArray(value.curves) || value.curves.length === 0) return null
  const curves: Curve[] = []
  for (const raw of value.curves) {
    const curve = sanitizeCurve(raw)
    if (!curve || curve.fixPoints.length < 2) return null
    curves.push(curve)
  }
  const resolution = isFiniteNumber(value.resolution) && value.resolution > 0 ? value.resolution : DEFAULT_RESOLUTION
  return { curves, resolution }
}

function sanitizeConstants(value: unknown): PhysicsConstants | null {
  if (!isRecord(value)) return null
  const c = value
  if (
    !isFiniteNumber(c.kLen) ||
    !isFiniteNumber(c.kBend) ||
    !isFiniteNumber(c.gamma) ||
    !isFiniteNumber(c.h) ||
    !isFiniteNumber(c.epsilon) ||
    !isFiniteNumber(c.settleFrames) ||
    !isFiniteNumber(c.maxIter)
  ) {
    return null
  }
  return {
    kLen: c.kLen,
    kBend: c.kBend,
    gamma: c.gamma,
    h: c.h,
    epsilon: c.epsilon,
    settleFrames: c.settleFrames,
    maxIter: c.maxIter,
  }
}

/**
 * Walk a stored envelope up to `targetVersion` by applying each migration in
 * turn. Returns null when the payload is not an object, is newer than the app
 * understands, or is missing a required migration step.
 */
export function migrateEnvelope(
  raw: unknown,
  migrations: Record<number, Migration>,
  targetVersion: number,
): Record<string, unknown> | null {
  if (!isRecord(raw)) return null
  let version = isFiniteNumber(raw.version) ? Math.floor(raw.version) : 0
  if (version > targetVersion) return null
  let state = raw
  while (version < targetVersion) {
    const upgrade = migrations[version]
    if (!upgrade) return null
    state = upgrade(state)
    version += 1
  }
  return state
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Load and migrate persisted inputs, or null when nothing usable is stored. */
export function loadState(): PersistedState | null {
  if (typeof localStorage === 'undefined') return null
  const raw = readStorage()
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const envelope = migrateEnvelope(parsed, MIGRATIONS, STORAGE_VERSION)
  if (!envelope) return null

  const setup = sanitizeSetup(envelope.setup)
  const constants = sanitizeConstants(envelope.constants)
  if (!setup || !constants) return null
  return { setup, constants }
}

/** Persist inputs on a best-effort basis (storage may be full or unavailable). */
export function saveState(state: PersistedState): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, setup: state.setup, constants: state.constants }),
    )
  } catch {
    /* best-effort persistence */
  }
}
