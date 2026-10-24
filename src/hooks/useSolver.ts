import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkerRequest, WorkerResponse } from '../solver/protocol'
import type { FrameSet, PhysicsConstants, Setup } from '../solver/types'

export type SolverStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

export interface SolverState {
  status: SolverStatus
  /** Monotonic completion fraction in [0, 1]. */
  progress: number
  /** Latest reported iteration index. */
  iteration: number
  /** Latest reported kinetic energy. */
  ke: number
  /** Result frames, present only once status is 'done'. */
  result: FrameSet | null
  /** Human-readable error, present only when status is 'error'. */
  error: string | null
}

export interface SolverController {
  compute: (input: Setup, constants: PhysicsConstants) => void
  cancel: () => void
  state: SolverState
}

const INITIAL_STATE: SolverState = {
  status: 'idle',
  progress: 0,
  iteration: 0,
  ke: 0,
  result: null,
  error: null,
}

/** Grace period for a cooperative worker to observe a cancel message. */
const CANCEL_GRACE_MS = 250

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/** Accept either a [0,1] fraction or a [0,100] percentage. */
function normalizeProgress(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  const fraction = raw > 1 ? raw / 100 : raw
  return Math.min(1, Math.max(0, fraction))
}

/**
 * Owns a module Web Worker running the solver. A fresh worker is created for
 * every {@link SolverController.compute} call so state can never leak between
 * runs, and is torn down on completion, cancel, error, or unmount.
 *
 * A generation counter invalidates any response that arrives after a cancel or
 * a newer compute, which handles the done/error-after-cancel race cleanly.
 */
export function useSolver(): SolverController {
  const [state, setState] = useState<SolverState>(INITIAL_STATE)
  const workerRef = useRef<Worker | null>(null)
  const generationRef = useRef(0)
  const cancelTimerRef = useRef<number | null>(null)

  const clearCancelTimer = useCallback(() => {
    if (cancelTimerRef.current !== null) {
      window.clearTimeout(cancelTimerRef.current)
      cancelTimerRef.current = null
    }
  }, [])

  const teardown = useCallback(() => {
    const worker = workerRef.current
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    workerRef.current = null
  }, [])

  const cancel = useCallback(() => {
    const worker = workerRef.current
    if (!worker) return
    // Ignore anything this worker may still emit.
    generationRef.current += 1
    setState((prev) =>
      prev.status === 'running'
        ? { ...prev, status: 'cancelled', result: null }
        : prev,
    )
    // Ask nicely (the worker replies 'cancelled') then hard-stop regardless.
    const request: WorkerRequest = { type: 'cancel' }
    worker.postMessage(request)
    clearCancelTimer()
    cancelTimerRef.current = window.setTimeout(() => {
      cancelTimerRef.current = null
      teardown()
    }, CANCEL_GRACE_MS)
  }, [clearCancelTimer, teardown])

  const compute = useCallback(
    (input: Setup, constants: PhysicsConstants) => {
      clearCancelTimer()
      teardown()

      const generation = generationRef.current + 1
      generationRef.current = generation
      setState({ ...INITIAL_STATE, status: 'running' })

      let worker: Worker
      try {
        worker = new Worker(new URL('../solver/worker.ts', import.meta.url), { type: 'module' })
      } catch (err) {
        setState({ ...INITIAL_STATE, status: 'error', error: describeError(err, 'Could not start the solver.') })
        return
      }
      workerRef.current = worker

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (generation !== generationRef.current) return
        const message = event.data
        switch (message.type) {
          case 'progress':
            setState((prev) => ({
              ...prev,
              status: 'running',
              progress: Math.max(
                prev.progress,
                normalizeProgress(message.progress),
              ),
              iteration: message.iteration,
              ke: message.ke,
            }))
            break
          case 'done': {
            const frames = message.result.frames
            setState({
              status: 'done',
              progress: 1,
              iteration: message.result.meta.iterations ?? frames.length,
              ke: frames.at(-1)?.ke ?? 0,
              result: message.result,
              error: null,
            })
            teardown()
            break
          }
          case 'cancelled':
            setState((prev) => ({ ...prev, status: 'cancelled', result: null }))
            teardown()
            break
          case 'error':
            setState({ ...INITIAL_STATE, status: 'error', error: message.message })
            teardown()
            break
        }
      }

      worker.onerror = (event: ErrorEvent) => {
        if (generation !== generationRef.current) return
        event.preventDefault()
        setState({
          ...INITIAL_STATE,
          status: 'error',
          error: event.message || 'The solver worker crashed.',
        })
        teardown()
      }

      worker.onmessageerror = () => {
        if (generation !== generationRef.current) return
        setState({ ...INITIAL_STATE, status: 'error', error: 'The solver sent an unreadable answer.' })
        teardown()
      }

      try {
        const request: WorkerRequest = { type: 'solve', input, constants }
        worker.postMessage(request)
      } catch (err) {
        setState({ ...INITIAL_STATE, status: 'error', error: describeError(err, 'Could not send the setup to the solver.') })
        teardown()
      }
    },
    [clearCancelTimer, teardown],
  )

  useEffect(
    () => () => {
      generationRef.current += 1
      clearCancelTimer()
      teardown()
    },
    [clearCancelTimer, teardown],
  )

  return { compute, cancel, state }
}
