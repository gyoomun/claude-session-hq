import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 화면 소스는 web/, 빌드 결과는 dist/. 서버(server.js)가 dist/를 그대로 내준다.
// 개발 중에는 Vite(5173)가 화면을, 서버(7420)가 API·터미널·로그인을 맡는다.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: { '/api': 'http://127.0.0.1:7420', '/auth': 'http://127.0.0.1:7420', '/login': 'http://127.0.0.1:7420' },
  },
})
