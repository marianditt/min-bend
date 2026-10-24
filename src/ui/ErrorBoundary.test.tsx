// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(cleanup)

let shouldThrow = true
function Bomb() {
  if (shouldThrow) throw new Error('boom')
  return <p>fine</p>
}

describe('ErrorBoundary', () => {
  it('shows a recoverable message instead of unmounting, and recovers on retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    shouldThrow = true
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('boom')
    shouldThrow = false
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByText('fine')).toBeTruthy()
  })

  it('offers Start over when a reset handler is given', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    shouldThrow = true
    const onReset = vi.fn(() => {
      shouldThrow = false
    })
    render(
      <ErrorBoundary onReset={onReset}>
        <Bomb />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByText('Start over'))
    expect(onReset).toHaveBeenCalled()
    expect(screen.getByText('fine')).toBeTruthy()
  })
})
