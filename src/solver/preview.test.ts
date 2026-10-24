import { describe, expect, it } from 'vitest'
import { previewLayout } from './solve'
import { DEFAULT_SETUP } from '../ui/defaults'
import type { Setup } from './types'

function rng(seed: number) {
  let s = seed
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
}

function randomSetup(r: () => number): Setup {
  const n = 1 + Math.floor(r() * 3)
  let id = 0
  const curves = Array.from({ length: n }, () => {
    const pts = 2 + Math.floor(r() * 3)
    return {
      fixPoints: Array.from({ length: pts }, () => ({
        id: `p${++id}`,
        pos: [Math.round((r() - 0.5) * 20), Math.round((r() - 0.5) * 20)] as [number, number],
        orientation: r() < 0.5 ? ([Math.cos(r() * 6), Math.sin(r() * 6)] as [number, number]) : null,
        ...(r() < 0.3 ? { posFree: true } : {}),
      })),
      spans: Array.from({ length: pts - 1 }, () => [] as [number, number][]),
      targetLength: r() < 0.3 ? Math.round(r() * 30) : null,
    }
  })
  const constraints = []
  for (let i = 0; i < 3; i++) {
    const c = Math.floor(r() * n)
    const d = Math.floor(r() * n)
    const source = curves[c].fixPoints[Math.floor(r() * curves[c].fixPoints.length)].id
    const target = curves[d].fixPoints[Math.floor(r() * curves[d].fixPoints.length)].id
    constraints.push(
      r() < 0.5
        ? { kind: 'position' as const, source, target, delta: [r() - 0.5, r() - 0.5] as [number, number] }
        : { kind: 'orientation' as const, source, target, delta: r() * 90 },
    )
  }
  return { curves, constraints, resolution: 0.5 + r() * 2 }
}

describe('previewLayout', () => {
  it('never throws and control indices always address the returned polylines', () => {
    const r = rng(7)
    for (let i = 0; i < 400; i++) {
      const setup = randomSetup(r)
      const layout = previewLayout(setup)
      expect(layout.controlIndices).toHaveLength(layout.curves.length)
      layout.curves.forEach((pts, ci) => {
        for (const idx of layout.controlIndices[ci]) {
          expect(pts[idx], `curve ${ci} index ${idx}`).toBeDefined()
          expect(pts[idx].every(Number.isFinite)).toBe(true)
        }
      })
    }
  })

  it('survives garbage setups', () => {
    const bad = { curves: [{ fixPoints: [{ pos: [NaN, 1], orientation: null }], spans: [] }], resolution: -1 } as unknown as Setup
    expect(() => previewLayout(bad)).not.toThrow()
    expect(() => previewLayout({ curves: [], resolution: 1 })).not.toThrow()
    expect(previewLayout(DEFAULT_SETUP).curves.length).toBe(1)
  })
})
