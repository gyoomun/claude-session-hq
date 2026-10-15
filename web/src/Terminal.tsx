// 웹 터미널: 서버가 tmux 세션에 붙인 pty의 출력은 SSE로 받고, 키 입력은 차례대로 POST로 보낸다
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { HDR } from './store'

export function TerminalView({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 2000,
      macOptionClickForcesSelection: true, allowProposedApi: true,
      theme: { background: '#0b0f1a', foreground: '#e7ebf5', cursor: '#a3b6ff', selectionBackground: '#3a4a7a' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try { fit.fit() } catch { /* 아직 크기가 없을 때 */ }
    let id: string | null = null, q = '', busy = false
    const send = async () => {
      if (busy || !q || !id) return
      busy = true
      const data = q; q = ''
      try { await fetch('/api/term/input', { method: 'POST', headers: HDR, body: JSON.stringify({ id, data }) }) } catch { /* 다음 입력 때 다시 */ }
      busy = false
      if (q) send()
    }
    const es = new EventSource(`/api/term/stream?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`)
    es.addEventListener('ready', e => { id = (e as MessageEvent).data; send() })
    es.onmessage = e => term.write(JSON.parse(e.data))
    es.addEventListener('end', () => { es.close(); term.write('\r\n\x1b[2m[세션이 끝났습니다]\x1b[0m\r\n') })
    const onData = term.onData(d => { q += d; send() })
    const onResize = term.onResize(({ cols, rows }) => {
      if (id) fetch('/api/term/resize', { method: 'POST', headers: HDR, body: JSON.stringify({ id, cols, rows }) })
    })
    // 숨겨진 상태에서 크기를 맞추면 tmux 창이 아주 작아지므로, 보일 때만 맞춘다
    const ro = new ResizeObserver(() => { if (el.clientWidth > 100 && el.clientHeight > 60) try { fit.fit() } catch { /* 무시 */ } })
    ro.observe(el)
    term.focus()
    return () => { es.close(); ro.disconnect(); onData.dispose(); onResize.dispose(); term.dispose() }
  }, [name])
  return <div ref={ref} className="hq-term" />
}
