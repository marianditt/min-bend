import { useMemo } from 'react'
import type { Constraint, PointId, Setup } from '../solver/types'
import { locate, pointLabel } from '../solver/constraints'
import { previewLayout } from '../solver/solve'
import { NumberField } from '../ui/NumberField'
import { removeConstraint, setCurveTargetLength } from '../ui/setupEdits'
import type { SetupApi } from './types'

function polylineLength(pts: [number, number][]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return total
}

function describeConstraint(setup: Setup, c: Constraint): string {
  const what = c.kind === 'position' ? 'position' : 'direction'
  const delta =
    c.kind === 'orientation'
      ? c.delta ? ` turned by ${c.delta}°` : ''
      : c.delta && (c.delta[0] !== 0 || c.delta[1] !== 0) ? ` shifted by (${c.delta[0]}, ${c.delta[1]})` : ''
  return `${pointLabel(setup, c.target)} follows the ${what} of ${pointLabel(setup, c.source)}${delta}`
}

export function RulesStep({ api, onEditPoint }: { api: SetupApi; onEditPoint: (id: PointId) => void }) {
  const { setup, update } = api
  const layout = useMemo(() => previewLayout(setup), [setup])

  return (
    <div className="wiz-stack">
      <section className="wiz-card">
        <header className="wiz-card__head">
          <h3>Length of each curve</h3>
        </header>
        <p className="wiz-note">
          By default a curve can become any length. A curve that must return to where it started needs a fixed length,
          otherwise it keeps growing to get smoother.
        </p>
        {setup.curves.map((curve, ci) => {
          const fixed = typeof curve.targetLength === 'number'
          const current = polylineLength(layout.curves[ci] ?? [])
          return (
            <div key={ci} className="wiz-point">
              <div className="wiz-point__head">
                <strong>Curve {ci + 1}</strong>
              </div>
              <div className="wiz-choice" role="group" aria-label={`Length of curve ${ci + 1}`}>
                <button
                  type="button"
                  className={`wiz-choice__btn ${!fixed ? 'is-active' : ''}`}
                  aria-pressed={!fixed}
                  onClick={() => update((s) => setCurveTargetLength(s, ci, null))}
                >
                  Free
                </button>
                <button
                  type="button"
                  className={`wiz-choice__btn ${fixed ? 'is-active' : ''}`}
                  aria-pressed={fixed}
                  onClick={() => update((s) => setCurveTargetLength(s, ci, Math.max(1, Math.round(current * 10) / 10)))}
                >
                  Fixed length
                </button>
              </div>
              {fixed ? (
                <NumberField
                  label="Length"
                  value={curve.targetLength as number}
                  step={1}
                  min={0}
                  onChange={(v) => update((s) => setCurveTargetLength(s, ci, v))}
                />
              ) : null}
            </div>
          )
        })}
      </section>

      <section className="wiz-card">
        <header className="wiz-card__head">
          <h3>Points that follow others</h3>
        </header>
        <p className="wiz-note">
          To make a point follow another one, open it and choose “Follow a point” for its position or direction.
        </p>
        {(setup.constraints ?? []).length === 0 ? <p className="wiz-muted">No point follows another yet.</p> : null}
        <ul className="wiz-list">
          {(setup.constraints ?? []).map((c, i) => (
            <li key={`${c.kind}:${c.target}`} className="wiz-list__item">
              <span>{describeConstraint(setup, c)}</span>
              <span className="wiz-row">
                {locate(setup, c.target) ? (
                  <button type="button" className="btn btn--sm" onClick={() => onEditPoint(c.target)}>
                    Edit point
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn--sm btn--ghost btn--danger"
                  aria-label={`Remove: ${describeConstraint(setup, c)}`}
                  onClick={() => update((s) => removeConstraint(s, i))}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
