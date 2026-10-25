// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import App from './App'

beforeEach(() => {
  localStorage.clear()
  // jsdom has no canvas; the editor must tolerate that.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('wizard', () => {
  it('walks through the steps without crashing and keeps Result locked until a run exists', () => {
    render(<App />)
    expect(screen.getByText('Where must the curve go?')).toBeTruthy()
    fireEvent.click(screen.getByText(/Next: Sketch/))
    expect(screen.getByText('Sketch a rough route')).toBeTruthy()
    fireEvent.click(screen.getByText(/Review & solve/))
    expect(screen.getByText('Check and solve')).toBeTruthy()
    expect((screen.getByText(/View result/).closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/Segment stiffness/)).toBeNull()
  })

  it('blocks Solve and points to the problem when the setup is invalid', () => {
    render(<App />)
    fireEvent.click(screen.getByText(/Next: Sketch/))
    fireEvent.click(screen.getByText(/Review & solve/))
    const solve = screen.getByText('Solve', { selector: '.btn--lg' }) as HTMLButtonElement
    expect(solve.disabled).toBe(false)
  })

  it('lets a point follow a different point on its own curve, but not itself', () => {
    render(<App />)
    const follows = screen.getAllByLabelText('Follows') as HTMLSelectElement[]
    expect(Array.from(follows[0].options).map((option) => option.value)).toEqual(['', 'p2'])
    expect(Array.from(follows[1].options).map((option) => option.value)).toEqual(['', 'p1'])

    fireEvent.change(follows[0], { target: { value: 'p2' } })
    expect(follows[0].value).toBe('p2')
  })

  it('recovers from a corrupt saved state', () => {
    localStorage.setItem('min-bend:state', '{"version":2,"setup":{"curves":"nope"}}')
    render(<App />)
    expect(screen.getByText('Where must the curve go?')).toBeTruthy()
  })
})
