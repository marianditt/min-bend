import { describe, expect, it } from 'vitest'
import {
  computeAcceleration,
  computeBendForces,
  computeLengthForce,
  computeReferenceLength,
  computeSegments,
  normalize,
  clampMagnitude,
  length,
} from './forces'
import { CancelledError, solve } from './solve'
import { createFrameBuffer } from './frameBuffer'
import { DEFAULT_CONSTANTS, type Frame, type Vec2 } from './types'
import { validateInput } from './validate'

const validInput = {
  n: 3,
  start: [0, 0] as Vec2,
  end: [10, 0] as Vec2,
  startDir: [1, 0] as Vec2,
  endDir: [1, 0] as Vec2,
}

const zeroVel = (N: number): Vec2[] => Array.from({ length: N }, () => [0, 0])

/** Centered RNG: produces a zero jitter offset so initialization stays straight. */
const plainInit = { random: () => 0.5 }

describe('validateInput', () => {
  it('accepts a valid input', () => {
    expect(validateInput(validInput)).toEqual([])
  })

  it('rejects n < 2 and non-integer n', () => {
    expect(validateInput({ ...validInput, n: 1 })[0].field).toBe('n')
    expect(validateInput({ ...validInput, n: 0 })[0].field).toBe('n')
    expect(validateInput({ ...validInput, n: 2.5 })[0].field).toBe('n')
  })

  it('rejects zero orientation vectors', () => {
    expect(validateInput({ ...validInput, startDir: [0, 0] })[0].field).toBe('startDir')
    expect(validateInput({ ...validInput, endDir: [0, 0] })[0].field).toBe('endDir')
  })

  it('accepts coincident start and end', () => {
    const issues = validateInput({ ...validInput, start: [5, 0], end: [5, 0] })
    expect(issues).toEqual([])
  })

  it('rejects non-finite coordinates', () => {
    expect(validateInput({ ...validInput, start: [NaN, 0] }).length).toBeGreaterThan(0)
    expect(validateInput({ ...validInput, end: [Infinity, 0] }).length).toBeGreaterThan(0)
  })
})

describe('initialization (frame 0)', () => {
  it('satisfies orientation constraints exactly and spaces points evenly', () => {
    const input = {
      n: 4,
      start: [0, 0] as Vec2,
      end: [10, 0] as Vec2,
      startDir: [3, 4] as Vec2,
      endDir: [0, -2] as Vec2,
    }
    const d0 = normalize(input.startDir)
    const d1 = normalize(input.endDir)
    const frame0 = solve(input, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]

    // First segment direction == start orientation
    const seg0: Vec2 = [
      frame0.pts[1][0] - frame0.pts[0][0],
      frame0.pts[1][1] - frame0.pts[0][1],
    ]
    expect(normalize(seg0)[0]).toBeCloseTo(d0[0], 12)
    expect(normalize(seg0)[1]).toBeCloseTo(d0[1], 12)

    // Last segment direction == end orientation
    const N = frame0.pts.length
    const segLast: Vec2 = [
      frame0.pts[N - 1][0] - frame0.pts[N - 2][0],
      frame0.pts[N - 1][1] - frame0.pts[N - 2][1],
    ]
    expect(normalize(segLast)[0]).toBeCloseTo(d1[0], 12)
    expect(normalize(segLast)[1]).toBeCloseTo(d1[1], 12)

    // All middle segments (between p_1 and p_n, inclusive) have equal length
    const { lengths } = computeSegments(frame0.pts)
    const mid = lengths.slice(1, -1)
    for (let i = 1; i < mid.length; i++) {
      expect(mid[i]).toBeCloseTo(mid[0], 12)
    }
  })

  it('starts with zero velocity (zero KE)', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    expect(result.frames[0].ke).toBe(0)
  })
})

describe('forces', () => {
  it('produces ~zero acceleration on a straight, equal-length chain', () => {
    const pts: Vec2[] = [
      [0, 0],
      [3, 0],
      [6, 0],
      [9, 0],
      [12, 0],
    ]
    const N = pts.length
    const accel = computeAcceleration(pts, zeroVel(N), DEFAULT_CONSTANTS)
    for (let k = 1; k < N - 1; k++) {
      expect(accel[k][0]).toBeCloseTo(0, 12)
      expect(accel[k][1]).toBeCloseTo(0, 12)
    }
  })

  it('attracts a point toward its stretched neighbor', () => {
    // Stretched segment p0-p1 (length 4 > L=3), compressed p1-p2 (length 2 < L).
    const pts: Vec2[] = [
      [0, 0],
      [4, 0],
      [6, 0],
    ]
    const { lengths, unitVecs } = computeSegments(pts)
    const L = computeReferenceLength(lengths)
    const f = computeLengthForce(1, lengths, unitVecs, L, 1)
    // p1 experiences attraction toward p0 (its stretched segment)
    expect(f[0]).toBeLessThan(0)
    expect(f[1]).toBeCloseTo(0, 12)
  })

  it('bend forces push the middle point toward the chord (reduces bend)', () => {
    const pts: Vec2[] = [
      [0, 0],
      [1, 0.5],
      [2, 0],
    ]
    const { lengths, unitVecs } = computeSegments(pts)
    const dotBefore = unitVecs[0][0] * unitVecs[1][0] + unitVecs[0][1] * unitVecs[1][1]
    expect(dotBefore).toBeCloseTo(0.6, 12)

    const { prev, cur, next } = computeBendForces(1, lengths, unitVecs, 1)
    expect(cur[1]).toBeLessThan(0)
    expect(prev[0]).toBeLessThan(0)
    expect(next[0]).toBeGreaterThan(0)
    expect(prev[0] + cur[0] + next[0]).toBeCloseTo(0, 12)
    expect(prev[1] + cur[1] + next[1]).toBeCloseTo(0, 12)

    // One small semi-implicit step (no friction) must increase the dot product.
    const h = 0.001
    const vel = [0, 0] as Vec2
    vel[0] += h * cur[0]
    vel[1] += h * cur[1]
    const moved: Vec2[] = [
      [0, 0],
      [pts[1][0] + h * vel[0], pts[1][1] + h * vel[1]],
      [2, 0],
    ]
    const { unitVecs: movedUnit } = computeSegments(moved)
    const dotAfter = movedUnit[0][0] * movedUnit[1][0] + movedUnit[0][1] * movedUnit[1][1]
    expect(dotAfter).toBeGreaterThan(dotBefore)
  })

  it('skips degenerate segments without producing NaN', () => {
    const pts: Vec2[] = [
      [0, 0],
      [0, 0], // zero-length segment
      [2, 0],
    ]
    const { lengths, unitVecs } = computeSegments(pts)
    const L = computeReferenceLength(lengths)
    expect(Number.isNaN(L)).toBe(false)
    const f = computeLengthForce(1, lengths, unitVecs, L, 1)
    const bend = computeBendForces(1, lengths, unitVecs, 1)
    expect([...f, ...bend.prev, ...bend.cur, ...bend.next].every(Number.isFinite)).toBe(true)
  })
})

describe('constraints', () => {
  it('keeps first/last segment orientations fixed across all frames', () => {
    const input = {
      n: 3,
      start: [0, 0] as Vec2,
      end: [10, 0] as Vec2,
      startDir: [0, 1] as Vec2,
      endDir: [0, -1] as Vec2,
    }
    const d0 = normalize(input.startDir)
    const d1 = normalize(input.endDir)
    const result = solve(
      input,
      { ...DEFAULT_CONSTANTS, epsilon: 1e-12, maxIter: 200 },
      plainInit,
    )

    for (const frame of result.frames) {
      const s0: Vec2 = [frame.pts[1][0] - frame.pts[0][0], frame.pts[1][1] - frame.pts[0][1]]
      const N = frame.pts.length
      const sLast: Vec2 = [
        frame.pts[N - 1][0] - frame.pts[N - 2][0],
        frame.pts[N - 1][1] - frame.pts[N - 2][1],
      ]
      const n0 = normalize(s0)
      const nLast = normalize(sLast)
      const align0 = n0[0] * d0[0] + n0[1] * d0[1]
      const alignLast = nLast[0] * d1[0] + nLast[1] * d1[1]
      expect(align0).toBeCloseTo(1, 10)
      expect(alignLast).toBeCloseTo(1, 10)
    }
  })
})

describe('termination', () => {
  it('stops a static chain via KE threshold after settleFrames', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, settleFrames: 10, maxIter: 20000 }, plainInit)
    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBe(11)
  })

  it('respects maxIter when it is reached first', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, settleFrames: 1000, maxIter: 5 }, plainInit)
    expect(result.meta.termination).toBe('maxIter')
    expect(result.frames.length).toBe(6)
  })

  it('requires settleFrames consecutive quiet frames', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, settleFrames: 1, maxIter: 20000 }, plainInit)
    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBe(2)
  })

  it('relaxes a kinked chain to a finite, stable equilibrium', () => {
    const input = {
      n: 6,
      start: [0, 0] as Vec2,
      end: [10, 0] as Vec2,
      startDir: [0, 1] as Vec2,
      endDir: [0, -1] as Vec2,
    }
    const progress: number[] = []
    const result = solve(input, DEFAULT_CONSTANTS, {
      onProgress: (p) => progress.push(p),
      ...plainInit,
    })

    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBeGreaterThan(2)
    for (const frame of result.frames) {
      expect(frame.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
      if (frame.i > 0) {
        expect(frame.pts.length).toBe(result.meta.N)
      }
    }
    expect(result.frames[result.frames.length - 1].ke).toBeLessThan(DEFAULT_CONSTANTS.epsilon)
    expect(progress[progress.length - 1]).toBe(1)
  })

  it('lays out a non-degenerate loop when anchors coincide', () => {
    const input = {
      n: 6,
      start: [0, 0] as Vec2,
      end: [0, 0] as Vec2,
      startDir: [0, 1] as Vec2,
      endDir: [0, -1] as Vec2,
    }
    const result = solve(input, { ...DEFAULT_CONSTANTS, epsilon: 1e-12, settleFrames: 1, maxIter: 5 }, plainInit)
    // all points finite
    for (const frame of result.frames) {
      expect(frame.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    }
    const frame0 = result.frames[0]
    // first segment normalized ≈ [0,1]
    const s0: Vec2 = [frame0.pts[1][0] - frame0.pts[0][0], frame0.pts[1][1] - frame0.pts[0][1]]
    expect(normalize(s0)[0]).toBeCloseTo(0, 12)
    expect(normalize(s0)[1]).toBeCloseTo(1, 12)
    // last segment normalized ≈ [0,-1]
    const N = frame0.pts.length
    const sLast: Vec2 = [frame0.pts[N - 1][0] - frame0.pts[N - 2][0], frame0.pts[N - 1][1] - frame0.pts[N - 2][1]]
    expect(normalize(sLast)[0]).toBeCloseTo(0, 12)
    expect(normalize(sLast)[1]).toBeCloseTo(-1, 12)
    // chain not degenerate: some axis span > 1e-6
    const xs = frame0.pts.map((p) => p[0])
    const ys = frame0.pts.map((p) => p[1])
    expect(Math.max(...xs) - Math.min(...xs) > 1e-6 || Math.max(...ys) - Math.min(...ys) > 1e-6).toBe(true)
    // all middle segment lengths ≥ 1e-9 and finite
    const { lengths } = computeSegments(frame0.pts)
    const mid = lengths.slice(1, -1)
    for (const len of mid) {
      expect(len).toBeGreaterThanOrEqual(1e-9)
      expect(Number.isFinite(len)).toBe(true)
    }
  })
})

describe('cancellation', () => {
  it('throws CancelledError when shouldCancel flips', () => {
    let calls = 0
    const input = {
      n: 6,
      start: [0, 0] as Vec2,
      end: [10, 0] as Vec2,
      startDir: [0, 1] as Vec2,
      endDir: [0, -1] as Vec2,
    }
    expect(() =>
      solve(input, { ...DEFAULT_CONSTANTS, maxIter: 20000 }, {
        shouldCancel: () => ++calls > 10,
        ...plainInit,
      }),
    ).toThrow(CancelledError)
  })
})

describe('randomized initialization', () => {
  const input = {
    n: 5,
    start: [0, 0] as Vec2,
    end: [10, 0] as Vec2,
    startDir: [1, 0] as Vec2,
    endDir: [1, 0] as Vec2,
  }

  it('keeps a straight, equal-length start when the jitter value is centered', () => {
    const frame = solve(input, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const { lengths } = computeSegments(frame.pts)
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeCloseTo(lengths[0], 12)
    }
    expect(frame.pts.every((p) => p[1] === 0)).toBe(true)
  })

  it('perturbs interior points perpendicular to the chord and keeps anchors exact', () => {
    const straight = solve(input, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit).frames[0]
    const wiggled = solve(input, { ...DEFAULT_CONSTANTS, maxIter: 1 }, { random: () => 1 }).frames[0]
    const n = input.n
    expect(wiggled.pts[0]).toEqual(straight.pts[0])
    expect(wiggled.pts[1]).toEqual(straight.pts[1])
    expect(wiggled.pts[n]).toEqual(straight.pts[n])
    expect(wiggled.pts[n + 1]).toEqual(straight.pts[n + 1])
    for (let k = 2; k < n; k++) {
      expect(wiggled.pts[k][0]).toBeCloseTo(straight.pts[k][0], 12)
      expect(Math.abs(wiggled.pts[k][1])).toBeGreaterThan(0)
    }
  })

  it('still satisfies orientation constraints on every frame when randomized', () => {
    const result = solve(
      input,
      { ...DEFAULT_CONSTANTS, epsilon: 1e-12, maxIter: 200 },
      { random: () => 1 },
    )
    for (const frame of result.frames) {
      const s0: Vec2 = [frame.pts[1][0] - frame.pts[0][0], frame.pts[1][1] - frame.pts[0][1]]
      const N = frame.pts.length
      const sLast: Vec2 = [
        frame.pts[N - 1][0] - frame.pts[N - 2][0],
        frame.pts[N - 1][1] - frame.pts[N - 2][1],
      ]
      const n0 = normalize(s0)
      const nLast = normalize(sLast)
      expect(n0[1]).toBeCloseTo(0, 10)
      expect(nLast[1]).toBeCloseTo(0, 10)
    }
  })
})

describe('force bound', () => {
  it('clampMagnitude keeps direction and caps length', () => {
    const v = clampMagnitude([3, 4], 2)
    expect(length(v)).toBeCloseTo(2, 12)
    expect(v[0]).toBeCloseTo(1.2, 12)
    expect(v[1]).toBeCloseTo(1.6, 12)
  })

  it('returns a vector already within the bound unchanged', () => {
    const v = clampMagnitude([1, 2], 5)
    expect(v).toEqual([1, 2])
  })

  it('computeAcceleration respects constants.maxForce', () => {
    const pts: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    const vel = (Array.from({ length: 4 }, () => [0, 0]) as Vec2[])
    const accel = computeAcceleration(pts, vel, { ...DEFAULT_CONSTANTS, maxForce: 1 })
    for (let k = 1; k < pts.length - 1; k++) {
      const mag = Math.hypot(accel[k][0], accel[k][1])
      expect(mag).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('solve stays finite with a tiny bound', () => {
    const input = {
      n: 3,
      start: [0, 0] as Vec2,
      end: [10, 0] as Vec2,
      startDir: [1, 0] as Vec2,
      endDir: [1, 0] as Vec2,
    }
    const result = solve(input, { ...DEFAULT_CONSTANTS, maxForce: 1, maxIter: 50 }, plainInit)
    for (const frame of result.frames) {
      expect(frame.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
    }
  })
})

describe('frame buffer', () => {
  const buf = (i: number): Frame => ({ i, ke: 0, pts: [] })

  it('keeps every frame when the run stays within the cap', () => {
    const buffer = createFrameBuffer(100000)
    for (let i = 0; i <= 7; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(7))
    expect(out.map((f) => f.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('caps at maxFrames and preserves the first and last frames', () => {
    const maxFrames = 100
    const buffer = createFrameBuffer(maxFrames)
    const total = 5000
    for (let i = 0; i <= total; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(total))
    expect(out.length).toBe(maxFrames)
    expect(out[0].i).toBe(0)
    expect(out[out.length - 1].i).toBe(total)
  })

  it('keeps roughly even spacing after decimation', () => {
    const buffer = createFrameBuffer(64)
    const total = 4000
    for (let i = 0; i <= total; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(total))
    const gaps: number[] = []
    for (let k = 1; k < out.length; k++) gaps.push(out[k].i - out[k - 1].i)
    const min = Math.min(...gaps)
    const max = Math.max(...gaps)
    expect(min).toBeGreaterThan(0)
    expect(max / min).toBeLessThan(4)
  })

  it('appends a final frame that the stride skipped', () => {
    const buffer = createFrameBuffer(4)
    for (let i = 0; i <= 30; i++) buffer.add(buf(i))
    const out = buffer.finish(buf(31))
    expect(out[0].i).toBe(0)
    expect(out[out.length - 1].i).toBe(31)
    expect(out.length).toBeLessThanOrEqual(4)
  })
})