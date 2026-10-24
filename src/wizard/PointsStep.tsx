import { useEffect, useState } from 'react'
import { constraintFor, locate, pointLabel } from '../solver/constraints'
import type { Constraint, FixPoint, PointId, Setup, Vec2 } from '../solver/types'
import { NumberField } from '../ui/NumberField'
import { PoseEditor } from '../ui/PoseEditor'
import {
  addConstraint,
  addCurve,
  addFixPoint,
  followPoint,
  moveFix,
  removeConstraintOn,
  removeCurve,
  removeFixPoint,
  setConstraintDelta,
  setFixOrientation,
  setFixPosFree,
} from '../ui/setupEdits'
import { degreesToVector, vectorToDegrees } from './orientation'
import type { PointSelection, SetupApi } from './types'

function pointRole(index: number, count: number): string {
  if (index === 0) return 'start'
  if (index === count - 1) return 'end'
  return 'via'
}

const num = (v: number) => String(Math.round(v * 100) / 100)

function describeFollow(setup: Setup, c: Constraint): string {
  const from = pointLabel(setup, c.source)
  if (c.kind === 'orientation') {
    const delta = c.delta ?? 0
    return delta === 0 ? `follows ${from}` : `follows ${from} turned by ${num(delta)}°`
  }
  const [dx, dy] = c.delta ?? [0, 0]
  return dx === 0 && dy === 0 ? `follows ${from}` : `follows ${from} shifted by (${num(dx)}, ${num(dy)})`
}

/** Read-only state of a point, shown apart from the editing controls. */
function describePoint(setup: Setup, fp: FixPoint): string {
  const posRule = constraintFor(setup, 'position', fp.id)
  const dirRule = constraintFor(setup, 'orientation', fp.id)
  const pos = posRule
    ? `Position ${describeFollow(setup, posRule)}`
    : fp.posFree
      ? `Any position (starts near ${num(fp.pos[0])}, ${num(fp.pos[1])})`
      : `Fixed at (${num(fp.pos[0])}, ${num(fp.pos[1])})`
  const dir = dirRule
    ? `direction ${describeFollow(setup, dirRule)}`
    : fp.orientation
      ? `fixed direction ${num(vectorToDegrees(fp.orientation))}°`
      : 'any direction'
  return `${pos} · ${dir}`
}

type Mode = 'fixed' | 'any' | 'follow'

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Mode
  options: { value: Mode; text: string }[]
  onChange: (v: Mode) => void
}) {
  return (
    <div className="wiz-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`wiz-choice__btn ${o.value === value ? 'is-active' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </button>
      ))}
    </div>
  )
}

/** Editor of one "follow another point" constraint: which point, and the fixed offset. */
function FollowEditor({
  setup,
  api,
  constraint,
  label,
}: {
  setup: Setup
  api: SetupApi
  constraint: Constraint
  label: string
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const { update } = api
  const onSource = (source: PointId) => {
    const next = addConstraint(setup, { ...constraint, source })
    if (next === setup) {
      setProblem('That would make the points follow each other in a loop.')
      return
    }
    setProblem(null)
    update(() => next)
  }
  return (
    <div className="wiz-follow">
      <label className="wiz-select">
        <span className="wiz-field__label">Follow which point?</span>
        <select value={constraint.source} aria-label={`${label}: follow which point`} onChange={(e) => onSource(e.target.value)}>
          {setup.curves.flatMap((c, ci) =>
            c.fixPoints.flatMap((fp, pi) =>
              fp.id === constraint.target
                ? []
                : [
                    <option key={fp.id} value={fp.id}>
                      Curve {ci + 1} · Point {pi + 1}
                    </option>,
                  ],
            ),
          )}
        </select>
      </label>
      {constraint.kind === 'orientation' ? (
        <NumberField
          label="Angle offset (degrees)"
          hint="0° = exactly the same direction"
          value={constraint.delta ?? 0}
          step={15}
          onChange={(v) => update((s) => setConstraintDelta(s, 'orientation', constraint.target, v))}
        />
      ) : (
        <div className="wiz-grid2">
          <NumberField
            label="Offset X"
            hint="0 = same place"
            value={constraint.delta?.[0] ?? 0}
            step={0.5}
            onChange={(v) =>
              update((s) => setConstraintDelta(s, 'position', constraint.target, [v, constraint.delta?.[1] ?? 0] as Vec2))
            }
          />
          <NumberField
            label="Offset Y"
            value={constraint.delta?.[1] ?? 0}
            step={0.5}
            onChange={(v) =>
              update((s) => setConstraintDelta(s, 'position', constraint.target, [constraint.delta?.[0] ?? 0, v] as Vec2))
            }
          />
        </div>
      )}
      {problem ? (
        <p className="wiz-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

export function PointsStep({
  api,
  selected,
  onSelect,
}: {
  api: SetupApi
  selected: PointSelection | null
  onSelect: (id: PointId) => void
}) {
  const { setup, update } = api
  const [activeCurve, setActiveCurve] = useState(0)
  // Curves are collapsed by the id of their first point, which stays stable while editing.
  const [collapsed, setCollapsed] = useState<Set<PointId>>(new Set())
  const active = Math.min(activeCurve, setup.curves.length - 1)

  const curveKey = (ci: number) => setup.curves[ci].fixPoints[0].id
  const toggle = (key: PointId) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // Jump to a point picked on the canvas or from another step: open its curve and scroll to it.
  useEffect(() => {
    if (!selected) return
    const ref = locate(setup, selected.id)
    if (!ref) return
    setActiveCurve(ref.curve)
    const key = setup.curves[ref.curve].fixPoints[0].id
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
    const frame = requestAnimationFrame(() =>
      document.getElementById(`point-${selected.id}`)?.scrollIntoView?.({ block: 'center' }),
    )
    return () => cancelAnimationFrame(frame)
    // Only a new selection should move the page, not every edit of the setup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const setPosition = (fp: FixPoint, mode: Mode) =>
    update((s) => {
      if (mode === 'follow') return followPoint(s, 'position', fp.id)
      const ref = locate(s, fp.id)
      if (!ref) return s
      return setFixPosFree(removeConstraintOn(s, 'position', fp.id), ref.curve, ref.point, mode === 'any')
    })

  const setDirection = (fp: FixPoint, mode: Mode) =>
    update((s) => {
      if (mode === 'follow') return followPoint(s, 'orientation', fp.id)
      const ref = locate(s, fp.id)
      if (!ref) return s
      const cleared = removeConstraintOn(s, 'orientation', fp.id)
      // A new fixed direction runs left to right.
      return setFixOrientation(cleared, ref.curve, ref.point, mode === 'fixed' ? (fp.orientation ?? degreesToVector(0)) : null)
    })

  return (
    <div className="wiz-stack">
      <section className="wiz-card wiz-card--preview" aria-label="Drawing area">
        <PoseEditor
          draw
          setup={setup}
          edit={update}
          onUndo={api.undo}
          onRedo={api.redo}
          canUndo={api.canUndo}
          canRedo={api.canRedo}
          activeCurve={active}
          onActiveCurve={setActiveCurve}
          selectedPoint={selected?.id ?? null}
          onSelectPoint={onSelect}
        />
      </section>

      {setup.curves.map((curve, ci) => {
        const key = curveKey(ci)
        const open = !collapsed.has(key)
        const links = (setup.constraints ?? []).filter((c) => curve.fixPoints.some((fp) => fp.id === c.target)).length
        return (
          <section key={key} className={`wiz-card ${ci === active ? 'is-active' : ''}`} aria-label={`Curve ${ci + 1}`}>
            <header className="wiz-card__head">
              <button
                type="button"
                className="wiz-toggle"
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} curve ${ci + 1}`}
                onClick={() => toggle(key)}
              >
                <span aria-hidden="true" className="wiz-toggle__icon">
                  {open ? '▾' : '▸'}
                </span>
                <h3>Curve {ci + 1}</h3>
                <span className="wiz-muted">
                  {curve.fixPoints.length} points{links > 0 ? ` · ${links} following` : ''}
                </span>
              </button>
              <div className="wiz-row">
                {ci !== active ? (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setActiveCurve(ci)}>
                    Highlight
                  </button>
                ) : null}
                {setup.curves.length > 1 ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--danger"
                    onClick={() => update((s) => removeCurve(s, ci))}
                  >
                    Remove curve
                  </button>
                ) : null}
              </div>
            </header>

            {open ? (
              <>
                <ol className="wiz-points">
                  {curve.fixPoints.map((fp, pi) => {
                    const posRule = constraintFor(setup, 'position', fp.id)
                    const dirRule = constraintFor(setup, 'orientation', fp.id)
                    const role = pointRole(pi, curve.fixPoints.length)
                    const posMode: Mode = posRule ? 'follow' : fp.posFree ? 'any' : 'fixed'
                    const dirMode: Mode = dirRule ? 'follow' : fp.orientation ? 'fixed' : 'any'
                    return (
                      <li
                        key={fp.id}
                        id={`point-${fp.id}`}
                        className={`wiz-point ${selected?.id === fp.id ? 'is-selected' : ''}`}
                      >
                        <div className="wiz-point__head">
                          <strong>
                            Point {pi + 1} <span className="wiz-muted">({role})</span>
                          </strong>
                          {curve.fixPoints.length > 2 ? (
                            <button
                              type="button"
                              className="btn btn--sm btn--ghost btn--danger"
                              aria-label={`Remove point ${pi + 1} of curve ${ci + 1}`}
                              onClick={() => update((s) => removeFixPoint(s, ci, pi))}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
                        <p className="wiz-state">
                          <span className="wiz-state__tag">Now</span>
                          {describePoint(setup, fp)}
                        </p>

                        <div className="wiz-editor">
                          <div className="wiz-field">
                            <span className="wiz-field__label">Position</span>
                            <Choice
                              label={`Position of point ${pi + 1}`}
                              value={posMode}
                              options={[
                                { value: 'fixed', text: 'Fix position' },
                                { value: 'any', text: 'Any position' },
                                { value: 'follow', text: 'Follow a point' },
                              ]}
                              onChange={(m) => setPosition(fp, m)}
                            />
                            {posRule ? (
                              <FollowEditor setup={setup} api={api} constraint={posRule} label={`Position of point ${pi + 1}`} />
                            ) : (
                              <div className="wiz-grid2">
                                <NumberField
                                  label={fp.posFree ? 'Start X' : 'X'}
                                  value={fp.pos[0]}
                                  step={0.5}
                                  onChange={(v) => update((s) => moveFix(s, ci, pi, 0, v))}
                                />
                                <NumberField
                                  label={fp.posFree ? 'Start Y' : 'Y'}
                                  value={fp.pos[1]}
                                  step={0.5}
                                  onChange={(v) => update((s) => moveFix(s, ci, pi, 1, v))}
                                />
                              </div>
                            )}
                          </div>

                          <div className="wiz-field">
                            <span className="wiz-field__label">Direction</span>
                            <Choice
                              label={`Direction of point ${pi + 1}`}
                              value={dirMode}
                              options={[
                                { value: 'fixed', text: 'Fix direction' },
                                { value: 'any', text: 'Any direction' },
                                { value: 'follow', text: 'Follow a point' },
                              ]}
                              onChange={(m) => setDirection(fp, m)}
                            />
                            {dirRule ? (
                              <FollowEditor setup={setup} api={api} constraint={dirRule} label={`Direction of point ${pi + 1}`} />
                            ) : fp.orientation ? (
                              <NumberField
                                label="Angle (degrees)"
                                hint="0° = right, 90° = up"
                                value={vectorToDegrees(fp.orientation)}
                                step={15}
                                onChange={(v) => update((s) => setFixOrientation(s, ci, pi, degreesToVector(v)))}
                              />
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>

                <button type="button" className="btn btn--sm" onClick={() => update((s) => addFixPoint(s, ci))}>
                  + Add a point to curve {ci + 1}
                </button>
              </>
            ) : null}
          </section>
        )
      })}

      <button
        type="button"
        className="btn btn--block"
        onClick={() => {
          const created = setup.curves.length
          // Fold the other curves away so the new one is the one being edited.
          setCollapsed(new Set(setup.curves.map((_, i) => curveKey(i))))
          update(addCurve)
          setActiveCurve(created)
        }}
      >
        + Add another curve
      </button>
    </div>
  )
}
