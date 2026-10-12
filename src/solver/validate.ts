import { EPS_STABILIZE, type ProblemInput } from './types'

/** A single, field-targeted validation problem. */
export interface ValidationIssue {
  field: 'n' | 'start' | 'end' | 'startDir' | 'endDir' | 'general'
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

/**
 * Validate a problem definition. Returns an empty array when the input is
 * solvable. Rules (fixed stabilization threshold EPS_STABILIZE = 1e-3):
 *  - n is an integer >= 2
 *  - all coordinates are finite
 *  - start/end orientations are non-zero vectors
 *  - drawnPts entries (when present) are finite [x,y] pairs
 */
export function validateInput(input: ProblemInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const { n, start, end, startDir, endDir, drawnPts } = input

  if (!Number.isInteger(n) || n < 2) {
    issues.push({ field: 'n', message: 'Number of points must be an integer ≥ 2.' })
  }

  if (!isFiniteVec(start)) {
    issues.push({ field: 'start', message: 'Start point must be two finite numbers.' })
  }
  if (!isFiniteVec(end)) {
    issues.push({ field: 'end', message: 'End point must be two finite numbers.' })
  }
  if (!isFiniteVec(startDir)) {
    issues.push({ field: 'startDir', message: 'Start orientation must be two finite numbers.' })
  }
  if (!isFiniteVec(endDir)) {
    issues.push({ field: 'endDir', message: 'End orientation must be two finite numbers.' })
  }

  if (isFiniteVec(startDir) && Math.hypot(startDir[0], startDir[1]) <= EPS_STABILIZE) {
    issues.push({
      field: 'startDir',
      message: `Start orientation must be a non-zero vector (length > ${EPS_STABILIZE}).`,
    })
  }
  if (isFiniteVec(endDir) && Math.hypot(endDir[0], endDir[1]) <= EPS_STABILIZE) {
    issues.push({
      field: 'endDir',
      message: `End orientation must be a non-zero vector (length > ${EPS_STABILIZE}).`,
    })
  }

  // Validate drawnPts entries when present
  if (Array.isArray(drawnPts)) {
    for (let i = 0; i < drawnPts.length; i++) {
      if (!isFiniteVec(drawnPts[i])) {
        issues.push({
          field: 'general',
          message: `Drawn point ${i} must be a finite [x, y] pair.`,
        })
      }
    }
  }

  return issues
}
