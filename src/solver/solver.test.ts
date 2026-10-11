import { describe, expect, it } from 'vitest'
import {
  computeAcceleration,
  computeBendForce,
  computeLengthForce,
  computeReferenceLength,
  computeSegments,
  normalize,
} from './forces'
import { CancelledError, solve } from './solve'
import { DEFAULT_CONSTANTS, type Vec2 } from './types'
import { validateInput } from './validate'

const validInput = {
  n: 3,
  start: [0, 0] as Vec2,
  end: [10, 0] as Vec2,
  startDir: [1, 0] as Vec2,
  endDir: [1, 0] as Vec2,
}

const zeroVel = (N: number): Vec2[] => Array.from({ length: N }, () => [0, 0])

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

  it('rejects coincident start and end', () => {
    const issues = validateInput({ ...validInput, start: [5, 0], end: [5, 0] })
    expect(issues.some((i) => i.field === 'end')).toBe(true)
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
    const frame0 = solve(input, { ...DEFAULT_CONSTANTS, maxIter: 1 }).frames[0]

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
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, maxIter: 1 })
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

  it('bend force pushes the middle point toward the chord (reduces bend)', () => {
    const pts: Vec2[] = [
      [0, 0],
      [1, 0.5],
      [2, 0],
    ]
    const { unitVecs } = computeSegments(pts)
    const dotBefore = unitVecs[0][0] * unitVecs[1][0] + unitVecs[0][1] * unitVecs[1][1]
    expect(dotBefore).toBeCloseTo(0.6, 12)

    const f = computeBendForce(1, pts, unitVecs, 1)
    // direction: (0, -1) scaled by positive magnitude -> moves p1 downward
    expect(f[1]).toBeLessThan(0)

    // One small semi-implicit step (no friction) must increase the dot product.
    const h = 0.001
    const vel = [0, 0] as Vec2
    vel[0] += h * f[0]
    vel[1] += h * f[1]
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
    const b = computeBendForce(1, pts, unitVecs, 1)
    expect([...f, ...b].every(Number.isFinite)).toBe(true)
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
    const result = solve(input, { ...DEFAULT_CONSTANTS, epsilon: 1e-12, maxIter: 200 })

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
  it('stops a static chain via KE threshold after muteFrames', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, muteFrames: 10, maxIter: 20000 })
    expect(result.meta.termination).toBe('ke')
    expect(result.frames.length).toBe(11)
  })

  it('respects maxIter when it is reached first', () => {
    const result = solve(validInput, { ...DEFAULT_CONSTANTS, muteFrames: 1000, maxIter: 5 })
    expect(result.meta.termination).toBe('maxIter')
    expect(result.frames.length).toBe(6)
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
      }),
    ).toThrow(CancelledError)
  })
})