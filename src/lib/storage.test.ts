import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STORAGE_KEY,
  STORAGE_VERSION,
  type Migration,
  loadState,
  migrateEnvelope,
  saveState,
} from './storage'
import { DEFAULT_CONSTANTS, type Setup } from '../solver/types'

function makeStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

const validSetup: Setup = {
  curves: [
    {
      fixPoints: [
        { id: 'p1', pos: [0, 0], orientation: null },
        { id: 'p2', pos: [4, 0], orientation: [1, 0], posFree: true },
      ],
      spans: [[[1, 0.5]]],
      targetLength: 5,
      hidden: true,
    },
  ],
  resolution: 0.5,
}

describe('migrateEnvelope', () => {
  it('returns null for non-object payloads', () => {
    expect(migrateEnvelope(null, {}, 1)).toBeNull()
    expect(migrateEnvelope('nope', {}, 1)).toBeNull()
    expect(migrateEnvelope([1, 2], {}, 1)).toBeNull()
  })

  it('rejects payloads newer than the target version', () => {
    expect(migrateEnvelope({ version: 9 }, {}, 1)).toBeNull()
  })

  it('returns null when a required migration step is missing', () => {
    expect(migrateEnvelope({ version: 0 }, {}, 1)).toBeNull()
  })

  it('applies migrations in ascending order', () => {
    const migrations: Record<number, Migration> = {
      0: (s) => ({ ...s, a: true }),
      1: (s) => ({ ...s, b: true }),
    }
    expect(migrateEnvelope({ version: 0 }, migrations, 2)).toEqual({
      version: 0,
      a: true,
      b: true,
    })
  })

  it('passes a current-version payload through untouched', () => {
    const payload = { version: 1, setup: validSetup }
    expect(migrateEnvelope(payload, {}, 1)).toEqual(payload)
  })
})

describe('storage round-trip', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null when nothing is saved', () => {
    expect(loadState()).toBeNull()
  })

  it('round-trips a setup and constants', () => {
    saveState({ setup: validSetup, constants: DEFAULT_CONSTANTS })
    expect(loadState()).toEqual({ setup: validSetup, constants: DEFAULT_CONSTANTS })
  })

  it('returns null on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json')
    expect(loadState()).toBeNull()
  })

  it('returns null for a version the app does not understand', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION + 1, setup: validSetup, constants: DEFAULT_CONSTANTS }),
    )
    expect(loadState()).toBeNull()
  })

  it('returns null when the stored setup is structurally invalid', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, setup: { curves: [] }, constants: DEFAULT_CONSTANTS }),
    )
    expect(loadState()).toBeNull()
  })

  it('drops the hidden flag when it is not exactly true', () => {
    const setup = { ...validSetup, curves: [{ ...validSetup.curves[0], hidden: 'yes' }] }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, setup, constants: DEFAULT_CONSTANTS }),
    )
    const loaded = loadState()
    expect(loaded?.setup.curves[0]?.hidden).toBeUndefined()
  })

  it('migrates a v1 payload: adds the default resolution and drops legacy fields', () => {
    const { resolution: _r, ...rest } = validSetup
    const legacyConstants = { ...DEFAULT_CONSTANTS, maxForce: 1000 }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        setup: { ...rest, curves: [{ ...rest.curves[0], n: 6 }] },
        constants: legacyConstants,
      }),
    )
    const loaded = loadState()
    expect(loaded?.setup.resolution).toBe(1)
    expect(loaded?.setup.curves[0]).not.toHaveProperty('n')
    expect(loaded?.constants).toEqual(DEFAULT_CONSTANTS)
  })
})

describe('legacy constants', () => {
  it('ignores a removed kLen field and fills missing constants', () => {
    const storage = makeStorage()
    vi.stubGlobal('localStorage', storage)
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        setup: { curves: [{ fixPoints: [{ pos: [0, 0], orientation: null }, { pos: [1, 0], orientation: null }], spans: [[]] }], resolution: 1 },
        constants: { kLen: 5, kBend: 2 },
      }),
    )
    const loaded = loadState()
    expect(loaded?.constants.kBend).toBe(2)
    expect(loaded?.constants).not.toHaveProperty('kLen')
    expect(loaded?.constants.gamma).toBeGreaterThan(0)
  })
})

describe('v2 -> v3 migration', () => {
  it('gives points ids and rewrites index based constraints to ids', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    const pt = (x: number) => ({ pos: [x, 0], orientation: null })
    store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        constants: DEFAULT_CONSTANTS,
        setup: {
          resolution: 1,
          curves: [
            { fixPoints: [pt(0), pt(1)], spans: [[]] },
            { fixPoints: [pt(2), pt(3)], spans: [[]] },
          ],
          constraints: [{ kind: 'position', source: { curve: 0, point: 1 }, target: { curve: 1, point: 0 } }],
        },
      }),
    )
    const loaded = loadState()!
    const ids = loaded.setup.curves.flatMap((c) => c.fixPoints.map((p) => p.id))
    expect(new Set(ids).size).toBe(4)
    expect(loaded.setup.constraints).toEqual([{ kind: 'position', source: ids[1], target: ids[2] }])
    vi.unstubAllGlobals()
  })
})
