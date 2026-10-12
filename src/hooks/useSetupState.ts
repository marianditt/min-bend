import { useCallback, useReducer } from 'react'
import { DEFAULT_CONSTANTS } from '../solver/types'
import type { PhysicsConstants, ProblemInput, Vec2 } from '../solver/types'
import { DEFAULT_INPUT } from '../ui/defaults'

interface SetupState {
  input: ProblemInput
  constants: PhysicsConstants
  past: Vec2[][]
  future: Vec2[][]
}

type SetupAction =
  | { type: 'input'; input: ProblemInput }
  | { type: 'constants'; constants: PhysicsConstants }
  | { type: 'draw'; next: Vec2[] }
  | { type: 'removeLast' }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'redo' }

function clampDrawn(input: ProblemInput): ProblemInput {
  const drawn = input.drawnPts
  if (!drawn || drawn.length <= input.n) return input
  return { ...input, drawnPts: drawn.slice(0, Math.max(0, input.n)) }
}

function withDrawn(input: ProblemInput, next: Vec2[]): ProblemInput {
  return clampDrawn({ ...input, drawnPts: next })
}

function pushDraw(state: SetupState, next: Vec2[]): SetupState {
  const current = state.input.drawnPts ?? []
  return {
    ...state,
    input: withDrawn(state.input, next),
    past: [...state.past, current],
    future: [],
  }
}

function reducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'input':
      return { ...state, input: clampDrawn(action.input) }
    case 'constants':
      return { ...state, constants: action.constants }
    case 'draw':
      return pushDraw(state, action.next)
    case 'removeLast': {
      const drawn = state.input.drawnPts
      return drawn && drawn.length > 0
        ? pushDraw(state, drawn.slice(0, -1))
        : state
    }
    case 'clear':
      return state.input.drawnPts?.length ? pushDraw(state, []) : state
    case 'undo': {
      const previous = state.past.at(-1)
      if (previous === undefined) return state
      const current = state.input.drawnPts ?? []
      return {
        ...state,
        input: withDrawn(state.input, previous),
        past: state.past.slice(0, -1),
        future: [current, ...state.future],
      }
    }
    case 'redo': {
      const next = state.future[0]
      if (next === undefined) return state
      const current = state.input.drawnPts ?? []
      return {
        ...state,
        input: withDrawn(state.input, next),
        past: [...state.past, current],
        future: state.future.slice(1),
      }
    }
    default:
      return state
  }
}

function makeInitialState(): SetupState {
  return {
    input: DEFAULT_INPUT,
    constants: DEFAULT_CONSTANTS,
    past: [],
    future: [],
  }
}

export function useSetupState() {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState)

  const setInput = useCallback((next: ProblemInput) => {
    dispatch({ type: 'input', input: next })
  }, [])

  const setConstants = useCallback((next: PhysicsConstants) => {
    dispatch({ type: 'constants', constants: next })
  }, [])

  const drawnPts = state.input.drawnPts
  const n = state.input.n

  const addDrawn = useCallback(
    (p: Vec2) => {
      const current = drawnPts ?? []
      if (current.length >= n) return
      dispatch({ type: 'draw', next: [...current, p] })
    },
    [drawnPts, n],
  )

  const removeLastDrawn = useCallback(() => {
    dispatch({ type: 'removeLast' })
  }, [])

  const clearDrawn = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  const undo = useCallback(() => {
    dispatch({ type: 'undo' })
  }, [])

  const redo = useCallback(() => {
    dispatch({ type: 'redo' })
  }, [])

  return {
    input: state.input,
    constants: state.constants,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    setInput,
    setConstants,
    addDrawn,
    removeLastDrawn,
    clearDrawn,
    undo,
    redo,
  }
}

export default useSetupState
