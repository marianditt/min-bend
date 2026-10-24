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
        { pos: [0, 0], orientation: null },
        { pos: [4, 0], orientation: [1, 0], posFree: true },
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
