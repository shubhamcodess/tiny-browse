import '@fontsource-variable/geist'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Docs from './Docs'
import { openExternalLinksInNewTab } from './externalLinks'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Docs />
  </StrictMode>,
)

openExternalLinksInNewTab()
