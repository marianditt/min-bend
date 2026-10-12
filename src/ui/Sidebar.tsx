import { useMemo, useState } from 'react'
import { validateInput } from '../solver/validate'
import {
  DEFAULT_CONSTANTS,
  type PhysicsConstants,
  type ProblemInput,
  type Vec2,
} from '../solver/types'
import type { SolverStatus } from '../hooks/useSolver'
import { NumberField } from './NumberField'
import './sidebar.css'

export interface SidebarProps {
  status: SolverStatus
  progress: number
  iteration: number
  ke: number
  resultIterations: number | null
  termination: 'ke' | 'maxIter' | null
  error: string | null
  onCompute: (input: ProblemInput, constants: PhysicsConstants) => void
  onCancel: () => void
  input: ProblemInput
  constants: PhysicsConstants
  onInputChange: (next: ProblemInput) => void
  onConstantsChange: (next: PhysicsConstants) => void
}

type VecKey = 'start' | 'end' | 'startDir' | 'endDir'

interface ConstantSpec {
  key: keyof PhysicsConstants
  label: string
  hint: string
  step: number
  integer?: boolean
  min?: number
  wide?: boolean
}

const CONSTANT_SPECS: ConstantSpec[] = [
  { key: 'kLen', label: 'Segment stiffness', hint: 'length-error penalty', step: 1, min: 0 },
  { key: 'kBend', label: 'Bend stiffness', hint: 'curvature penalty', step: 0.1, min: 0 },
  { key: 'gamma', label: 'Friction γ', hint: 'velocity damping', step: 0.05, min: 0 },
  { key: 'h', label: 'Step size', hint: 'integration dt', step: 0.005, min: 0 },
  {
    key: 'epsilon',
    label: 'KE threshold ε',
    hint: 'stop below this',
    step: 1e-4,
    min: 0,
    wide: true,
  },
  {
    key: 'settleFrames',
    label: 'Settle frames',
    hint: 'KE below ε for N frames',
    step: 1,
    integer: true,
    min: 1,
  },
  {
    key: 'maxIter',
    label: 'Max iterations',
    hint: 'safety cap',
    step: 500,
    integer: true,
    min: 1,
  },
  {
    key: 'maxForce',
    label: 'Max force',
    hint: 'per-point force cap',
    step: 100,
    min: 0,
  },
]

function formatEnergy(ke: number): string {
  if (!Number.isFinite(ke)) return '—'
  if (ke === 0) return '0'
  const abs = Math.abs(ke)
  if (abs >= 0.01 && abs < 1e4) return ke.toFixed(3)
  return ke.toExponential(2)
}

/** Returns a human message when the constants are unusable, else null. */
function constantProblem(c: PhysicsConstants): string | null {
  const named: [string, number][] = [
    ['Segment stiffness', c.kLen],
    ['Bend stiffness', c.kBend],
    ['Friction', c.gamma],
    ['Step size', c.h],
    ['KE threshold', c.epsilon],
    ['Settle frames', c.settleFrames],
    ['Max iterations', c.maxIter],
    ['Max force', c.maxForce],
  ]
  for (const [name, value] of named) {
    if (!Number.isFinite(value)) return `${name} must be a finite number.`
  }
  if (c.kLen < 0 || c.kBend < 0) return 'Stiffnesses must be ≥ 0.'
  if (c.gamma < 0) return 'Friction must be ≥ 0.'
  if (!(c.h > 0)) return 'Step size must be > 0.'
  if (c.epsilon < 0) return 'KE threshold must be ≥ 0.'
  if (c.settleFrames < 1) return 'Settle frames must be ≥ 1.'
  if (c.maxIter < 1) return 'Max iterations must be ≥ 1.'
  if (!(c.maxForce > 0)) return 'Max force must be > 0.'
  return null
}

function VectorField({
  label,
  hint,
  value,
  onChange,
  step,
  error,
  disabled,
}: {
  label: string
  hint?: string
  value: Vec2
  onChange: (axis: 0 | 1, component: number) => void
  step?: number
  error?: string | null
  disabled?: boolean
}) {
  return (
    <div className="group">
      <div className="group__head">
        <span className="group__label">{label}</span>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
      <div className="vector">
        <NumberField
          label="X"
          value={value[0]}
          step={step}
          disabled={disabled}
          onChange={(component) => onChange(0, component)}
        />
        <NumberField
          label="Y"
          value={value[1]}
          step={step}
          disabled={disabled}
          onChange={(component) => onChange(1, component)}
        />
      </div>
      {error ? (
        <p className="group__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.5 21 19H3l9-15.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 9.5v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.6" r="1" fill="currentColor" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m8 12.4 2.7 2.7L16 9.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Sidebar({
  status,
  progress,
  iteration,
  ke,
  resultIterations,
  termination,
  error,
  onCompute,
  onCancel,
  input,
  constants,
  onInputChange,
  onConstantsChange,
}: SidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const running = status === 'running'

  const issues = useMemo(() => validateInput(input), [input])
  const byField = useMemo(() => {
    const map = new Map<string, string>()
    for (const issue of issues) {
      if (!map.has(issue.field)) map.set(issue.field, issue.message)
    }
    return map
  }, [issues])

  const constProblem = useMemo(() => constantProblem(constants), [constants])
  const canCompute = issues.length === 0 && constProblem === null && !running

  const setVec = (key: VecKey, axis: 0 | 1, component: number) => {
  const newVec: Vec2 = [input[key][0], input[key][1]]
  newVec[axis] = component
  onInputChange({ ...input, [key]: newVec })
}

const setConstant = (key: keyof PhysicsConstants, value: number) =>
  onConstantsChange({ ...constants, [key]: value })

  const percent = Math.round(progress * 100)
  const blockers: string[] = []
  if (issues.length > 0) {
    blockers.push(`${issues.length} invalid field${issues.length > 1 ? 's' : ''}`)
  }
  if (constProblem) blockers.push(constProblem)

  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <h2 className="sidebar__section-title">Problem</h2>

        <NumberField
          label="Interior points (n)"
          hint="N = n + 2"
          value={input.n}
          step={1}
          integer
          min={2}
          disabled={running}
          error={byField.get('n') ?? null}
          onChange={(value) => onInputChange({ ...input, n: value })}
        />

        <VectorField
          label="Start point"
          hint="p₀ (fixed)"
          value={input.start}
          step={0.5}
          disabled={running}
          error={byField.get('start') ?? null}
          onChange={(axis, component) => setVec('start', axis, component)}
        />

        <VectorField
          label="End point"
          hint="pₙ₊₁ (fixed)"
          value={input.end}
          step={0.5}
          disabled={running}
          error={byField.get('end') ?? null}
          onChange={(axis, component) => setVec('end', axis, component)}
        />

        <VectorField
          label="Start orientation"
          hint="direction of p₁ − p₀"
          value={input.startDir}
          step={0.5}
          disabled={running}
          error={byField.get('startDir') ?? null}
          onChange={(axis, component) => setVec('startDir', axis, component)}
        />

        <VectorField
          label="End orientation"
          hint="direction of pₙ₊₁ − pₙ"
          value={input.endDir}
          step={0.5}
          disabled={running}
          error={byField.get('endDir') ?? null}
          onChange={(axis, component) => setVec('endDir', axis, component)}
        />
      </section>

      <section className="sidebar__section">
        <button
          type="button"
          className="advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="advanced-constants"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>Advanced constants</span>
          <svg
            className="advanced-toggle__chevron"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {advancedOpen ? (
          <div className="advanced" id="advanced-constants">
            <div className="advanced__header">
              <span className="advanced__title">Physics / solver</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onConstantsChange(DEFAULT_CONSTANTS)}
                title="Restore all constants to their default values"
              >
                Reset to defaults
              </button>
            </div>
            <div className="advanced__grid">
              {CONSTANT_SPECS.map((spec) => (
                <div key={spec.key} className={spec.wide ? 'advanced__wide' : undefined}>
                  <NumberField
                    label={spec.label}
                    hint={spec.hint}
                    value={constants[spec.key]}
                    step={spec.step}
                    integer={spec.integer}
                    min={spec.min}
                    disabled={running}
                    onChange={(value) => setConstant(spec.key, value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <div className="sidebar__actions">
        {status === 'running' ? (
          <>
            <div className="progress-row">
              <span className="progress-percent">{percent}%</span>
              <span className="progress-steps">
                {iteration.toLocaleString()} steps
              </span>
            </div>
            <div
              className="bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Solver progress"
            >
              <div className="bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="progress-ke">kinetic energy · {formatEnergy(ke)}</span>
            <button
              type="button"
              className="btn btn--danger btn--block"
              onClick={onCancel}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {status === 'error' && error ? (
              <div className="notice notice--error" role="alert">
                <WarningIcon />
                <div className="notice__body">
                  <span className="notice__title">Computation failed</span>
                  <span>{error}</span>
                </div>
              </div>
            ) : null}

            {status === 'done' && resultIterations !== null ? (
              <div className="notice notice--success" role="status">
                <CheckIcon />
                <div className="notice__body">
                  <span className="notice__title">
                    {termination === 'ke'
                      ? 'Converged — KE threshold reached'
                      : 'Stopped — max iterations reached'}
                  </span>
                  <span className="notice__meta">
                    {resultIterations.toLocaleString()} iterations · final KE{' '}
                    {formatEnergy(ke)}
                  </span>
                </div>
              </div>
            ) : null}

            {status === 'cancelled' ? (
              <div className="notice notice--warn" role="status">
                <WarningIcon />
                <div className="notice__body">
                  <span className="notice__title">Computation cancelled</span>
                  <span>Adjust the inputs and compute again.</span>
                </div>
              </div>
            ) : null}

            {blockers.length > 0 ? (
              <p className="actions-hint" role="status">
                {blockers.join(' · ')} — fix to enable Compute.
              </p>
            ) : null}

            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              disabled={!canCompute}
              onClick={() => onCompute(input, constants)}
            >
              {status === 'done' || status === 'error' || status === 'cancelled'
                ? 'Compute again'
                : 'Compute'}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

export default Sidebar
