import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Proto } from './Proto'
import './proto.css'

const root = document.getElementById('root')
if (!root) throw new Error('stage prototype: #root missing from index.html')
createRoot(root).render(
  <StrictMode>
    <Proto />
  </StrictMode>
)
