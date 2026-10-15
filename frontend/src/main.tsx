import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/inter-tight'
import './index.css'
import './operations-calendar-pro.css'
import './styles/flat-ui.css'
import App from './App.tsx'
import './styles/color-schemes.css'
import { applyColorScheme } from './lib/colorSchemes'
import { useAuthStore } from './store/authStore'

applyColorScheme(useAuthStore.getState().user?.color_scheme)
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || state.user?.color_scheme !== previous.user?.color_scheme) {
    applyColorScheme(state.user?.color_scheme)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
