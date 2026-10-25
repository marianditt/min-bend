import { EPS_STABILIZE, type PhysicsConstants, type Setup } from './types'
import { constraintProblems } from './constraints'
import { MAX_SEGMENTS_PER_SPAN, planSpan } from './curve'

/** A single, field-targeted validation problem. */
export interface ValidationIssue {
  field: string
  message: string
}

function isFiniteVec(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isFinite((v as number[])[0]) &&
    Number.isFinite((v as number[])[1])
  )
}

function isNonZeroVec(v: [number, number]): boolean {
  return Math.hypot(v[0], v[1]) > EPS_STABILIZE
}

/**
 * Validate a multi-curve setup. Returns an empty array when the setup is
 * solvable. Rules (fixed stabilization threshold EPS_STABILIZE = 1e-3):
 *  - at least one curve
 *  - each curve has at least 2 fix points
 *  - the global resolution is a positive number that keeps spans manageable
 *  - all fix point positions are finite
 *  - orientations, when present, are finite non-zero vectors
 *  - all user free points are finite [x, y] pairs
 */
export function validateSetup(setup: Setup): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const curves = setup?.curves

  if (!Array.isArray(curves) || curves.length === 0) {
    issues.push({ field: 'curves', message: 'Add at least one curve.' })
    return issues
  }

  const resolutionOk = Number.isFinite(setup.resolution) && setup.resolution > 0
  if (!resolutionOk) {
    issues.push({ field: 'resolution', message: 'Resolution (line length) must be a positive number.' })
  }

  constraintProblems(setup).forEach((p) => {
    issues.push({ field: `constraint:${p.index}`, message: p.message })
  })

  curves.forEach((curve, ci) => {
    const label = `Curve ${ci + 1}`

    const target = curve.targetLength
    if (target !== null && target !== undefined && (!Number.isFinite(target) || target <= 0)) {
      issues.push({
        field: `targetLength:${ci}`,
        message: `${label}: target path length must be a positive number (or leave it unset).`,
      })
    }

    const flat = curve.flatness
    if (flat !== undefined && !(Number.isFinite(flat) && flat >= 0 && flat <= 1)) {
      issues.push({ field: `flatness:${ci}`, message: `${label}: the shortness/flatness balance must be between 0 and 1.` })
    }

    if (!Array.isArray(curve.fixPoints) || curve.fixPoints.length < 2) {
      issues.push({ field: `fixPoints:${ci}`, message: `${label}: needs at least 2 fix points.` })
      return
    }

    curve.fixPoints.forEach((fp, pi) => {
      if (!isFiniteVec(fp.pos)) {
        issues.push({
          field: `fixPoint:${ci}:${pi}`,
          message: `${label}, fix point ${pi + 1}: position must be two finite numbers.`,
        })
      }
      const orient = fp.orientation
      if (orient !== null && orient !== undefined) {
        if (!isFiniteVec(orient)) {
          issues.push({
            field: `orientation:${ci}:${pi}`,
            message: `${label}, fix point ${pi + 1}: orientation must be two finite numbers.`,
          })
        } else if (!isNonZeroVec(orient)) {
          issues.push({
            field: `orientation:${ci}:${pi}`,
            message: `${label}, fix point ${pi + 1}: orientation must be a non-zero vector (length > ${EPS_STABILIZE}).`,
          })
        }
      }
    })

    if (resolutionOk && curve.fixPoints.every((fp) => isFiniteVec(fp.pos) && (!fp.orientation || isFiniteVec(fp.orientation)))) {
      for (let si = 0; si + 1 < curve.fixPoints.length; si++) {
        if (planSpan(curve, si, setup.resolution).overflow) {
          issues.push({
            field: 'resolution',
            message: `${label}, span ${si + 1}: resolution is too small (more than ${MAX_SEGMENTS_PER_SPAN} lines).`,
          })
          break
        }
      }
    }

    if (Array.isArray(curve.spans)) {
      curve.spans.forEach((spanFree, si) => {
        if (!Array.isArray(spanFree)) return
        spanFree.forEach((p, fi) => {
          if (!isFiniteVec(p)) {
            issues.push({
              field: `free:${ci}:${si}:${fi}`,
              message: `${label}, span ${si + 1}: free point ${fi + 1} must be a finite [x, y] pair.`,
            })
          }
        })
      })
    }
  })

  return issues
}

/** Returns a human message when the physics constants are unusable, else null. */
export function validateConstants(c: PhysicsConstants): string | null {
  const named: [string, number][] = [
    ['Friction', c?.friction],
    ['Control point mass', c?.controlMass],
    ['Step size', c?.timeStep],
    ['Rest threshold', c?.restThreshold],
    ['Step limit', c?.maxSteps],
  ]
  for (const [name, value] of named) {
    if (!Number.isFinite(value)) return `${name} must be a finite number.`
  }
  if (c.friction < 0) return 'Friction must be ≥ 0.'
  if (!(c.controlMass > 0)) return 'Control point mass must be > 0.'
  if (!(c.timeStep > 0)) return 'Step size must be > 0.'
  if (c.restThreshold < 0) return 'Rest threshold must be ≥ 0.'
  if (c.maxSteps < 1) return 'Step limit must be ≥ 1.'
  return null
}
