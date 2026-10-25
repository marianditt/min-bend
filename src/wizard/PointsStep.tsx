import { useMemo, useState } from 'react'
import { constraintFor, locate } from '../solver/constraints'
import { DEFAULT_FLATNESS, type Constraint, type FixPoint, type PointId, type Setup, type Vec2 } from '../solver/types'
import { previewLayout } from '../solver/solve'
import { NumberField } from '../ui/NumberField'
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
  setCurveFlatness,
  setCurveTargetLength,
  setFixOrientation,
  setFixPosFree,
} from '../ui/setupEdits'
import { degreesToVector, vectorToDegrees } from './orientation'
import type { SetupApi } from './types'

function pointRole(index: number, count: number): string {
  if (index === 0) return 'start'
  if (index === count - 1) return 'end'
  return 'via'
}

function polylineLength(pts: [number, number][]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return total
}

type Mode = 'fixed' | 'any' | 'follow'

function modeOptions(noun: string, canFollow: boolean): { value: Mode; text: string }[] {
  const all: { value: Mode; text: string }[] = [
    { value: 'fixed', text: `Fix ${noun}` },
    { value: 'any', text: `Any ${noun}` },
    { value: 'follow', text: 'Follow a point' },
  ]
  return canFollow ? all : all.slice(0, 2)
}

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
  const own = locate(setup, constraint.target)?.curve
  // A point follows one point only: its other property already decided which.
  const decided = setup.constraints?.find((c) => c.target === constraint.target && c.kind !== constraint.kind)?.source
  return (
    <div className="wiz-follow">
      <div className="wiz-chips" role="group" aria-label={`${label}: follow which point`}>
        {setup.curves.flatMap((c, ci) =>
          ci === own
            ? []
            : c.fixPoints.flatMap((fp, pi) =>
                decided && fp.id !== decided
                  ? []
                  : [
                      <button
                        key={fp.id}
                        type="button"
                        className="wiz-chip"
                        aria-pressed={fp.id === constraint.source}
                        title={`Curve ${ci + 1} · Point ${pi + 1}`}
                        onClick={() => onSource(fp.id)}
                      >
                        {ci + 1}.{pi + 1}
                      </button>,
                    ],
              ),
        )}
      </div>
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

export function PointsStep({ api }: { api: SetupApi }) {
  const { setup, update } = api
  const layout = useMemo(() => previewLayout(setup), [setup])
  // Curves are collapsed by the id of their first point, which stays stable while editing.
  const [collapsed, setCollapsed] = useState<Set<PointId>>(new Set())

  const curveKey = (ci: number) => setup.curves[ci].fixPoints[0].id
  const toggle = (key: PointId) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

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

  const canFollow = setup.curves.length > 1

  return (
    <div className="wiz-stack">
      {setup.curves.map((curve, ci) => {
        const key = curveKey(ci)
        const open = !collapsed.has(key)
        const links = (setup.constraints ?? []).filter((c) => curve.fixPoints.some((fp) => fp.id === c.target)).length
        const fixed = typeof curve.targetLength === 'number'
        return (
          <section key={key} className="wiz-card" aria-label={`Curve ${ci + 1}`}>
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
                <button
                  type="button"
                  className="btn btn--sm btn--ghost btn--danger"
                  onClick={() => update((s) => removeCurve(s, ci))}
                >
                  {setup.curves.length > 1 ? 'Remove curve' : 'Reset curve'}
                </button>
              </div>
            </header>

            {open ? (
              <>
                <div className="wiz-point">
                  <div className="wiz-field">
                    <span className="wiz-field__label">Length</span>
                    <Choice
                      label={`Length of curve ${ci + 1}`}
                      value={fixed ? 'fixed' : 'any'}
                      options={[
                        { value: 'any', text: 'Free' },
                        { value: 'fixed', text: 'Fixed length' },
                      ]}
                      onChange={(m) =>
                        update((st) =>
                          setCurveTargetLength(
                            st,
                            ci,
                            m === 'any' ? null : Math.max(1, Math.round(polylineLength(layout.curves[ci] ?? []) * 10) / 10),
                          ),
                        )
                      }
                    />
                    {fixed ? (
                      <NumberField
                        label="Length"
                        value={curve.targetLength as number}
                        step={1}
                        min={0}
                        onChange={(v) => update((st) => setCurveTargetLength(st, ci, v))}
                      />
                    ) : (
                      <label className="wiz-slider">
                        <span className="wiz-slider__ends">
                          <span>Short</span>
                          <span>Flat</span>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={curve.flatness ?? DEFAULT_FLATNESS}
                          aria-label={`Prefer short or flat for curve ${ci + 1}`}
                          onChange={(e) => update((st) => setCurveFlatness(st, ci, Number(e.target.value)), { history: false })}
                        />
                      </label>
                    )}
                  </div>
                </div>

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
                        className="wiz-point"
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
                        <div className="wiz-editor">
                          <div className="wiz-field">
                            <span className="wiz-field__label">Position</span>
                            <Choice
                              label={`Position of point ${pi + 1}`}
                              value={posMode}
                              options={modeOptions('position', canFollow)}
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
                              options={modeOptions('direction', canFollow)}
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
          // Fold the other curves away so the new one is the one being edited.
          setCollapsed(new Set(setup.curves.map((_, i) => curveKey(i))))
          update(addCurve)
        }}
      >
        + Add another curve
      </button>
    </div>
  )
}
