// Web Worker message protocol shared by the solver worker and the UI hook.
// FROZEN: both sides are built against these types.

import type { FrameSet, PhysicsConstants, Setup } from './types'

export type WorkerRequest =
  | { type: 'solve'; input: Setup; constants: PhysicsConstants }
  | { type: 'cancel' }

export type WorkerResponse =
  | { type: 'progress'; progress: number; iteration: number; ke: number }
  | { type: 'done'; result: FrameSet }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
