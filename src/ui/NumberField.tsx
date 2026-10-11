import { useEffect, useId, useRef, useState } from 'react'
import './fields.css'

export interface NumberFieldProps {
  label: string
  value: number
  onChange: (value: number) => void
  /** Increment applied by the − / + buttons. Omit to hide them. */
  step?: number
  integer?: boolean
  min?: number
  max?: number
  hint?: string
  error?: string | null
  disabled?: boolean
  placeholder?: string
}

function format(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/** Returns undefined for empty / incomplete edits (e.g. "-", "1."). */
function parse(text: string): number | undefined {
  const trimmed = text.trim()
  if (
    trimmed === '' ||
    trimmed === '-' ||
    trimmed === '+' ||
    trimmed === '.' ||
    trimmed === '-.' ||
    trimmed === '+.'
  ) {
    return undefined
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clamp(value: number, min?: number, max?: number, integer?: boolean): number {
  let next = value
  if (integer) next = Math.round(next)
  if (min !== undefined) next = Math.max(min, next)
  if (max !== undefined) next = Math.min(max, next)
  return next
}

/**
 * A small controlled numeric input with an optional step stepper, inline hint,
 * and inline error. Keeps an internal text draft so partial edits like "0."
 * are not clobbered, while still normalizing on blur and on external resets.
 */
export function NumberField({
  label,
  value,
  onChange,
  step,
  integer = false,
  min,
  max,
  hint,
  error,
  disabled = false,
  placeholder,
}: NumberFieldProps) {
  const inputId = useId()
  const [draft, setDraft] = useState(() => format(value))
  // True while the change originated from this field, so the sync effect does
  // not overwrite the user's in-progress draft.
  const internal = useRef(false)

  useEffect(() => {
    if (internal.current) {
      internal.current = false
      return
    }
    setDraft(format(value))
  }, [value])

  const commit = (text: string) => {
    setDraft(text)
    const parsed = parse(text)
    if (parsed === undefined) return
    const next = clamp(parsed, min, max, integer)
    if (next !== parsed) setDraft(format(next))
    internal.current = true
    onChange(next)
  }

  const nudge = (direction: 1 | -1) => {
    if (step === undefined) return
    const base = Number.isFinite(value) ? value : 0
    const next = clamp(base + direction * step, min, max, integer)
    internal.current = true
    setDraft(format(next))
    onChange(next)
  }

  const describedBy = error ? `${inputId}-error` : undefined

  return (
    <div className="field">
      <div className="field__head">
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
        {hint ? <span className="field__hint">{hint}</span> : null}
      </div>
      <div className="field__control">
        {step !== undefined ? (
          <button
            type="button"
            className="field__step"
            onClick={() => nudge(-1)}
            disabled={disabled}
            aria-label={`Decrease ${label}`}
            title={`Decrease ${label}`}
          >
            −
          </button>
        ) : null}
        <input
          id={inputId}
          className="field__input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => commit(event.target.value)}
          onBlur={() => {
            // Restore the canonical value if the field was left incomplete.
            if (parse(draft) === undefined) setDraft(format(value))
          }}
        />
        {step !== undefined ? (
          <button
            type="button"
            className="field__step"
            onClick={() => nudge(1)}
            disabled={disabled}
            aria-label={`Increase ${label}`}
            title={`Increase ${label}`}
          >
            +
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="field__error" id={describedBy}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

export default NumberField
