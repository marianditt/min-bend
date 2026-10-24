import type { PointId } from '../solver/types'
import type { useSetupState } from '../hooks/useSetupState'

export type SetupApi = ReturnType<typeof useSetupState>

/** A point chosen on the canvas or from another step; `n` makes re-picking the same point count. */
export interface PointSelection {
  id: PointId
  n: number
}

export type StepId = 'points' | 'rules' | 'sketch' | 'run' | 'result'

export interface StepInfo {
  id: StepId
  label: string
  title: string
  help: string
}

export const STEPS: StepInfo[] = [
  {
    id: 'points',
    label: 'Points',
    title: 'Where must the curve go?',
    help: 'Draw on the picture or use the cards below: each point can be fixed, free, or follow another point’s position or direction.',
  },
  {
    id: 'rules',
    label: 'Rules',
    title: 'Add rules',
    help: 'Optional. Fix how long a curve must be, and review which points follow others. Links are edited on the point itself.',
  },
  {
    id: 'sketch',
    label: 'Sketch',
    title: 'Sketch a rough route',
    help: 'Optional. Tap the picture to drop guide points that decide which way around the curve starts. They are only a starting hint.',
  },
  {
    id: 'run',
    label: 'Solve',
    title: 'Check and solve',
    help: 'The solver relaxes each curve until its total bending is as small as it can be while keeping your points and rules.',
  },
  {
    id: 'result',
    label: 'Result',
    title: 'Your curve',
    help: 'Play the animation to watch the curve settle. The last frame is the answer.',
  },
]
