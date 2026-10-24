import { useMemo, useState } from 'react'
import type { Constraint, Setup } from '../solver/types'
import { previewLayout } from '../solver/solve'
import { NumberField } from '../ui/NumberField'
import { addConstraint, removeConstraint, setCurveTargetLength } from '../ui/setupEdits'
import type { SetupApi } from './types'

function polylineLength(pts: [number, number][]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return total
}

function pointLabel(ci: number, pi: number): string {
  return `Curve ${ci + 1} · Point ${pi + 1}`
}

function describeConstraint(c: Constraint): string {
  const what = c.kind === 'position' ? 'position' : 'direction'
  return `${pointLabel(c.target.curve, c.target.point)} copies the ${what} of ${pointLabel(c.source.curve, c.source.point)}`
}

function PointSelect({
  label,
  setup,
  value,
  onChange,
}: {
  label: string
  setup: Setup
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="wiz-select">
      <span className="wiz-field__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {setup.curves.flatMap((c, ci) =>
          c.fixPoints.map((_, pi) => (
            <option key={`${ci}:${pi}`} value={`${ci}:${pi}`}>
              {pointLabel(ci, pi)}
            </option>
          )),
        )}
      </select>
    </label>
  )
}

function parseRef(v: string) {
  const [curve, point] = v.split(':').map(Number)
  return { curve, point }
}

export function RulesStep({ api }: { api: SetupApi }) {
  const { setup, update } = api
  const layout = useMemo(() => previewLayout(setup), [setup])
  const [kind, setKind] = useState<Constraint['kind']>('position')
  const [target, setTarget] = useState('0:0')
  const [source, setSource] = useState('0:1')
  const [message, setMessage] = useState<string | null>(null)

  const addLink = () => {
    const next = addConstraint(setup, { kind, target: parseRef(target), source: parseRef(source) })
    if (next === setup) {
      setMessage('That link is not possible (a point cannot copy itself, and links cannot form a loop).')
      return
    }
    setMessage(null)
    update(() => next)
  }

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
          <h3>Links between points</h3>
        </header>
        <p className="wiz-note">Make a point copy another point’s position (to join curves) or direction (to continue smoothly).</p>
        {(setup.constraints ?? []).length === 0 ? <p className="wiz-muted">No links yet.</p> : null}
        <ul className="wiz-list">
          {(setup.constraints ?? []).map((c, i) => (
            <li key={i} className="wiz-list__item">
              <span>{describeConstraint(c)}</span>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--danger"
                aria-label={`Remove link: ${describeConstraint(c)}`}
                onClick={() => update((s) => removeConstraint(s, i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="wiz-form">
          <PointSelect label="This point" setup={setup} value={target} onChange={setTarget} />
          <label className="wiz-select">
            <span className="wiz-field__label">copies the</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Constraint['kind'])}>
              <option value="position">position</option>
              <option value="orientation">direction</option>
            </select>
          </label>
          <PointSelect label="of this point" setup={setup} value={source} onChange={setSource} />
          <button type="button" className="btn btn--primary" onClick={addLink}>
            Add link
          </button>
        </div>
        {message ? (
          <p className="wiz-problem" role="alert">
            {message}
          </p>
        ) : null}
      </section>
    </div>
  )
}
