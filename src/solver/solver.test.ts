import { describe, expect, it } from 'vitest'
import {
  computeAcceleration,
  computeBendForces,
  computeSegments,
  dot,
  normalize,
  type ChainModel,
} from './forces'
import { CancelledError, previewPose, solve } from './solve'
import { createFrameBuffer } from './frameBuffer'
import { planCurve } from './curve'
import { DEFAULT_CONSTANTS, type Curve, type FixPoint, type Frame, type Setup, type Vec2 } from './types'
import { validateSetup } from './validate'
import { MAX_RUNNING_PROGRESS, ProgressTracker } from './progress'

const fp = (pos: Vec2, orientation: Vec2 | null = null, posFree = false): FixPoint =>
  posFree ? { pos, orientation, posFree } : { pos, orientation }

/** Single curve through the given control points. */
const chain = (points: FixPoint[], resolution = 1, extra: Partial<Curve> = {}): Setup => ({
  resolution,
  curves: [{ fixPoints: points, spans: points.slice(1).map((): Vec2[] => []), ...extra }],
})

const two = (start: Vec2, end: Vec2, d0: Vec2 | null, d1: Vec2 | null, resolution = 1): Setup =>
  chain([fp(start, d0), fp(end, d1)], resolution)

const plainInit = { random: () => 0.5 }
const fast = { ...DEFAULT_CONSTANTS, maxIter: 20000 }
const last = (setup: Setup, constants = fast): Vec2[] =>
  solve(setup, constants, plainInit).frames.at(-1)!.curves[0]

const segLens = (p: Vec2[]): number[] => computeSegments(p).lengths
const turn = (p: Vec2[], k: number): number => {
  const { unitVecs } = computeSegments(p)
  return dot(unitVecs[k - 1], unitVecs[k])
}

describe('validateSetup', () => {
  const valid = two([0, 0], [10, 0], [1, 0], [1, 0])

  it('accepts a valid setup', () => {
    expect(validateSetup(valid)).toEqual([])
  })

  it('rejects a setup with no curves', () => {
    expect(validateSetup({ curves: [], resolution: 1 })[0].field).toBe('curves')
  })

  it('rejects non-positive and non-finite resolution', () => {
    for (const r of [0, -1, NaN, Infinity]) {
      expect(validateSetup({ ...valid, resolution: r }).map((i) => i.field)).toContain('resolution')
    }
  })

  it('rejects a resolution that would create an absurd number of lines', () => {
    expect(validateSetup({ ...valid, resolution: 1e-6 }).map((i) => i.field)).toContain('resolution')
  })

  it('rejects a curve with fewer than two fix points', () => {
    expect(validateSetup(chain([fp([0, 0])]))[0].field).toBe('fixPoints:0')
  })

  it('rejects zero orientation vectors', () => {
    expect(validateSetup(two([0, 0], [10, 0], [0, 0], null))[0].field).toBe('orientation:0:0')
  })

  it('accepts coincident start and end and null orientations', () => {
    expect(validateSetup(two([1, 1], [1, 1], [0, 1], [0, -1]))).toEqual([])
    expect(validateSetup(two([0, 0], [4, 0], null, null))).toEqual([])
  })

  it('rejects non-finite coordinates', () => {
    expect(validateSetup(two([NaN, 0], [10, 0], null, null))[0].field).toBe('fixPoint:0:0')
  })

  it('validates target length', () => {
    expect(validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: 5 }))).toEqual([])
    expect(validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: null }))).toEqual([])
    for (const bad of [0, -1, NaN, Infinity]) {
      const issues = validateSetup(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: bad }))
      expect(issues[0].field).toBe('targetLength:0')
    }
  })
})

describe('discretization by resolution', () => {
  it('uses lines of exactly the resolution, with one shorter remainder per span', () => {
    const [p] = previewPose(two([0, 0], [4.5, 0], null, null, 1))
    expect(p).toHaveLength(6)
    const lens = segLens(p)
    expect(lens.slice(0, 4).every((l) => Math.abs(l - 1) < 1e-9)).toBe(true)
    expect(lens[4]).toBeCloseTo(0.5, 9)
  })

  it('has a variable number of lines when the resolution changes', () => {
    expect(previewPose(two([0, 0], [6, 0], null, null, 1))[0]).toHaveLength(7)
    expect(previewPose(two([0, 0], [6, 0], null, null, 2))[0]).toHaveLength(4)
  })

  it('shares the resolution across curves', () => {
    const setup: Setup = {
      resolution: 2,
      curves: [
        { fixPoints: [fp([0, 0]), fp([8, 0])], spans: [[]] },
        { fixPoints: [fp([0, 5]), fp([4, 5])], spans: [[]] },
      ],
    }
    const [a, b] = previewPose(setup)
    expect(segLens(a).slice(0, -1).every((l) => Math.abs(l - 2) < 1e-9)).toBe(true)
    expect(segLens(b).every((l) => l <= 2 + 1e-9)).toBe(true)
  })

  it('keeps at least three lines in a short span', () => {
    expect(previewPose(two([0, 0], [0.5, 0], null, null, 5))[0]).toHaveLength(4)
  })

  it('shares fix points between spans and reports control indices', () => {
    const setup = chain([fp([0, 0]), fp([3, 0]), fp([3, 4])], 1)
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 5 }, plainInit)
    expect(result.meta.controlIndices).toEqual([[0, 3, 7]])
    expect(result.meta.curvePointCounts).toEqual([8])
    expect(planCurve(setup.curves[0], 1).segmentCount).toBe(7)
  })

  it('uses guide points as the initial layout', () => {
    const setup = two([0, 0], [4, 0], null, null)
    setup.curves[0].spans = [[[2, 3]]]
    const [p] = previewPose(setup)
    expect(Math.max(...p.map((q) => q[1]))).toBeGreaterThan(1)
  })
})

describe('initialization (frame 0)', () => {
  it('satisfies orientation constraints exactly and starts at rest', () => {
    const setup = two([0, 0], [10, 0], [0, 1], [0, -1])
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    const p = result.frames[0].curves[0]
    expect(p[0]).toEqual([0, 0])
    expect(p.at(-1)).toEqual([10, 0])
    expect(p[1][0]).toBeCloseTo(0, 12)
    expect(p[1][1]).toBeGreaterThan(0)
    expect(p.at(-2)![0]).toBeCloseTo(10, 12)
    expect(p.at(-2)![1]).toBeGreaterThan(0)
    expect(result.frames[0].ke).toBe(0)
  })
})

describe('forces', () => {
  const model = (n: number, target: number): ChainModel => ({
    movable: Array.from({ length: n }, (_, i) => i > 0 && i < n - 1),
    targets: new Array(n - 1).fill(target),
    constraints: [],
  })
  const zeroVel = (n: number): Vec2[] => Array.from({ length: n }, () => [0, 0])

  it('produces ~zero acceleration on a straight, equal-length chain', () => {
    const pts: Vec2[] = [[0, 0], [3, 0], [6, 0], [9, 0], [12, 0]]
    const accel = computeAcceleration(pts, zeroVel(5), DEFAULT_CONSTANTS, model(5, 3))
    for (const a of accel) {
      expect(a[0]).toBeCloseTo(0, 12)
      expect(a[1]).toBeCloseTo(0, 12)
    }
  })

  it('pulls a stretched segment together and has no force on pinned points', () => {
    const pts: Vec2[] = [[0, 0], [4, 0], [6, 0]]
    const accel = computeAcceleration(pts, zeroVel(3), { ...DEFAULT_CONSTANTS, kBend: 0 }, model(3, 2))
    expect(accel[1][0]).toBeLessThan(0)
    expect(accel[0]).toEqual([0, 0])
    expect(accel[2]).toEqual([0, 0])
  })

  it('bend forces push the middle point toward the chord and sum to zero', () => {
    const pts: Vec2[] = [[0, 0], [1, 0.5], [2, 0]]
    const { lengths, unitVecs } = computeSegments(pts)
    const { prev, cur, next } = computeBendForces(1, lengths, unitVecs, 1)
    expect(cur[1]).toBeLessThan(0)
    expect(prev[0] + cur[0] + next[0]).toBeCloseTo(0, 12)
    expect(prev[1] + cur[1] + next[1]).toBeCloseTo(0, 12)
  })

  it('skips degenerate segments without producing NaN', () => {
    const pts: Vec2[] = [[0, 0], [0, 0], [2, 0]]
    const accel = computeAcceleration(pts, zeroVel(3), DEFAULT_CONSTANTS, model(3, 1))
    expect(accel.flat().every(Number.isFinite)).toBe(true)
  })
})

describe('control point kinds', () => {
  it('fixed position + fixed orientation: stays put on its tangent line', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2], [1, 0]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, fast, plainInit)
    const ci = result.meta.controlIndices[0][1]
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[ci]).toEqual([4, 2])
      expect(p[ci - 1][1]).toBeCloseTo(2, 9)
      expect(p[ci + 1][1]).toBeCloseTo(2, 9)
      expect(p[ci - 1][0]).toBeLessThanOrEqual(4)
      expect(p[ci + 1][0]).toBeGreaterThanOrEqual(4)
      expect(p[1][0]).toBeCloseTo(0, 9)
    }
  })

  it('fixed position + free orientation: incoming and outgoing directions are equal', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, fast, plainInit)
    const ci = result.meta.controlIndices[0][1]
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[ci]).toEqual([4, 2])
      expect(turn(p, ci)).toBeCloseTo(1, 6)
    }
  })

  it('fixed position + free orientation: the optimizer chooses a non-trivial tangent', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const p = last(setup)
    const ci = planCurve(setup.curves[0], 1).controlIndices[1]
    const t = normalize([p[ci + 1][0] - p[ci - 1][0], p[ci + 1][1] - p[ci - 1][1]])
    expect(Math.abs(t[0])).toBeGreaterThan(0.5)
  })

  it('free orientation at the curve ends leaves the end tangent unconstrained', () => {
    const setup = two([0, 0], [4, 3], null, null)
    const p = last(setup)
    const t = normalize([p[1][0] - p[0][0], p[1][1] - p[0][1]])
    expect(t[0]).toBeCloseTo(0.8, 2)
    expect(t[1]).toBeCloseTo(0.6, 2)
  })

  it('free position + fixed orientation: moves to reduce bend while keeping its tangent', () => {
    const setup = chain([fp([0, 0], [1, 0]), fp([4, 3], [1, 0], true), fp([8, 0], [1, 0])], 1)
    const result = solve(setup, fast, plainInit)
    const ci = result.meta.controlIndices[0][1]
    const first = result.frames[0].curves[0]
    const final = result.frames.at(-1)!.curves[0]
    expect(first[ci]).toEqual([4, 3])
    expect(final[ci][0]).toBeGreaterThan(2)
    expect(final[ci][0]).toBeLessThan(6)
    expect(Math.abs(final[ci][1])).toBeLessThan(5)
    expect(final[ci - 1][1]).toBeCloseTo(final[ci][1], 6)
    expect(final[ci + 1][1]).toBeCloseTo(final[ci][1], 6)
    expect(final[0]).toEqual([0, 0])
    expect(final.at(-1)).toEqual([8, 0])
  })

  it('free position + free orientation behaves like an interior point', () => {
    const setup = chain([fp([0, 0]), fp([4, 3], null, true), fp([8, 0])], 1)
    const p = last(setup)
    const ci = planCurve(setup.curves[0], 1).controlIndices[1]
    expect(p[ci][1]).toBeLessThan(2.9)
  })

  it('keeps first/last orientations fixed across all frames', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), fast, plainInit)
    for (const frame of result.frames) {
      const p = frame.curves[0]
      expect(p[1][0]).toBeCloseTo(0, 9)
      expect(p[1][1]).toBeGreaterThanOrEqual(0)
      expect(p.at(-2)![0]).toBeCloseTo(10, 9)
    }
  })
})

describe('termination', () => {
  it('stops a static chain via KE threshold after settleFrames', () => {
    const result = solve(two([0, 0], [4, 0], null, null), DEFAULT_CONSTANTS, plainInit)
    expect(result.meta.termination).toBe('ke')
    expect(result.meta.iterations).toBe(DEFAULT_CONSTANTS.settleFrames)
  })

  it('respects maxIter when it is reached first', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), { ...DEFAULT_CONSTANTS, maxIter: 5 }, plainInit)
    expect(result.meta.termination).toBe('maxIter')
    expect(result.meta.iterations).toBe(5)
  })

  it('relaxes a kinked chain to a finite, stable equilibrium without a force cap', () => {
    const result = solve(two([0, 0], [10, 0], [0, 1], [0, -1]), fast)
    expect(result.frames.every((f) => f.curves[0].flat().every(Number.isFinite))).toBe(true)
  })

  it('lays out a non-degenerate loop when anchors coincide', () => {
    const p = last(two([0, 0], [0, 0], [0, 1], [0, -1]))
    expect(p.flat().every(Number.isFinite)).toBe(true)
    expect(Math.max(...p.map((q) => Math.hypot(q[0], q[1])))).toBeGreaterThan(0.5)
    expect(Math.min(...segLens(p))).toBeGreaterThan(0.1)
  })
})

describe('cancellation', () => {
  it('throws CancelledError when shouldCancel flips', () => {
    let calls = 0
    expect(() =>
      solve(two([0, 0], [10, 0], [0, 1], [0, -1]), { ...DEFAULT_CONSTANTS, maxIter: 20000 }, {
        shouldCancel: () => ++calls > 10,
        ...plainInit,
      }),
    ).toThrow(CancelledError)
  })
})

describe('randomized initialization', () => {
  const setup = two([0, 0], [10, 0], [1, 0], [1, 0])

  it('perturbs interior points perpendicular to the chord and keeps anchors exact', () => {
    const frame = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, { random: () => 0.9 }).frames[0]
    const p = frame.curves[0]
    expect(p[0]).toEqual([0, 0])
    expect(p.at(-1)).toEqual([10, 0])
    expect(p.slice(2, -2).some((q) => Math.abs(q[1]) > 1e-6)).toBe(true)
  })

  it('still satisfies orientation constraints on every frame when randomized', () => {
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 300 }, { random: () => 0.1 })
    for (const frame of result.frames) {
      expect(frame.curves[0][1][1]).toBeCloseTo(0, 9)
      expect(frame.curves[0].at(-2)![1]).toBeCloseTo(0, 9)
    }
  })
})

describe('frame buffer', () => {
  const buf = (i: number): Frame => ({ i, ke: 0, curves: [] })

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

describe('multiple curves', () => {
  it('reports per-curve point counts and solves each curve independently', () => {
    const setup: Setup = {
      resolution: 1,
      curves: [
        { fixPoints: [fp([0, 0]), fp([3, 0])], spans: [[]] },
        { fixPoints: [fp([0, 5]), fp([6, 5])], spans: [[]] },
      ],
    }
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 5 }, plainInit)
    expect(result.meta.curveCount).toBe(2)
    expect(result.meta.curvePointCounts).toEqual([4, 7])
    expect(result.meta.N).toBe(11)
  })

  it('previewPose matches the solved frame 0', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([4, 2]), fp([8, 0], [0, -1])], 1)
    const result = solve(setup, { ...DEFAULT_CONSTANTS, maxIter: 1 }, plainInit)
    expect(previewPose(setup)).toEqual(result.frames[0].curves)
  })
})

describe('target path length', () => {
  it('drives the curve toward the target total length', () => {
    const setup = chain([fp([0, 0], [0, 1]), fp([0, 0], [0, -1])], 1, { targetLength: 12 })
    const p = last(setup, { ...fast, maxIter: 40000 })
    const total = segLens(p).reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(10)
    expect(total).toBeLessThan(13)
  })

  it('produces identical frames when targetLength is null vs absent', () => {
    const a = solve(chain([fp([0, 0]), fp([4, 0])], 1, { targetLength: null }), { ...DEFAULT_CONSTANTS, maxIter: 20 }, plainInit)
    const b = solve(chain([fp([0, 0]), fp([4, 0])], 1), { ...DEFAULT_CONSTANTS, maxIter: 20 }, plainInit)
    expect(a.frames).toEqual(b.frames)
  })
})

describe('progress tracking', () => {
  it('exposes a running cap just below completion', () => {
    expect(MAX_RUNNING_PROGRESS).toBeGreaterThan(0.9)
    expect(MAX_RUNNING_PROGRESS).toBeLessThan(1)
  })

  it('starts at zero and uses frame progress when energy is flat', () => {
    const tracker = new ProgressTracker(0.001)
    expect(tracker.progress(0, 100)).toBe(0)
    tracker.observe(5)
    expect(tracker.progress(25, 100)).toBeCloseTo(0.25, 12)
  })

  it('rises as the envelope falls from a peak, then jumps on a new peak', () => {
    const tracker = new ProgressTracker(0.5)
    tracker.observe(2)
    expect(tracker.progress(0, 100)).toBe(0)
    tracker.observe(0)
    expect(tracker.progress(0, 100)).toBeCloseTo(0.5, 12)
    tracker.observe(4)
    expect(tracker.progress(0, 100)).toBe(0)
  })

  it('never reports 100% while the run is still going', () => {
    const tracker = new ProgressTracker(1)
    tracker.observe(1)
    for (let k = 0; k < 50; k++) tracker.observe(0)
    expect(tracker.progress(0, 1)).toBe(MAX_RUNNING_PROGRESS)
    expect(tracker.progress(1_000_000, 1)).toBe(MAX_RUNNING_PROGRESS)
  })

  it('is monotonic and only reaches 1.0 in the final sample', () => {
    const setup = two([0, 0], [0, 0], [0, 1], [0, -1])
    const samples: { progress: number; iteration: number }[] = []
    const result = solve(setup, DEFAULT_CONSTANTS, {
      onProgress: (progress, iteration) => samples.push({ progress, iteration }),
      ...plainInit,
    })

    expect(result.meta.termination).toBe('ke')
    expect(samples.length).toBeGreaterThan(1)

    const last = samples[samples.length - 1]
    expect(last.progress).toBe(1)
    expect(last.iteration).toBe(result.meta.iterations)

    for (const sample of samples.slice(0, -1)) {
      expect(sample.progress).toBeLessThan(1)
      expect(sample.progress).toBeLessThanOrEqual(MAX_RUNNING_PROGRESS + 1e-9)
    }
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k].progress).toBeGreaterThanOrEqual(samples[k - 1].progress)
    }
  })
})
