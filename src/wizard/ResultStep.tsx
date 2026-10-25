import { useMemo } from 'react'
import type { FrameSet, Setup } from '../solver/types'
import { Player } from '../player/Player'
import { toggleCurveHidden } from '../ui/setupEdits'
import type { SetupApi } from './types'

interface ResultStepProps {
  api: SetupApi
  result: FrameSet
  playerKey: number
  stale: boolean
  onRerun: () => void
  onEdit: () => void
}

export function ResultStep({ api, result, playerKey, stale, onRerun, onEdit }: ResultStepProps) {
  const hidden = useMemo(() => api.setup.curves.map((c) => !!c.hidden), [api.setup])
  const iterations = result.meta.iterations ?? result.frames.length
  const settled = result.meta.termination === 'rest'
  const first = result.frames[0]
  const last = result.frames.at(-1)
  const count = (pts: unknown[][] | undefined) => (pts ? pts.reduce((n, c) => n + c.length, 0) : 0)

  return (
    <div className="wiz-stack wiz-stack--result">
      {stale ? (
        <div className="wiz-card wiz-card--problem" role="status">
          <p>You changed the setup after this result was computed.</p>
          <div className="wiz-row">
            <button type="button" className="btn btn--primary btn--sm" onClick={onRerun}>
              Solve again
            </button>
          </div>
        </div>
      ) : null}
      <p className={`wiz-banner ${settled ? 'is-ok' : 'is-warn'}`}>
        {settled
          ? `Done. The curves settled after ${iterations.toLocaleString()} steps.`
          : `Stopped at the step limit (${iterations.toLocaleString()} steps) before fully settling. It may still be improving.`}
        {first && last ? ` Points: ${count(first.curves)} → ${count(last.curves)}.` : ''}
      </p>
      <Player
        key={playerKey}
        frameSet={result}
        hidden={hidden}
        onToggleHidden={(ci) => api.update((s: Setup) => toggleCurveHidden(s, ci))}
      />
      <div className="wiz-row">
        <button type="button" className="btn" onClick={onEdit}>
          ← Edit setup
        </button>
        <button type="button" className="btn" onClick={onRerun}>
          Solve again
        </button>
      </div>
    </div>
  )
}
