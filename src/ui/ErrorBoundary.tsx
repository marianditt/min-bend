import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional hard reset (clears the saved setup). */
  onReset?: () => void
  title?: string
}

interface State {
  error: Error | null
}

/** Keeps a render error from unmounting the whole app (the "black screen"). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error caught by boundary', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="wiz-error" role="alert">
        <h2>{this.props.title ?? 'Something went wrong on this page'}</h2>
        <p>Your work is safe. You can try this page again, or start over with the example setup.</p>
        <pre className="wiz-error__detail">{error.message}</pre>
        <div className="wiz-row">
          <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          {this.props.onReset ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                this.props.onReset?.()
                this.setState({ error: null })
              }}
            >
              Start over
            </button>
          ) : null}
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
