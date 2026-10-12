import { useCallback, useEffect, useReducer } from 'react'
import { DEFAULT_CONSTANTS } from '../solver/types'
import type { PhysicsConstants, Setup } from '../solver/types'
import { DEFAULT_SETUP } from '../ui/defaults'
import { loadState, saveState } from '../lib/storage'

const HISTORY_LIMIT = 200

interface SetupState {
  setup: Setup
  constants: PhysicsConstants
  past: Setup[]
  future: Setup[]
}

export interface EditOptions {
  /** When false the edit replaces the setup without touching the undo stack. */
  history?: boolean
}

type SetupAction =
  | { type: 'update'; mutator: (setup: Setup) => Setup; history: boolean }
  | { type: 'constants'; constants: PhysicsConstants }
  | { type: 'reset' }
  | { type: 'undo' }
  | { type: 'redo' }

function reducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'update': {
      const next = action.mutator(state.setup)
      if (next === state.setup) return state
      if (!action.history) return { ...state, setup: next }
      const past = [...state.past, state.setup]
      if (past.length > HISTORY_LIMIT) past.shift()
      return { setup: next, constants: state.constants, past, future: [] }
    }
    case 'constants':
      return { ...state, constants: action.constants }
    case 'reset':
      return defaultSetupState()
    case 'undo': {
      const previous = state.past.at(-1)
      if (previous === undefined) return state
      return {
        setup: previous,
        constants: state.constants,
        past: state.past.slice(0, -1),
        future: [state.setup, ...state.future],
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined) return state
      return {
        setup: next,
        constants: state.constants,
        past: [...state.past, state.setup],
        future: state.future.slice(1),
      }
    }
    default:
      return state
  }
}

function defaultSetupState(): SetupState {
  return {
    setup: structuredClone(DEFAULT_SETUP),
    constants: DEFAULT_CONSTANTS,
    past: [],
    future: [],
  }
}

function makeInitialState(): SetupState {
  const persisted = loadState()
  if (!persisted) return defaultSetupState()
  return {
    setup: persisted.setup,
    constants: persisted.constants,
    past: [],
    future: [],
  }
}

/**
 * Owns the authored {@link Setup} and the physics constants. Structural edits
 * (`update`) push an undo entry by default; pass `{ history: false }` for
 * transient edits that should not be individually undoable.
 */
export function useSetupState() {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState)

  const update = useCallback(
    (mutator: (setup: Setup) => Setup, options?: EditOptions) => {
      dispatch({ type: 'update', mutator, history: options?.history ?? true })
    },
    [],
  )

  const setConstants = useCallback((next: PhysicsConstants) => {
    dispatch({ type: 'constants', constants: next })
  }, [])

  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])
  const reset = useCallback(() => dispatch({ type: 'reset' }), [])

  useEffect(() => {
    saveState({ setup: state.setup, constants: state.constants })
  }, [state.setup, state.constants])

  return {
    setup: state.setup,
    constants: state.constants,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    update,
    setConstants,
    reset,
    undo,
    redo,
  }
}

export default useSetupState
