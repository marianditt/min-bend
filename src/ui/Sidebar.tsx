import { useMemo, useState } from 'react'
import { validateSetup } from '../solver/validate'
import { DEFAULT_CONSTANTS, type PhysicsConstants, type Setup, type Vec2 } from '../solver/types'
import type { SolverStatus } from '../hooks/useSolver'
import { NumberField } from './NumberField'
import {
  addCurve,
  addFixPoint,
  clearSpan,
  moveFix,
  removeCurve,
  removeFixPoint,
  setCurveN,
  setFixOrientation,
  setFixOrientationComponent,
} from './setupEdits'
import { freeSlotCount } from '../solver/curve'
import { formatEnergy } from '../lib/format'
import './sidebar.css'

export interface SidebarProps {
  status: SolverStatus
  progress: number
  iteration: number
  ke: number
  resultIterations: number | null
  termination: 'ke' | 'maxIter' | null
  error: string | null
  onCompute: (setup: Setup, constants: PhysicsConstants) => void
  onCancel: () => void
  setup: Setup
  constants: PhysicsConstants
  onEdit: (mutator: (setup: Setup) => Setup) => void
  onConstantsChange: (next: PhysicsConstants) => void
}

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
  { key: 'epsilon', label: 'KE threshold ε', hint: 'stop below this', step: 1e-4, min: 0, wide: true },
  { key: 'settleFrames', label: 'Settle frames', hint: 'KE below ε for N frames', step: 1, integer: true, min: 1 },
  { key: 'maxIter', label: 'Max iterations', hint: 'safety cap', step: 500, integer: true, min: 1 },
  { key: 'maxForce', label: 'Max force', hint: 'per-point force cap', step: 100, min: 0 },
]

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

function VecInput({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: Vec2
  disabled?: boolean
  onChange: (axis: 0 | 1, component: number) => void
}) {
  return (
    <div className="vector" role="group" aria-label={label}>
      <NumberField label="X" value={value[0]} step={0.5} disabled={disabled} onChange={(v) => onChange(0, v)} />
      <NumberField label="Y" value={value[1]} step={0.5} disabled={disabled} onChange={(v) => onChange(1, v)} />
    </div>
  )
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5 21 19H3l9-15.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 9.5v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.6" r="1" fill="currentColor" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 12.4 2.7 2.7L16 9.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
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
  setup,
  constants,
  onEdit,
  onConstantsChange,
}: SidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const running = status === 'running'

  const issues = useMemo(() => validateSetup(setup), [setup])
  const byField = useMemo(() => {
    const map = new Map<string, string>()
    for (const issue of issues) if (!map.has(issue.field)) map.set(issue.field, issue.message)
    return map
  }, [issues])

  const constProblem = useMemo(() => constantProblem(constants), [constants])
  const canCompute = issues.length === 0 && constProblem === null && !running

  const setConstant = (key: keyof PhysicsConstants, value: number) =>
    onConstantsChange({ ...constants, [key]: value })

  const percent = Math.round(progress * 100)
  const blockers: string[] = []
  if (issues.length > 0) blockers.push(`${issues.length} invalid field${issues.length > 1 ? 's' : ''}`)
  if (constProblem) blockers.push(constProblem)

  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <div className="sidebar__section-head">
          <h2 className="sidebar__section-title">Curves</h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={running}
            onClick={() => onEdit(addCurve)}
          >
            + Add curve
          </button>
        </div>

        {setup.curves.map((curve, ci) => (
          <div className="curve-card" key={ci}>
            <div className="curve-card__head">
              <span className="curve-card__title">Curve {ci + 1}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={running || setup.curves.length <= 1}
                title={setup.curves.length <= 1 ? 'At least one curve is required' : 'Remove this curve'}
                onClick={() => onEdit((s) => removeCurve(s, ci))}
              >
                Remove
              </button>
            </div>

            <NumberField
              label="Interior points per span (n)"
              hint="between each fix-point pair"
              value={curve.n}
              step={1}
              integer
              min={0}
              disabled={running}
              error={byField.get(`n:${ci}`) ?? null}
              onChange={(value) => onEdit((s) => setCurveN(s, ci, value))}
            />

            {byField.get(`fixPoints:${ci}`) ? (
              <p className="group__error" role="alert">{byField.get(`fixPoints:${ci}`)}</p>
            ) : null}

            <div className="fix-list">
              {curve.fixPoints.map((fp, pi) => {
                const oriented = fp.orientation !== null
                const firstLabel = pi === 0 ? 'start' : pi === curve.fixPoints.length - 1 ? 'end' : 'joint'
                return (
                  <div className="fix-item" key={pi}>
                    <div className="fix-item__head">
                      <span className="fix-item__label">
                        Fix point {pi + 1} <em>{firstLabel}</em>
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={running || curve.fixPoints.length <= 2}
                        title={curve.fixPoints.length <= 2 ? 'A curve needs at least two fix points' : 'Remove fix point'}
                        onClick={() => onEdit((s) => removeFixPoint(s, ci, pi))}
                      >
                        ✕
                      </button>
                    </div>
                    <VecInput
                      label={`Fix point ${pi + 1} position`}
                      value={fp.pos}
                      disabled={running}
                      onChange={(axis, component) => onEdit((s) => moveFix(s, ci, pi, axis, component))}
                    />
                    {byField.get(`fixPoint:${ci}:${pi}`) ? (
                      <p className="group__error" role="alert">{byField.get(`fixPoint:${ci}:${pi}`)}</p>
                    ) : null}
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={oriented}
                        disabled={running}
                        onChange={(event) =>
                          onEdit((s) => setFixOrientation(s, ci, pi, event.target.checked ? [1, 0] : null))
                        }
                      />
                      <span>Fix orientation (tangent)</span>
                    </label>
                    {oriented && fp.orientation ? (
                      <>
                        <VecInput
                          label={`Fix point ${pi + 1} orientation`}
                          value={fp.orientation}
                          disabled={running}
                          onChange={(axis, component) =>
                            onEdit((s) => setFixOrientationComponent(s, ci, pi, axis, component))
                          }
                        />
                        {byField.get(`orientation:${ci}:${pi}`) ? (
                          <p className="group__error" role="alert">{byField.get(`orientation:${ci}:${pi}`)}</p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={running}
              onClick={() => onEdit((s) => addFixPoint(s, ci))}
            >
              + Add fix point
            </button>

            {curve.spans.length > 0 ? (
              <ul className="span-list">
                {curve.spans.map((span, si) => {
                  const capacity = freeSlotCount(curve, si)
                  return (
                    <li className="span-row" key={si}>
                      <span className="span-row__label">Span {si + 1}</span>
                      <span className="span-row__count">
                        {span.length} / {capacity} free
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={running || span.length === 0}
                        onClick={() => onEdit((s) => clearSpan(s, ci, si))}
                      >
                        Clear
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        ))}
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
          <svg className="advanced-toggle__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
              <span className="progress-steps">{iteration.toLocaleString()} steps</span>
            </div>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Solver progress">
              <div className="bar__fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="progress-ke">kinetic energy · {formatEnergy(ke)}</span>
            <button type="button" className="btn btn--danger btn--block" onClick={onCancel}>
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
                    {termination === 'ke' ? 'Converged — KE threshold reached' : 'Stopped — max iterations reached'}
                  </span>
                  <span className="notice__meta">
                    {resultIterations.toLocaleString()} iterations · final KE {formatEnergy(ke)}
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
              onClick={() => onCompute(setup, constants)}
            >
              {status === 'done' || status === 'error' || status === 'cancelled' ? 'Compute again' : 'Compute'}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

export default Sidebar
