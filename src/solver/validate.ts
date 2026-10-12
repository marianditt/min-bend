import { EPS_STABILIZE, type Setup } from './types'

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
 *  - each curve's `n` is an integer >= 0
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

  curves.forEach((curve, ci) => {
    const label = `Curve ${ci + 1}`

    if (!Number.isInteger(curve.n) || curve.n < 0) {
      issues.push({ field: `n:${ci}`, message: `${label}: interior points must be an integer ≥ 0.` })
    }

    const target = curve.targetLength
    if (target !== null && target !== undefined && (!Number.isFinite(target) || target <= 0)) {
      issues.push({
        field: `targetLength:${ci}`,
        message: `${label}: target path length must be a positive number (or leave it unset).`,
      })
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
