import { useMemo, useState } from 'react'
import { validateSetup } from '../solver/validate'
import { DEFAULT_CONSTANTS, type PhysicsConstants, type PointRef, type Setup, type Vec2 } from '../solver/types'
import type { SolverStatus } from '../hooks/useSolver'
import { NumberField } from './NumberField'
import {
  addConstraint,
  addCurve,
  addFixPoint,
  clearSpan,
  moveFix,
  removeConstraint,
  removeCurve,
  removeFixPoint,
  setResolution,
  setFixPosFree,
  setCurveTargetLength,
  setFixOrientation,
  setFixOrientationComponent,
} from './setupEdits'
import { constraintFor, pointLabel, resolveSetup } from '../solver/constraints'
import { previewPose } from '../solver/solve'
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
  onReset: () => void
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
  return null
}

function curvePreviewLength(setup: Setup, ci: number): number {
  const poly = previewPose(setup)[ci]
  if (!poly || poly.length < 2) return 0
  let total = 0
  for (let i = 0; i + 1 < poly.length; i++) {
    total += Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
  }
  return Math.round(total * 100) / 100
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

type LinkKind = 'position' | 'orientation' | 'both'

const KIND_OPTIONS: { value: LinkKind; label: string }[] = [
  { value: 'position', label: 'Position' },
  { value: 'orientation', label: 'Orientation' },
  { value: 'both', label: 'Both' },
]

function ConstraintsSection({
  setup,
  running,
  byField,
  onEdit,
}: {
  setup: Setup
  running: boolean
  byField: Map<string, string>
  onEdit: (mutator: (setup: Setup) => Setup) => void
}) {
  const options = useMemo(
    () => setup.curves.flatMap((c, ci) => c.fixPoints.map((_, pi): PointRef => ({ curve: ci, point: pi }))),
    [setup],
  )
  const key = (r: PointRef) => `${r.curve}:${r.point}`
  const parse = (v: string): PointRef => {
    const [curve, point] = v.split(':').map(Number)
    return { curve, point }
  }
  const [target, setTarget] = useState('')
  const [source, setSource] = useState('')
  const [kind, setKind] = useState<LinkKind>('position')

  const validKey = (v: string, fallback: string) => (options.some((o) => key(o) === v) ? v : fallback)
  const t = validKey(target, options[0] ? key(options[0]) : '')
  const sFallback = options.find((o) => key(o) !== t)
  const sv = validKey(source, sFallback ? key(sFallback) : '')
  const canLink = !running && t !== '' && sv !== '' && t !== sv

  const link = () => {
    const kinds = kind === 'both' ? (['position', 'orientation'] as const) : ([kind] as const)
    onEdit((s) => kinds.reduce((acc, k) => addConstraint(acc, { kind: k, source: parse(sv), target: parse(t) }), s))
  }

  const list = setup.constraints ?? []

  return (
    <section className="sidebar__section">
      <div className="sidebar__section-head">
        <h2 className="sidebar__section-title">Constraints</h2>
      </div>
      <p className="constraints__intro">
        Make a point copy the position and/or orientation of a point on another curve. The copied inputs are locked.
      </p>

      {list.length > 0 ? (
        <ul className="constraint-list">
          {list.map((c, i) => (
            <li className="constraint-row" key={i}>
              <span className={`chip chip--${c.kind}`}>{c.kind === 'position' ? 'Position' : 'Orientation'}</span>
              <span className="constraint-row__text">
                <strong>{pointLabel(c.target)}</strong>
                <span className="constraint-row__arrow" aria-label="follows">←</span>
                <strong>{pointLabel(c.source)}</strong>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={running}
                title="Remove constraint"
                aria-label="Remove constraint"
                onClick={() => onEdit((s) => removeConstraint(s, i))}
              >
                ✕
              </button>
              {byField.get(`constraint:${i}`) ? (
                <p className="group__error" role="alert">{byField.get(`constraint:${i}`)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="constraint-form">
        <label className="select-field">
          <span>Constrain</span>
          <select value={t} disabled={running} onChange={(e) => setTarget(e.target.value)}>
            {options.map((o) => (
              <option key={key(o)} value={key(o)}>{pointLabel(o)}</option>
            ))}
          </select>
        </label>
        <label className="select-field">
          <span>to follow</span>
          <select value={sv} disabled={running} onChange={(e) => setSource(e.target.value)}>
            {options.map((o) => (
              <option key={key(o)} value={key(o)} disabled={key(o) === t}>{pointLabel(o)}</option>
            ))}
          </select>
        </label>
        <div className="segmented" role="radiogroup" aria-label="Constrained property">
          {KIND_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.value}
              role="radio"
              aria-checked={kind === o.value}
              className={`segmented__item ${kind === o.value ? 'is-active' : ''}`}
              onClick={() => setKind(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--primary btn--block" disabled={!canLink} onClick={link}>
          Add constraint
        </button>
      </div>
    </section>
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
  onReset,
}: SidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const running = status === 'running'

  const toggleCollapsed = (index: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  const issues = useMemo(() => validateSetup(setup), [setup])
  const byField = useMemo(() => {
    const map = new Map<string, string>()
    for (const issue of issues) if (!map.has(issue.field)) map.set(issue.field, issue.message)
    return map
  }, [issues])

  const resolved = useMemo(() => resolveSetup(setup).setup, [setup])

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
          <div className="sidebar__section-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={running}
              title="Restore the default setup and physics constants"
              onClick={onReset}
            >
              Reset
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={running}
              onClick={() => onEdit(addCurve)}
            >
              + Add curve
            </button>
          </div>
        </div>

        <NumberField
          label="Resolution (line length)"
          hint="shared by all curves; the last line of a span may be shorter"
          value={setup.resolution}
          step={0.1}
          min={0}
          disabled={running}
          error={byField.get('resolution') ?? null}
          onChange={(value) => onEdit((s) => setResolution(s, value))}
        />

        {setup.curves.map((curve, ci) => (
          <div
            className={`curve-card ${collapsed.has(ci) ? 'is-collapsed' : ''}`}
            key={ci}
          >
            <div className="curve-card__head">
              <button
                type="button"
                className="curve-card__toggle"
                aria-expanded={!collapsed.has(ci)}
                onClick={() => toggleCollapsed(ci)}
              >
                <svg className="curve-card__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="curve-card__title">Curve {ci + 1}</span>
                {collapsed.has(ci) ? (
                  <span className="curve-card__summary">
                    {curve.fixPoints.length} control points
                    {curve.targetLength != null ? ` · L ${curve.targetLength}` : ''}
                  </span>
                ) : null}
              </button>
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

            <label className="switch">
              <input
                type="checkbox"
                checked={curve.targetLength != null}
                disabled={running}
                title="Aim the sum of all segment lengths at a target"
                onChange={(event) => {
                  const enabled = event.target.checked
                  onEdit((s) =>
                    setCurveTargetLength(s, ci, enabled ? curvePreviewLength(s, ci) : null),
                  )
                }}
              />
              <span>Constrain path length</span>
            </label>

            {curve.targetLength != null ? (
              <NumberField
                label="Target path length"
                hint="sum of all segments"
                value={curve.targetLength}
                step={1}
                min={0}
                disabled={running}
                error={byField.get(`targetLength:${ci}`) ?? null}
                onChange={(value) => onEdit((s) => setCurveTargetLength(s, ci, value))}
              />
            ) : null}

            {byField.get(`fixPoints:${ci}`) ? (
              <p className="group__error" role="alert">{byField.get(`fixPoints:${ci}`)}</p>
            ) : null}

            <div className="fix-list">
              {curve.fixPoints.map((authoredFp, pi) => {
                const fp = resolved.curves[ci]?.fixPoints[pi] ?? authoredFp
                const ref: PointRef = { curve: ci, point: pi }
                const posLink = constraintFor(setup, 'position', ref)
                const oriLink = constraintFor(setup, 'orientation', ref)
                const oriented = fp.orientation !== null
                const firstLabel = pi === 0 ? 'start' : pi === curve.fixPoints.length - 1 ? 'end' : 'joint'
                return (
                  <div className="fix-item" key={pi}>
                    <div className="fix-item__head">
                      <span className="fix-item__label">
                        Control point {pi + 1} <em>{firstLabel}</em>
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
                      label={fp.posFree ? `Control point ${pi + 1} initial position` : `Control point ${pi + 1} position`}
                      value={fp.pos}
                      disabled={running || !!posLink}
                      onChange={(axis, component) => onEdit((s) => moveFix(s, ci, pi, axis, component))}
                    />
                    {byField.get(`fixPoint:${ci}:${pi}`) ? (
                      <p className="group__error" role="alert">{byField.get(`fixPoint:${ci}:${pi}`)}</p>
                    ) : null}
                    {posLink ? (
                      <p className="link-note">🔗 Position follows {pointLabel(posLink.source)}</p>
                    ) : null}
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={!fp.posFree}
                        disabled={running || !!posLink}
                        onChange={(event) => onEdit((s) => setFixPosFree(s, ci, pi, !event.target.checked))}
                      />
                      <span>Fix position</span>
                    </label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={oriented}
                        disabled={running || !!oriLink}
                        onChange={(event) =>
                          onEdit((s) => setFixOrientation(s, ci, pi, event.target.checked ? [1, 0] : null))
                        }
                      />
                      <span>Fix orientation (tangent)</span>
                    </label>
                    {oriLink ? (
                      <p className="link-note">🔗 Orientation follows {pointLabel(oriLink.source)}</p>
                    ) : null}
                    {oriented && fp.orientation ? (
                      <>
                        <VecInput
                          label={`Fix point ${pi + 1} orientation`}
                          value={fp.orientation}
                          disabled={running || !!oriLink}
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
                  return (
                    <li className="span-row" key={si}>
                      <span className="span-row__label">Span {si + 1}</span>
                      <span className="span-row__count">
                        {span.length} guide points
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

      <ConstraintsSection setup={setup} running={running} byField={byField} onEdit={onEdit} />

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
