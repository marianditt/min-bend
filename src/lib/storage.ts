import {
  DEFAULT_CONSTANTS,
  DEFAULT_RESOLUTION,
  type Constraint,
  type Curve,
  type FixPoint,
  type PhysicsConstants,
  type Setup,
  type Vec2,
} from '../solver/types'
import { nextPointId } from '../solver/constraints'

export const STORAGE_KEY = 'min-bend:state'
export const STORAGE_VERSION = 3

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
  // v2 -> v3: control points got stable ids; constraints refer to ids, not indices.
  2: (state) => {
    const setup = isRecord(state.setup) ? state.setup : {}
    const curves = Array.isArray(setup.curves) ? setup.curves : []
    const idAt = new Map<string, string>()
    let n = 0
    const upgraded = curves.map((curve, ci) => {
      if (!isRecord(curve) || !Array.isArray(curve.fixPoints)) return curve
      return {
        ...curve,
        fixPoints: curve.fixPoints.map((fp, pi) => {
          const id = `p${++n}`
          idAt.set(`${ci}:${pi}`, id)
          return isRecord(fp) ? { ...fp, id } : fp
        }),
      }
    })
    const constraints = Array.isArray(setup.constraints)
      ? setup.constraints.flatMap((c) => {
          if (!isRecord(c) || !isRecord(c.source) || !isRecord(c.target)) return []
          const source = idAt.get(`${c.source.curve}:${c.source.point}`)
          const target = idAt.get(`${c.target.curve}:${c.target.point}`)
          return source && target ? [{ ...c, source, target }] : []
        })
      : []
    return { ...state, setup: { ...setup, curves: upgraded, constraints } }
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
    id: typeof value.id === 'string' ? value.id : '',
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
  if (isFiniteNumber(value.flatness) && value.flatness >= 0 && value.flatness <= 1) curve.flatness = value.flatness
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
  const setup: Setup = { curves, resolution }
  const seen = new Set<string>()
  for (const curve of curves) {
    for (const fp of curve.fixPoints) {
      if (fp.id && !seen.has(fp.id)) seen.add(fp.id)
      else fp.id = ''
    }
  }
  for (const curve of curves) {
    for (const fp of curve.fixPoints) if (!fp.id) fp.id = nextPointId(setup)
  }
  const constraints = sanitizeConstraints(value.constraints)
  if (constraints.length > 0) setup.constraints = constraints
  return setup
}

function sanitizeConstraints(value: unknown): Constraint[] {
  if (!Array.isArray(value)) return []
  const out: Constraint[] = []
  for (const raw of value) {
    if (!isRecord(raw) || (raw.kind !== 'position' && raw.kind !== 'orientation')) continue
    if (typeof raw.source !== 'string' || typeof raw.target !== 'string') continue
    const { source, target } = raw
    if (raw.kind === 'position') {
      out.push(isVec2(raw.delta) ? { kind: 'position', source, target, delta: [raw.delta[0], raw.delta[1]] } : { kind: 'position', source, target })
    } else {
      out.push(isFiniteNumber(raw.delta) ? { kind: 'orientation', source, target, delta: raw.delta } : { kind: 'orientation', source, target })
    }
  }
  return out
}

function sanitizeConstants(value: unknown): PhysicsConstants | null {
  if (!isRecord(value)) return null
  // Unknown legacy keys (e.g. kLen) are dropped; missing or invalid ones fall back to defaults.
  const pick = (key: keyof PhysicsConstants): number => {
    const v = value[key]
    return isFiniteNumber(v) ? v : DEFAULT_CONSTANTS[key]
  }
  return {
    kBend: pick('kBend'),
    gamma: pick('gamma'),
    h: pick('h'),
    epsilon: pick('epsilon'),
    settleFrames: pick('settleFrames'),
    maxIter: pick('maxIter'),
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

/** Forget the saved setup (used by "Start over"). Never throws. */
export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // storage unavailable; nothing to clear
  }
}
