import type { Frame } from './types'

/**
 * Hard cap on the number of frames retained for playback. Runs that produce
 * more are decimated in place, keeping the first and last frames and an
 * approximately even spacing across the whole run.
 */
export const MAX_STORED_FRAMES = 20000

/** Soft cap on the points held across all buffered frames; keeps long runs on big curves in memory. */
export const MAX_BUFFERED_POINTS = 2_000_000

export interface FrameBuffer {
  /**
   * Record a frame. Frames must arrive with strictly increasing `i`, starting
   * at 0, so a uniform `i % stride` decimation stays evenly spaced.
   */
  add(frame: Frame): void
  /**
   * Flush the buffer and return the retained frames. Ensures `last` is present,
   * then trims to the cap.
   */
  finish(last: Frame): Frame[]
}

/**
 * Accumulates solver frames while bounding memory. Frames are kept on a
 * uniform iteration stride; whenever the buffer grows past twice the cap it
 * drops every other frame and doubles the stride, so both the working set and
 * the spacing stay uniform. {@link FrameBuffer.finish} guarantees the first and
 * last frames survive and returns at most `maxFrames` frames.
 */
export function createFrameBuffer(maxFrames: number = MAX_STORED_FRAMES): FrameBuffer {
  if (!(maxFrames >= 2)) throw new Error('createFrameBuffer: maxFrames must be ≥ 2')

  const frames: Frame[] = []
  let stride = 1
  let points = 0
  const weight = (f: Frame): number => f.curves.reduce((n, c) => n + c.length, 0)

  return {
    add(frame: Frame): void {
      if (frame.i % stride === 0) {
        frames.push(frame)
        points += weight(frame)
      }

      if (frames.length > 2 * maxFrames || (points > MAX_BUFFERED_POINTS && frames.length > 4)) {
        let w = 0
        points = 0
        for (let r = 0; r < frames.length; r += 2) {
          frames[w++] = frames[r]
          points += weight(frames[r])
        }
        frames.length = w
        stride *= 2
      }
    },

    finish(last: Frame): Frame[] {
      const tail = frames.at(-1)
      if (tail === undefined || tail.i !== last.i) {
        // The stride can skip the final iteration. Append it, but substitute
        // the last stored frame when appending would cluster the two together.
        if (tail !== undefined && last.i - tail.i < stride) frames[frames.length - 1] = last
        else frames.push(last)
      }

      if (frames.length <= maxFrames) return frames

      // Evenly subsample by array position. The stored frames are themselves
      // uniform, so this yields roughly even iteration spacing, and indices 0
      // and frames.length - 1 map to the first and last frames.
      const span = frames.length - 1
      const kept: Frame[] = new Array(maxFrames)
      for (let k = 0; k < maxFrames; k++) {
        kept[k] = frames[Math.round((k * span) / (maxFrames - 1))]
      }
      return kept
    },
  }
}
