import { useCallback, useState } from 'react'
import { useSolver } from './hooks/useSolver'
import { useSetupState } from './hooks/useSetupState'
import { Player } from './player/Player'
import { Sidebar } from './ui/Sidebar'
import { PoseEditor } from './ui/PoseEditor'
import type { PhysicsConstants, ProblemInput } from './solver/types'

function formatEnergy(ke: number): string {
  if (!Number.isFinite(ke)) return '—'
  if (ke === 0) return '0'
  const abs = Math.abs(ke)
  if (abs >= 0.01 && abs < 1e4) return ke.toFixed(3)
  return ke.toExponential(2)
}

function MarkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 19c3-11 7-11 9-4s6 7 9-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="1.5" y="17.5" width="4" height="4" rx="1" fill="currentColor" />
      <rect x="19" y="15" width="4" height="4" rx="1" fill="currentColor" />
    </svg>
  )
}

function ProgressRing({
  fraction,
  iteration,
}: {
  fraction: number
  iteration: number
}) {
  const size = 168
  const stroke = 10
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, fraction))
  const percent = Math.round(clamped * 100)
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg
        className="ring"
        width={size}
        height={size}
        role="img"
        aria-label={`Solving, ${percent} percent complete`}
      >
        <circle
          className="ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="ring__value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <div className="ring__label">
        <span className="ring__percent">{percent}%</span>
        <span className="ring__meta">{iteration.toLocaleString()} steps</span>
      </div>
    </div>
  )
}

function App() {
  const { compute, cancel, state } = useSolver()
  const { status, progress, iteration, ke, result, error } = state
  const [playerKey, setPlayerKey] = useState(0)
  const setup = useSetupState()

  const handleCompute = useCallback(
    (input: ProblemInput, constants: PhysicsConstants) => {
      compute(input, constants)
      setPlayerKey((key) => key + 1)
    },
    [compute],
  )

  const resultIterations = result
    ? (result.meta.iterations ?? result.frames.length)
    : null
  const termination = result ? result.meta.termination : null

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__mark">
          <MarkIcon />
        </span>
        <h1 className="app__title">Minimum-Bend Elastic Chain</h1>
        <span className="app__subtitle">relaxation solver · web worker</span>
      </header>

      <div className="app__body">
        <Sidebar
          status={status}
          progress={progress}
          iteration={iteration}
          ke={ke}
          resultIterations={resultIterations}
          termination={termination}
          error={error}
          input={setup.input}
          constants={setup.constants}
          onInputChange={setup.setInput}
          onConstantsChange={setup.setConstants}
          onCompute={handleCompute}
          onCancel={cancel}
        />

        <main className="app__stage">
          {status === 'running' ? (
            <div className="stage-center">
              <ProgressRing fraction={progress} iteration={iteration} />
              <p className="stage-center__text">
                Relaxing the chain — kinetic energy {formatEnergy(ke)}
              </p>
              <button type="button" className="btn btn--danger" onClick={cancel}>
                Cancel
              </button>
            </div>
          ) : status === 'done' && result ? (
            <Player key={playerKey} frameSet={result} />
          ) : (
            <PoseEditor
              input={setup.input}
              onAddPoint={setup.addDrawn}
              onRemoveLast={setup.removeLastDrawn}
              onClear={setup.clearDrawn}
              onUndo={setup.undo}
              onRedo={setup.redo}
              canUndo={setup.canUndo}
              canRedo={setup.canRedo}
            />
          )}
        </main>
      </div>
    </div>
  )
}

export default App
