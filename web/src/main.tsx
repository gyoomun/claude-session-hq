import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './index.css'
import { App } from './App'

const theme = createTheme({
  primaryColor: 'indigo',
  fontFamily: '"IBM Plex Sans KR", system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
  headings: { fontFamily: '"IBM Plex Sans KR", system-ui, sans-serif' },
  defaultRadius: 'md',
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="bottom-center" />
      <App />
    </MantineProvider>
  </StrictMode>,
)
