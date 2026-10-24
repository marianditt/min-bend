import type { useSetupState } from '../hooks/useSetupState'

export type SetupApi = ReturnType<typeof useSetupState>

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
    help: 'Each curve passes through points you define. For every point choose where it sits and which way the curve points there.',
  },
  {
    id: 'rules',
    label: 'Rules',
    title: 'Add rules',
    help: 'Optional. Fix how long a curve must be, or make one point copy the position or direction of another.',
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
