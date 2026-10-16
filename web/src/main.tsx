import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import './index.css'
import { App } from './App'
import { useUI } from './ui'

// 알림 자리는 환경설정에서 고른다. Mantine은 양옆 가운데 자리가 없어서 위쪽 왼·오른 자리를 세로 가운데로 내린다(index.css, html data-toast)
function Toasts() {
  const { toast } = useUI()
  return <Notifications position={toast === 'left-center' ? 'top-left' : toast === 'right-center' ? 'top-right' : toast} />
}

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
      <Toasts />
      <App />
    </MantineProvider>
  </StrictMode>,
)
