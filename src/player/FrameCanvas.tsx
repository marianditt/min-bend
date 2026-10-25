import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import type { FrameSet, Vec2 } from '../solver/types'
import { boundsForScale, fitScale, nextDisplayedScale, type EasePhase } from './scaleEase'
import {
  type CurveProbe,
  type Projector,
  LIGHT_THEME,
  DARK_THEME,
  closestOnCurves,
  computePtsBounds,
  makeProjector,
  usePrefersDark,
} from './canvasKit'
import { type Scene, type ViewOptions, buildScene, renderScene } from './scene'

export interface FrameCanvasProps {
  frameSet: FrameSet
  frameIndex: number
  playing: boolean
  hidden: boolean[]
  probe: CurveProbe | null
  onProbe: (probe: CurveProbe | null) => void
  options: ViewOptions
  /** Receives the scene exactly as last drawn, so it can be exported. */
  sceneRef?: RefObject<Scene | null>
}

export function FrameCanvas({ frameSet, frameIndex, playing, hidden, probe, onProbe, options, sceneRef }: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()

  const displayedScaleRef = useRef(0)
  const phaseRef = useRef<EasePhase | null>(null)
  const projectorRef = useRef<Projector | null>(null)

  const clampedIndex = Math.min(Math.max(frameIndex, 0), Math.max(frameSet.frames.length - 1, 0))
  const frameCurves = frameSet.frames[clampedIndex]?.curves
  const bounds = useMemo(() => {
    const curves = frameCurves ?? []
    const visible = curves.filter((_, ci) => !hidden[ci])
    return computePtsBounds(visible.flat())
  }, [frameCurves, hidden])
  const theme = dark ? DARK_THEME : LIGHT_THEME

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0 || size.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.width * dpr))
    canvas.height = Math.max(1, Math.round(size.height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const target = fitScale(bounds, size.width, size.height)
    const previous = displayedScaleRef.current === 0 ? target : displayedScaleRef.current
    const result = nextDisplayedScale({
      previous,
      target,
      phase: phaseRef.current,
      frameIndex: clampedIndex,
      totalFrames: frameSet.frames.length,
      easingEnabled: playing,
    })
    displayedScaleRef.current = result.scale
    phaseRef.current = result.phase
    const drawBounds = result.scale === target ? bounds : boundsForScale(bounds, target, result.scale)
    const scene = buildScene(frameSet, frameIndex, size.width, size.height, drawBounds, theme, dark, hidden, probe, options)
    renderScene(ctx, scene)
    projectorRef.current = makeProjector(drawBounds, size.width, size.height)
    if (sceneRef) sceneRef.current = scene
    canvas.dataset.scale = String(result.scale)
  }, [frameSet, frameIndex, size, bounds, theme, playing, clampedIndex, dark, hidden, probe, options, sceneRef])

  const handleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const project = projectorRef.current
    if (!canvas || !project) return
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const world: Vec2 = [
      project.cx + (sx - size.width / 2) / project.scale,
      project.cy - (sy - size.height / 2) / project.scale,
    ]
    const visible = (frameCurves ?? []).map((pts, ci) => (hidden[ci] || !options.curves ? null : pts))
    onProbe(closestOnCurves(visible, world))
  }

  return (
    <div className="frame-canvas" ref={containerRef}>
      <canvas ref={canvasRef} onClick={handleClick} title="Click to measure the tangent at the closest curve point" />
    </div>
  )
}

export default FrameCanvas
