export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface EasePhase {
  startScale: number
  startFrame: number
}

export interface EaseInput {
  previous: number
  target: number
  phase: EasePhase | null
  frameIndex: number
  totalFrames: number
  easingEnabled: boolean
}

export interface EaseResult {
  scale: number
  phase: EasePhase | null
}

/**
 * Displayed scale for the current frame. Zoom-in (target > previous) eases in
 * from the previous scale so it starts slow and catches up by the final frame;
 * zoom-out and any paused/scrubbed frame snap to the true fit.
 */
export function nextDisplayedScale(e: EaseInput): EaseResult {
  if (!e.easingEnabled) {
    return { scale: e.target, phase: null }
  }
  if (e.target <= e.previous) {
    return { scale: e.target, phase: null }
  }
  if (e.phase === null) {
    return { scale: e.previous, phase: { startScale: e.previous, startFrame: e.frameIndex } }
  }
  const span = Math.max(e.totalFrames - 1 - e.phase.startFrame, 1)
  const t = Math.min(Math.max((e.frameIndex - e.phase.startFrame) / span, 0), 1)
  const alpha = t * t
  const scale = e.phase.startScale + (e.target - e.phase.startScale) * alpha
  return { scale, phase: e.phase }
}

/** Equal-scale, centered fit of the bounds into the canvas with padding. */
export function fitScale(bounds: Bounds, width: number, height: number): number {
  const pad = Math.max(22, Math.min(width, height) * 0.09)
  const availW = Math.max(width - 2 * pad, 1)
  const availH = Math.max(height - 2 * pad, 1)
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9)
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9)
  return Math.min(availW / spanX, availH / spanY)
}

/**
 * Bounds whose fit yields `easedScale`: scale both spans by k = fitScale /
 * easedScale, since fitScale = min(availW/spanX, availH/spanY) divides by k.
 */
export function boundsForScale(bounds: Bounds, fitScale: number, easedScale: number): Bounds {
  const k = fitScale / easedScale
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY
  return {
    minX: cx - (spanX / 2) * k,
    maxX: cx + (spanX / 2) * k,
    minY: cy - (spanY / 2) * k,
    maxY: cy + (spanY / 2) * k,
  }
}
