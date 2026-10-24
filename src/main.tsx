import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { clearState } from './lib/storage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary title="The app hit a problem" onReset={clearState}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
