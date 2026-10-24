import { useState } from 'react'
import type { Setup } from '../solver/types'
import { NumberField } from '../ui/NumberField'
import { PoseEditor } from '../ui/PoseEditor'
import {
  addCurve,
  addFixPoint,
  moveFix,
  removeCurve,
  removeFixPoint,
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

function describePoint(setup: Setup, ci: number, pi: number): string {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp) return ''
  const pos = fp.posFree
    ? `Moves freely (starts near ${fp.pos[0]}, ${fp.pos[1]})`
    : `Stays at (${fp.pos[0]}, ${fp.pos[1]})`
  const dir = fp.orientation ? `heading ${vectorToDegrees(fp.orientation)}°` : 'any direction'
  return `${pos} · ${dir}`
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { value: T; text: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="wiz-choice" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`wiz-choice__btn ${o.value === value ? 'is-active' : ''}`}
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </button>
      ))}
    </div>
  )
}

export function PointsStep({ api }: { api: SetupApi }) {
  const { setup, update } = api
  const [activeCurve, setActiveCurve] = useState(0)
  const active = Math.min(activeCurve, setup.curves.length - 1)

  const linked = (ci: number, pi: number, kind: 'position' | 'orientation') =>
    (setup.constraints ?? []).some((c) => c.kind === kind && c.target.curve === ci && c.target.point === pi)

  return (
    <div className="wiz-stack">
      <section className="wiz-card wiz-card--preview" aria-label="Preview">
        <PoseEditor
          setup={setup}
          edit={update}
          onUndo={api.undo}
          onRedo={api.redo}
          canUndo={api.canUndo}
          canRedo={api.canRedo}
          activeCurve={active}
          onActiveCurve={setActiveCurve}
        />
      </section>

      {setup.curves.map((curve, ci) => (
        <section key={ci} className={`wiz-card ${ci === active ? 'is-active' : ''}`} aria-label={`Curve ${ci + 1}`}>
          <header className="wiz-card__head">
            <h3>Curve {ci + 1}</h3>
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

          <ol className="wiz-points">
            {curve.fixPoints.map((fp, pi) => {
              const posLinked = linked(ci, pi, 'position')
              const dirLinked = linked(ci, pi, 'orientation')
              const role = pointRole(pi, curve.fixPoints.length)
              return (
                <li key={pi} className="wiz-point">
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
                  <p className="wiz-point__summary">{describePoint(setup, ci, pi)}</p>

                  <div className="wiz-field">
                    <span className="wiz-field__label">Position</span>
                    {posLinked ? (
                      <p className="wiz-note">Copied from another point (see Rules).</p>
                    ) : (
                      <>
                        <Choice
                          label={`Position of point ${pi + 1}`}
                          value={fp.posFree ? 'free' : 'fixed'}
                          options={[
                            { value: 'fixed', text: 'Stay here' },
                            { value: 'free', text: 'May move' },
                          ]}
                          onChange={(v) => update((s) => setFixPosFree(s, ci, pi, v === 'free'))}
                        />
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
                      </>
                    )}
                  </div>

                  <div className="wiz-field">
                    <span className="wiz-field__label">Direction</span>
                    {dirLinked ? (
                      <p className="wiz-note">Copied from another point (see Rules).</p>
                    ) : (
                      <>
                        <Choice
                          label={`Direction of point ${pi + 1}`}
                          value={fp.orientation ? 'set' : 'any'}
                          options={[
                            { value: 'any', text: 'Any direction' },
                            { value: 'set', text: 'Set angle' },
                          ]}
                          onChange={(v) =>
                            update((s) => setFixOrientation(s, ci, pi, v === 'set' ? degreesToVector(90) : null))
                          }
                        />
                        {fp.orientation ? (
                          <NumberField
                            label="Angle (degrees)"
                            hint="0° = right, 90° = up"
                            value={vectorToDegrees(fp.orientation)}
                            step={15}
                            onChange={(v) => update((s) => setFixOrientation(s, ci, pi, degreesToVector(v)))}
                          />
                        ) : null}
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>

          <button type="button" className="btn btn--sm" onClick={() => update((s) => addFixPoint(s, ci))}>
            + Add a point to curve {ci + 1}
          </button>
        </section>
      ))}

      <button
        type="button"
        className="btn btn--block"
        onClick={() => {
          update(addCurve)
          setActiveCurve(setup.curves.length)
        }}
      >
        + Add another curve
      </button>
    </div>
  )
}
