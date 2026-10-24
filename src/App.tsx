import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSolver } from './hooks/useSolver'
import { useSetupState } from './hooks/useSetupState'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { PointsStep } from './wizard/PointsStep'
import { RulesStep } from './wizard/RulesStep'
import { SketchStep } from './wizard/SketchStep'
import { RunStep } from './wizard/RunStep'
import { ResultStep } from './wizard/ResultStep'
import { STEPS, type PointSelection, type StepId } from './wizard/types'
import type { PointId, Setup } from './solver/types'
import './wizard/wizard.css'

/** Setup identity for staleness checks; visibility is display-only. */
function fingerprint(setup: Setup, constants: unknown): string {
  return JSON.stringify([
    setup.curves.map((c) => ({ ...c, hidden: undefined })),
    setup.constraints,
    setup.resolution,
    constants,
  ])
}

function App() {
  const { compute, cancel, state } = useSolver()
  const api = useSetupState()
  const [stepId, setStepId] = useState<StepId>('points')
  const [playerKey, setPlayerKey] = useState(0)
  const [ranWith, setRanWith] = useState<string | null>(null)
  const [selected, setSelected] = useState<PointSelection | null>(null)
  const topRef = useRef<HTMLElement>(null)

  const stepIndex = STEPS.findIndex((s) => s.id === stepId)
  const step = STEPS[stepIndex]
  const running = state.status === 'running'
  const result = state.status === 'done' ? state.result : null
  const stale = ranWith !== null && ranWith !== fingerprint(api.setup, api.constants)

  const run = useCallback(() => {
    setPlayerKey((k) => k + 1)
    setRanWith(fingerprint(api.setup, api.constants))
    setStepId('run')
    compute(api.setup, api.constants)
  }, [api.setup, api.constants, compute])

  // Show the result as soon as a run finishes.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && state.status === 'done') setStepId('result')
    wasRunning.current = running
  }, [running, state.status])

  useEffect(() => {
    topRef.current?.scrollTo?.({ top: 0 })
  }, [stepId])

  const go = useCallback(
    (id: StepId) => {
      if (running) return
      if (id === 'result' && !result) return
      setStepId(id)
    },
    [running, result],
  )

  const selectPoint = useCallback((id: PointId) => setSelected((prev) => ({ id, n: (prev?.n ?? 0) + 1 })), [])
  const editPoint = useCallback(
    (id: PointId) => {
      selectPoint(id)
      setStepId('points')
    },
    [selectPoint],
  )

  const next = STEPS[stepIndex + 1]
  const prev = STEPS[stepIndex - 1]
  const canNext = !!next && !running && (next.id !== 'result' || !!result)
  const nextLabel = next?.id === 'run' ? 'Review & solve' : next?.id === 'result' ? 'View result' : `Next: ${next?.label}`

  const body = useMemo(() => {
    switch (stepId) {
      case 'points':
        return <PointsStep api={api} selected={selected} onSelect={selectPoint} />
      case 'rules':
        return <RulesStep api={api} onEditPoint={editPoint} />
      case 'sketch':
        return <SketchStep api={api} />
      case 'run':
        return <RunStep api={api} solver={state} onRun={run} onCancel={cancel} onGoto={go} />
      case 'result':
        return result ? (
          <ResultStep
            api={api}
            result={result}
            playerKey={playerKey}
            stale={stale}
            onRerun={run}
            onEdit={() => setStepId('points')}
          />
        ) : (
          <p className="wiz-note">No result yet. Solve first.</p>
        )
    }
  }, [stepId, api, state, run, cancel, go, result, playerKey, stale, selected, selectPoint, editPoint])

  return (
    <div className="wiz">
      <header className="wiz__header">
        <h1 className="wiz__title">Minimum-Bend Curves</h1>
        <nav aria-label="Steps">
          <ol className="wiz-steps">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`wiz-steps__btn ${s.id === stepId ? 'is-current' : ''} ${i < stepIndex ? 'is-past' : ''}`}
                  aria-current={s.id === stepId ? 'step' : undefined}
                  disabled={running || (s.id === 'result' && !result)}
                  onClick={() => go(s.id)}
                >
                  <span className="wiz-steps__num">{i + 1}</span>
                  <span className="wiz-steps__label">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      <main className="wiz__main" ref={topRef}>
        <div className="wiz__intro">
          <p className="wiz__count">Step {stepIndex + 1} of {STEPS.length}</p>
          <h2>{step.title}</h2>
          <p className="wiz-note">{step.help}</p>
        </div>
        <ErrorBoundary key={stepId} onReset={api.reset}>
          {body}
        </ErrorBoundary>
      </main>

      <footer className="wiz__footer">
        <button type="button" className="btn" disabled={!prev || running} onClick={() => prev && go(prev.id)}>
          ← Back
        </button>
        {next ? (
          <button type="button" className="btn btn--primary" disabled={!canNext} onClick={() => go(next.id)}>
            {nextLabel} →
          </button>
        ) : null}
      </footer>
    </div>
  )
}

export default App
