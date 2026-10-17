import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider, Modal, createTheme } from '@mantine/core'
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
  // 가운데 창: 화면 가운데에, 배경막은 연하게, 여백·제목은 작게(확인창이 무겁고 답답해 보인다: 사용자 요청)
  components: {
    Modal: Modal.extend({
      defaultProps: { centered: true, padding: 'sm', overlayProps: { backgroundOpacity: 0.3 } },
      styles: { title: { fontSize: 'var(--mantine-font-size-sm)', fontWeight: 600 }, header: { minHeight: 0, paddingBottom: 14 } },
    }),
  },
  // 내 차례(일 다 끝남) 색. teal은 파랗고 쨍해서 목록에 많이 깔리면 눈이 아프다: 채도를 낮춘 세이지 초록
  colors: { sage: ['#eef5ef', '#dde9df', '#bcd4c0', '#9cbfa2', '#84ae8b', '#73a17b', '#63906b', '#537b5a', '#44664a', '#34513a'] },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Toasts />
      <App />
    </MantineProvider>
  </StrictMode>,
)
