import { getCurrentWindow } from '@tauri-apps/api/window'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Panel } from './Panel'
import { Settings } from './Settings'
import './styles.css'

const label = getCurrentWindow().label
document.body.dataset['window'] = label

createRoot(document.getElementById('root')!).render(
  <StrictMode>{label === 'panel' ? <Panel /> : <Settings />}</StrictMode>,
)
