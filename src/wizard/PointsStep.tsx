import { useMemo, useState } from 'react'
import { constraintFor, locate } from '../solver/constraints'
import { DEFAULT_FLATNESS, type Constraint, type FixPoint, type PointId, type Setup, type Vec2 } from '../solver/types'
import { previewLayout } from '../solver/solve'
import { NumberField } from '../ui/NumberField'
import {
  addCurve,
  addFixPoint,
  isCurveClosed,
  setCurveClosed,
  followPoint,
  setFollowSource,
  moveFix,
  removeConstraintOn,
  removeCurve,
  removeFixPoint,
  setConstraintDelta,
  setOrientationMapping,
  setCurveFlatness,
  setCurveTargetLength,
  setFixOrientation,
  setFixPosFree,
} from '../ui/setupEdits'
import { DEFAULT_NGON, addNgon, ngonProblem, type NgonParams } from '../ui/presets'
import { degreesToVector, formatDirectionExpr, parseDirectionExpr, vectorToDegrees } from './orientation'
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

/** The single place where the point to follow is chosen; position and direction both use it. */
function FollowSource({
  setup,
  api,
  target,
  value,
  onPick,
}: {
  setup: Setup
  api: SetupApi
  target: PointId
  value: PointId
  onPick: (source: PointId | null) => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const onChange = (picked: string) => {
    const next = setFollowSource(setup, target, picked || null)
    if (next === setup && picked !== value && (setup.constraints ?? []).some((c) => c.target === target)) {
      setProblem('That would make the points follow each other in a loop.')
      return
    }
    setProblem(null)
    onPick(picked || null)
    if (next !== setup) api.update(() => next)
  }
  return (
    <div className="wiz-field">
      <label className="wiz-select">
        <span className="wiz-field__label">Follows</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">No point</option>
          {setup.curves.flatMap((c, ci) =>
            c.fixPoints.flatMap((fp, pi) =>
              fp.id === target
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
      {problem ? (
        <p className="wiz-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  )
}

const DIRECTION_PRESETS = ['x', 'x + 90', 'x - 90', '-x', 'x + 180']

/** Direction rule as a formula in x, the followed direction (angles in degrees). */
function DirectionFormula({ api, constraint }: { api: SetupApi; constraint: Constraint }) {
  const canonical = formatDirectionExpr({
    mirror: constraint.kind === 'orientation' && constraint.mirror === true,
    delta: constraint.kind === 'orientation' ? (constraint.delta ?? 0) : 0,
  })
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? canonical
  const parsed = draft === null ? null : parseDirectionExpr(draft)
  const apply = (mapping: { mirror: boolean; delta: number }) =>
    api.update((s) => setOrientationMapping(s, constraint.target, mapping))
  return (
    <div className="wiz-follow">
      <label className="wiz-select">
        <span className="wiz-field__label">Direction =</span>
        <input
          type="text"
          value={text}
          aria-label="Direction formula"
          aria-invalid={draft !== null && parsed === null}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            const m = parseDirectionExpr(e.target.value)
            if (m) apply(m)
          }}
          onBlur={() => setDraft(null)}
        />
      </label>
      <p className={draft !== null && parsed === null ? 'wiz-problem' : 'wiz-note'}>
        {draft !== null && parsed === null
          ? 'Use x for the followed direction, e.g. x + 90, -x or 90 - x.'
          : 'x is the direction being followed, in degrees. Examples: x, x + 90, -x, 90 - x.'}
      </p>
      <div className="wiz-row">
        {DIRECTION_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="btn btn--sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setDraft(null)
              apply(parseDirectionExpr(preset)!)
            }}
          >
            {preset}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Position offset of a "follow another point" constraint. */
function FollowOffset({ api, constraint }: { api: SetupApi; constraint: Constraint }) {
  const { update } = api
  if (constraint.kind !== 'position') return null
  return (
    <div className="wiz-follow">
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
    </div>
  )
}

export function PointsStep({ api }: { api: SetupApi }) {
  const { setup, update } = api
  const layout = useMemo(() => previewLayout(setup), [setup])
  // Curves are collapsed by the id of their first point, which stays stable while editing.
  const [collapsed, setCollapsed] = useState<Set<PointId>>(new Set())
  // Sources picked in the "Follows" menu before position or direction follows them.
  const [picked, setPicked] = useState<Record<PointId, PointId>>({})
  const sourceOf = (id: PointId): PointId | null => {
    const source = setup.constraints?.find((c) => c.target === id)?.source ?? picked[id]
    return source && source !== id && locate(setup, source) ? source : null
  }

  const curveKey = (ci: number) => setup.curves[ci].fixPoints[0].id
  const toggle = (key: PointId) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // Remember the source so it stays selected once no property follows it any more.
  const keepSource = (fp: FixPoint) => {
    const source = sourceOf(fp.id)
    if (source) setPicked((prev) => ({ ...prev, [fp.id]: source }))
  }

  const setPosition = (fp: FixPoint, mode: Mode) => {
    keepSource(fp)
    update((s) => {
      if (mode === 'follow') return followPoint(s, 'position', fp.id, sourceOf(fp.id))
      const ref = locate(s, fp.id)
      if (!ref) return s
      return setFixPosFree(removeConstraintOn(s, 'position', fp.id), ref.curve, ref.point, mode === 'any')
    })
  }

  const setDirection = (fp: FixPoint, mode: Mode) => {
    keepSource(fp)
    update((s) => {
      if (mode === 'follow') return followPoint(s, 'orientation', fp.id, sourceOf(fp.id))
      const ref = locate(s, fp.id)
      if (!ref) return s
      const cleared = removeConstraintOn(s, 'orientation', fp.id)
      // A new fixed direction runs left to right.
      return setFixOrientation(cleared, ref.curve, ref.point, mode === 'fixed' ? (fp.orientation ?? degreesToVector(0)) : null)
    })
  }

  
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
                <label className="wiz-muted">
                  <input
                    type="checkbox"
                    checked={isCurveClosed(setup, ci)}
                    onChange={(e) => update((s) => setCurveClosed(s, ci, e.target.checked))}
                  />{' '}
                  Closed
                </label>
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
                    const canFollow = setup.curves.some((c) => c.fixPoints.some((candidate) => candidate.id !== fp.id))
                    const source = sourceOf(fp.id)
                    const hasSource = source !== null
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
                          {canFollow ? (
                            <FollowSource
                              setup={setup}
                              api={api}
                              target={fp.id}
                              value={source ?? ''}
                              onPick={(id) =>
                                setPicked((prev) => {
                                  const next = { ...prev }
                                  if (id) next[fp.id] = id
                                  else delete next[fp.id]
                                  return next
                                })
                              }
                            />
                          ) : null}
                          <div className="wiz-field">
                            <span className="wiz-field__label">Position</span>
                            <Choice
                              label={`Position of point ${pi + 1}`}
                              value={posMode}
                              options={modeOptions('position', hasSource)}
                              onChange={(m) => setPosition(fp, m)}
                            />
                            {posRule ? (
                              <FollowOffset api={api} constraint={posRule} />
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
                              options={modeOptions('direction', hasSource)}
                              onChange={(m) => setDirection(fp, m)}
                            />
                            {dirRule ? (
                              <DirectionFormula api={api} constraint={dirRule} />
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

      <NgonPreset onAdd={(params) => update((st) => addNgon(st, params))} />
    </div>
  )
}

function NgonPreset({ onAdd }: { onAdd: (params: NgonParams) => void }) {
  const [params, setParams] = useState<NgonParams>(DEFAULT_NGON)
  const problem = ngonProblem(params)
  return (
    <section className="curve-card">
      <h3>Preset: n-gon</h3>
      <NumberField label="n (sides)" value={params.n} integer min={3} onChange={(n) => setParams({ ...params, n })} />
      <NumberField
        label="Origin x"
        value={params.origin[0]}
        onChange={(x) => setParams({ ...params, origin: [x, params.origin[1]] })}
      />
      <NumberField
        label="Origin y"
        value={params.origin[1]}
        onChange={(y) => setParams({ ...params, origin: [params.origin[0], y] })}
      />
      <NumberField label="Radius" value={params.radius} min={0} onChange={(radius) => setParams({ ...params, radius })} />
      {problem ? <p className="hint">{problem}</p> : null}
      <button type="button" className="btn btn--block" disabled={problem !== null} onClick={() => onAdd(params)}>
        + Add n-gon
      </button>
    </section>
  )
}
