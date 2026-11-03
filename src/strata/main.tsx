import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('strata: #root missing from index.html')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
