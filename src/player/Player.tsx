import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { FrameSet } from '../solver/types'
import { FrameCanvas } from './FrameCanvas'
import { SegmentPlot } from './SegmentPlot'
import { CoordinatePlot } from './CoordinatePlot'
import { formatEnergy } from '../lib/format'
import './player.css'

export interface PlayerProps {
  frameSet: FrameSet
}

const BASE_FPS = 30
const MIN_SPEED = 0.1
const MAX_SPEED = 16

function formatSpeed(value: number): string {
  return `${Number(value.toFixed(2))}×`
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5v13l11-6.5L7 5.5Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
    </svg>
  )
}

function FirstIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5.5" y="6" width="2.4" height="12" rx="1" />
      <path d="M19 6v12l-9-6 9-6Z" />
    </svg>
  )
}

function LastIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="16.1" y="6" width="2.4" height="12" rx="1" />
      <path d="M5 6v12l9-6-9-6Z" />
    </svg>
  )
}

function LoopIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9a5 5 0 0 1 5-5h7m0 0-2.6-2.6M16 4l-2.6 2.6M20 15a5 5 0 0 1-5 5H8m0 0 2.6 2.6M8 20l2.6-2.6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SplitIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.7" />
      <rect x="3" y="13" width="18" height="7" rx="1.4" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

/**
 * Playback widget for a {@link FrameSet}. Remounted per compute run by the
 * parent (via a `key`), so each run starts cleanly at frame 0.
 */
export function Player({ frameSet }: PlayerProps) {
  const total = frameSet.frames.length
  const lastIndex = Math.max(0, total - 1)

  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [split, setSplit] = useState(false)
  const [curveIndex, setCurveIndex] = useState(0)

  // Mirrors of state read inside the animation loop without re-subscribing.
  const indexRef = useRef(0)
  const speedRef = useRef(speed)
  const loopRef = useRef(loop)

  useEffect(() => {
    speedRef.current = speed
  }, [speed])
  useEffect(() => {
    loopRef.current = loop
  }, [loop])

  const commitIndex = useCallback((next: number) => {
    indexRef.current = next
    setIndex(next)
  }, [])

  const jumpTo = useCallback(
    (target: number) => {
      setPlaying(false)
      commitIndex(Math.min(Math.max(target, 0), lastIndex))
    },
    [commitIndex, lastIndex],
  )

  const step = useCallback(
    (delta: number) => {
      setPlaying(false)
      commitIndex(Math.min(Math.max(indexRef.current + delta, 0), lastIndex))
    },
    [commitIndex, lastIndex],
  )

  const togglePlay = useCallback(() => {
    if (!playing && indexRef.current >= lastIndex && lastIndex > 0) {
      commitIndex(0)
    }
    setPlaying((prev) => !prev)
  }, [playing, commitIndex, lastIndex])

  // Animation loop: advance whole frames from accumulated dt so the cadence
  // stays smooth, speed changes apply immediately, and long stalls don't
  // fast-forward unboundedly.
  useEffect(() => {
    if (!playing || total <= 1) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const tick = (now: number) => {
      const dt = Math.min(now - last, 250)
      last = now
      acc += dt
      const stepMs = 1000 / (BASE_FPS * speedRef.current)
      let advance = Math.floor(acc / stepMs)
      if (advance > 0) {
        acc -= advance * stepMs
        if (advance > 240) {
          advance = 240
          acc = 0
        }
        let next = indexRef.current + advance
        let reachedEnd = false
        if (next > lastIndex) {
          if (loopRef.current) {
            next = next % total
          } else {
            next = lastIndex
            reachedEnd = true
          }
        }
        commitIndex(next)
        if (reachedEnd) setPlaying(false)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, total, lastIndex, commitIndex])

  const slowDown = () => setSpeed((prev) => Math.max(MIN_SPEED, prev / 2))
  const speedUp = () => setSpeed((prev) => Math.min(MAX_SPEED, prev * 2))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.tagName === 'BUTTON' || target.tagName === 'INPUT') return
    switch (event.code) {
      case 'Space':
        event.preventDefault()
        togglePlay()
        break
      case 'ArrowRight':
        event.preventDefault()
        step(1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        step(-1)
        break
      default:
        break
    }
  }

  const safeIndex = Math.min(index, lastIndex)
  const currentFrame = frameSet.frames[safeIndex]
  const ke = currentFrame?.ke ?? 0
  const canStep = total > 1
  const curveCount = Math.max(frameSet.meta.curveCount, 1)
  const safeCurve = Math.min(Math.max(curveIndex, 0), curveCount - 1)

  const legend = useMemo(
    () => [
      { className: 'start', label: 'start' },
      { className: 'end', label: 'end' },
      { className: 'point', label: 'interior point' },
      { className: 'orient', label: 'orientation' },
    ],
    [],
  )

  return (
    <div className="player" role="group" aria-label="Chain playback" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="player__stagebar">
        <div className="player__legend">
          {legend.map((item) => (
            <span className="legend-chip" key={item.className}>
              <span className={`legend-chip__swatch legend-chip__swatch--${item.className}`} />
              {item.label}
            </span>
          ))}
        </div>

        <div className="player__hud">
          <span>
            {curveCount} curve{curveCount > 1 ? 's' : ''}
          </span>
          <span>{frameSet.meta.N} pts</span>
          <span>KE {formatEnergy(ke)}</span>
        </div>
      </div>

      {curveCount > 1 ? (
        <div className="chip-row chip-row--view" role="tablist" aria-label="Curve to plot">
          {Array.from({ length: curveCount }, (_, ci) => (
            <button
              key={ci}
              type="button"
              role="tab"
              aria-selected={ci === safeCurve}
              className={`chip chip--sm ${ci === safeCurve ? 'is-active' : ''}`}
              onClick={() => setCurveIndex(ci)}
            >
              Curve {ci + 1}
            </button>
          ))}
        </div>
      ) : null}

      <div className="player__stage">
        {split ? (
          <div className="player__split">
            <CoordinatePlot frameSet={frameSet} frameIndex={safeIndex} axis={0} />
            <CoordinatePlot frameSet={frameSet} frameIndex={safeIndex} axis={1} />
          </div>
        ) : (
          <FrameCanvas frameSet={frameSet} frameIndex={safeIndex} playing={playing} />
        )}
      </div>

      <div className="player__plot">
        <SegmentPlot frameSet={frameSet} frameIndex={safeIndex} curveIndex={safeCurve} />
      </div>

      <div className="player__controls">
        <div className="player__row">
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => jumpTo(0)}
            disabled={!canStep || safeIndex === 0}
            aria-label="Jump to first frame"
            title="First frame"
          >
            <FirstIcon />
          </button>
          <button
            type="button"
            className="btn btn--icon btn--primary"
            onClick={togglePlay}
            disabled={!canStep}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => jumpTo(lastIndex)}
            disabled={!canStep || safeIndex >= lastIndex}
            aria-label="Jump to last frame"
            title="Last frame"
          >
            <LastIcon />
          </button>

          <div className="player__spacer" />

          <div className="player__group" role="group" aria-label="Playback speed">
            <button type="button" className="btn btn--sm" onClick={slowDown} disabled={speed <= MIN_SPEED} aria-label="Slow down" title="Slow down (÷2)">
              −
            </button>
            <span className="speed-label" aria-live="polite">
              {formatSpeed(speed)}
            </span>
            <button type="button" className="btn btn--sm" onClick={speedUp} disabled={speed >= MAX_SPEED} aria-label="Speed up" title="Speed up (×2)">
              +
            </button>
          </div>

          <button
            type="button"
            className={`btn btn--icon ${split ? 'is-on' : ''}`}
            onClick={() => setSplit((prev) => !prev)}
            aria-pressed={split}
            aria-label="Split x and y coordinates"
            title={split ? 'Combined view' : 'Split x / y view'}
          >
            <SplitIcon />
          </button>

          <button
            type="button"
            className={`btn btn--icon ${loop ? 'is-on' : ''}`}
            onClick={() => setLoop((prev) => !prev)}
            aria-pressed={loop}
            aria-label="Loop playback"
            title={loop ? 'Looping on' : 'Looping off'}
          >
            <LoopIcon />
          </button>
        </div>

        <div className="scrub-row">
          <input
            className="scrub"
            type="range"
            min={0}
            max={lastIndex}
            step={1}
            value={safeIndex}
            disabled={!canStep}
            onChange={(event) => {
              setPlaying(false)
              commitIndex(Number(event.target.value))
            }}
            aria-label="Frame scrubber"
            aria-valuetext={`Frame ${safeIndex + 1} of ${Math.max(total, 1)}`}
          />
          <span className="frame-label">
            frame <strong>{safeIndex + 1}</strong> / {Math.max(total, 1)}
          </span>
        </div>
      </div>
    </div>
  )
}

export default Player
