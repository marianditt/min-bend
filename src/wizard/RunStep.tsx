import { useMemo } from 'react'
import { DEFAULT_CONSTANTS, type PhysicsConstants } from '../solver/types'
import { validateConstants, validateSetup } from '../solver/validate'
import type { SolverState } from '../hooks/useSolver'
import { formatEnergy } from '../lib/format'
import { NumberField } from '../ui/NumberField'
import { setResolution } from '../ui/setupEdits'
import type { SetupApi, StepId } from './types'

interface ConstantSpec {
  key: keyof PhysicsConstants
  label: string
  hint: string
  step: number
  integer?: boolean
  min: number
}

const CONSTANT_SPECS: ConstantSpec[] = [
  { key: 'friction', label: 'Friction', hint: 'how fast motion dies out', step: 0.1, min: 0 },
  { key: 'controlMass', label: 'Control point mass', hint: 'heavier = control points settle more slowly than the points between them', step: 0.5, min: 0.1 },
  { key: 'timeStep', label: 'Time step', hint: 'smaller = slower but safer', step: 0.005, min: 0 },
  { key: 'restThreshold', label: 'Rest threshold', hint: 'stop when motion is below this', step: 1e-4, min: 0 },
  { key: 'maxSteps', label: 'Step limit', hint: 'give up after this many steps', step: 1000, integer: true, min: 1 },
]

export function ProgressRing({ fraction, iteration }: { fraction: number; iteration: number }) {
  const size = 140
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, fraction))
  const percent = Math.round(clamped * 100)
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg className="ring" width={size} height={size} role="img" aria-label={`Solving, ${percent} percent`}>
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="ring__value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <div className="ring__label">
        <span className="ring__percent">{percent}%</span>
        <span className="ring__meta">{iteration.toLocaleString()} steps</span>
      </div>
    </div>
  )
}

const FIELD_STEP: Record<string, StepId> = { curve: 'points', fix: 'points', free: 'sketch', resolution: 'run', constraint: 'points', targetLength: 'points', flatness: 'points' }

function stepForField(field: string): StepId {
  return FIELD_STEP[field.split(':')[0]] ?? 'points'
}

interface RunStepProps {
  api: SetupApi
  solver: SolverState
  onRun: () => void
  onCancel: () => void
  onGoto: (step: StepId) => void
}

export function RunStep({ api, solver, onRun, onCancel, onGoto }: RunStepProps) {
  const { setup, constants } = api
  const issues = useMemo(() => validateSetup(setup), [setup])
  const constantsProblem = useMemo(() => validateConstants(constants), [constants])
  const running = solver.status === 'running'
  const canRun = issues.length === 0 && constantsProblem === null && !running
  const links = setup.constraints?.length ?? 0
  const fixedLengths = setup.curves.filter((c) => typeof c.targetLength === 'number').length

  if (running) {
    return (
      <div className="wiz-center">
        <ProgressRing fraction={solver.progress} iteration={solver.iteration} />
        <p className="wiz-note">Smoothing the curves… motion left: {formatEnergy(solver.ke)}</p>
        <button type="button" className="btn btn--danger" onClick={onCancel}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="wiz-stack">
      <section className="wiz-card">
        <header className="wiz-card__head">
          <h3>Your setup</h3>
        </header>
        <ul className="wiz-summary">
          <li>
            <span>{setup.curves.length} {setup.curves.length === 1 ? 'curve' : 'curves'}</span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onGoto('points')}>Edit</button>
          </li>
          <li>
            <span>{setup.curves.reduce((n, c) => n + c.fixPoints.length, 0)} points you defined</span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onGoto('points')}>Edit</button>
          </li>
          <li>
            <span>{fixedLengths} fixed {fixedLengths === 1 ? 'length' : 'lengths'}, {links} {links === 1 ? 'link' : 'links'}</span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onGoto('points')}>Edit</button>
          </li>
        </ul>
      </section>

      <section className="wiz-card">
        <header className="wiz-card__head">
          <h3>Detail</h3>
        </header>
        <NumberField
          label="Distance between neighbouring points"
          hint="smaller = smoother result, slower solve"
          value={setup.resolution}
          step={0.25}
          min={0}
          disabled={running}
          onChange={(v) => api.update((s) => setResolution(s, v), { history: false })}
        />
        <p className="wiz-note">
          Points are added or removed automatically while solving so this spacing is kept as the curve grows or shrinks.
        </p>
      </section>

      <details className="wiz-card wiz-advanced">
        <summary>Advanced solver settings</summary>
        <div className="wiz-grid2">
          {CONSTANT_SPECS.map((spec) => (
            <NumberField
              key={spec.key}
              label={spec.label}
              hint={spec.hint}
              value={constants[spec.key]}
              step={spec.step}
              integer={spec.integer}
              min={spec.min}
              onChange={(value) => api.setConstants({ ...constants, [spec.key]: value })}
            />
          ))}
        </div>
        <button type="button" className="btn btn--sm" onClick={() => api.setConstants({ ...DEFAULT_CONSTANTS })}>
          Reset to defaults
        </button>
      </details>

      {issues.length > 0 || constantsProblem ? (
        <section className="wiz-card wiz-card--problem" role="alert">
          <h3>Fix this before solving</h3>
          <ul className="wiz-list">
            {issues.map((issue, i) => (
              <li key={i} className="wiz-list__item">
                <span>{issue.message}</span>
                <button type="button" className="btn btn--sm" onClick={() => onGoto(stepForField(issue.field))}>
                  Go fix
                </button>
              </li>
            ))}
            {constantsProblem ? <li className="wiz-list__item">{constantsProblem}</li> : null}
          </ul>
        </section>
      ) : null}

      {solver.status === 'error' ? (
        <section className="wiz-card wiz-card--problem" role="alert">
          <h3>The solver stopped with an error</h3>
          <p>{solver.error}</p>
          <p className="wiz-note">Nothing is lost. Adjust your setup if needed and press Solve again.</p>
        </section>
      ) : null}
      {solver.status === 'cancelled' ? <p className="wiz-note">Cancelled. Press Solve to start again.</p> : null}

      <button type="button" className="btn btn--primary btn--lg btn--block" disabled={!canRun} onClick={onRun}>
        {solver.status === 'error' ? 'Try again' : 'Solve'}
      </button>
    </div>
  )
}
