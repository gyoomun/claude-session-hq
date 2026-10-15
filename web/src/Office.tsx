// 업무별 보기를 가상 사무실로 그린다. 업무 하나 = 방 하나, 미배치 = 로비, 세션 하나 = 책상과 사람.
// 책상은 끌어서 방 안에서 자리를 옮기거나 다른 방(업무)으로 옮긴다. 누르면 작업 보기에서 그 세션을 연다.
import { useEffect, useRef, useState } from 'react'
import { Box, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { api, toast } from './store'
import { pick, setUI } from './ui'
import type { Session, Snapshot, Task } from './types'
import { COLOR, LABEL, Since, bySt, cssColor, lastOf, sessOf, stale, taskStatus, tname, waiting } from './util'
import { StatePill } from './parts'
import { deskSvg } from './Desk'

const SLOT_W = 150, SLOT_H = 136 // 책상 한 칸 크기(px)

// 저장된 자리가 없는 책상은 빈 칸에 차례로 앉힌다
function place(ss: Session[], layout: Snapshot['layout'], cols: number) {
  const rows = Math.max(1, Math.ceil(ss.length / cols))
  const slot = (i: number) => ({ x: (i % cols + 0.5) / cols, y: (Math.floor(i / cols) + 0.5) / rows })
  const pos = new Map<string, { x: number; y: number }>()
  const used: { x: number; y: number }[] = []
  for (const s of ss) if (layout[s.sid]) { pos.set(s.sid, layout[s.sid]); used.push(layout[s.sid]) }
  let i = 0
  for (const s of ss) {
    if (pos.has(s.sid)) continue
    let p = slot(i++)
    while (i < cols * rows * 2 && used.some(u => Math.abs(u.x - p.x) < 0.5 / cols && Math.abs(u.y - p.y) < 0.5 / rows)) p = slot(i++)
    pos.set(s.sid, p); used.push(p)
  }
  return { pos, rows }
}

const Plant = () => <svg width="22" height="30" viewBox="0 0 11 15" shapeRendering="crispEdges" aria-hidden="true">
  <rect x="3" y="0" width="5" height="3" fill="#3f9a5b" /><rect x="1" y="2" width="9" height="4" fill="#4cb36a" /><rect x="2" y="6" width="7" height="2" fill="#3f9a5b" />
  <rect x="3" y="8" width="5" height="1" fill="#7b4b2f" /><rect x="2" y="9" width="7" height="6" fill="#a8683f" /></svg>

function Bubble({ s }: { s: Session }) {
  if (!waiting(s)) return null
  return <Box className="hq-bubble" style={{ background: cssColor(s.state) }}>{s.state === 'approval' ? '승인' : '!'}</Box>
}

function DeskSprite({ s, x, y, ghost, onDown }: { s: Session; x: number; y: number; ghost?: boolean; onDown: (e: React.PointerEvent, s: Session) => void }) {
  const tip = <Stack gap={2} maw={280}>
    <Text size="sm" fw={600}>{s.title}</Text>
    <Text size="xs"><Text span c={`${COLOR[s.state]}.4`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} suf="째" /> · {s.cwd}</Text>
    {s.act && <Text size="xs" ff="monospace" c="teal.3">{s.act}</Text>}
    {!s.act && s.msg && <Text size="xs" className="hq-msg" style={{ WebkitLineClamp: 4 }}>{s.msg}</Text>}
    <Text size="xs" c="dimmed">누르면 열고, 끌면 자리를 옮깁니다</Text>
  </Stack>
  return <Tooltip label={tip} multiline withArrow openDelay={250} disabled={ghost}>
    <Box className={'hq-desk' + (s.state === 'idle' ? ' idle' : '')} onPointerDown={e => onDown(e, s)}
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, opacity: ghost ? 0.3 : 1, zIndex: Math.round(y * 100) }}>
      <Bubble s={s} />
      <svg viewBox="0 0 34 32" width={72} height={68} shapeRendering="crispEdges" aria-hidden="true" dangerouslySetInnerHTML={{ __html: deskSvg(s) }} />
      <Text size="xs" fw={600} ta="center" lh={1.3} className="hq-wrap" maw={SLOT_W - 14}>{s.title}</Text>
      <Text fz={11} ta="center" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} /></Text>
    </Box>
  </Tooltip>
}

function Room({ S, t, ss, over, drag, onDown }: {
  S: Snapshot; t: Task | null; ss: Session[]; over: boolean; drag: string; onDown: (e: React.PointerEvent, s: Session) => void
}) {
  const { ref, width } = useElementSize()
  const cols = Math.max(1, Math.floor((width || 600) / SLOT_W))
  const { pos, rows } = place(ss, S.layout, cols)
  const st = t ? taskStatus(S, t) : (ss.some(waiting) ? 'myturn' : 'idle')
  const lobby = !t
  return <Box className={'hq-room' + (lobby ? ' lobby' : '')} style={lobby ? { gridColumn: '1 / -1' } : undefined}>
    {/* 벽: 방 이름표, 상태, 사람 대기 메모 */}
    <Group className="hq-wall" gap="sm" wrap="nowrap" align="flex-start">
      <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
        <Group gap={8} wrap="nowrap">
          <span className="hq-pixel">{lobby ? 'LOBBY' : 'ROOM'}</span>
          <StatePill state={st}>{t ? LABEL[st] : `${ss.length}세션`}</StatePill>
          {t && stale(S, t) && <StatePill state="closed">정체 <Since t={lastOf(S, t)} /></StatePill>}
        </Group>
        {t ? <UnstyledButton onClick={() => setUI({ openTask: t.id })}><Text fw={700} size="lg" className="hq-wrap" lh={1.3}>{t.name}</Text></UnstyledButton>
          : <Text fw={700} size="lg">미배치 세션</Text>}
        <Text size="xs" c="dimmed">{t ? `${t.memo ? t.memo + ' · ' : ''}세션 ${ss.length} · 작업중 ${ss.filter(s => s.state === 'working').length}` : '새로 연 세션은 여기서 시작합니다. 업무 방으로 끌어다 놓으세요.'}</Text>
      </Stack>
      {t && (t.waits.length > 0 || t.next) && <Stack gap={4} style={{ flex: '0 1 220px', minWidth: 0 }}>
        {t.waits.map(w => <Box key={w.id} className="hq-note"><b>{w.who}</b> · {w.what} <span style={{ opacity: .7 }}>(<Since t={w.since} />째)</span></Box>)}
        {t.next && <Box className="hq-note next">다음: {t.next}</Box>}
      </Stack>}
    </Group>
    {/* 바닥: 책상을 놓는 곳 */}
    <Box ref={ref} className={'hq-floor' + (over ? ' over' : '')} data-room={t ? t.id : ''} style={{ height: rows * SLOT_H + 24 }}>
      <Box className="hq-plant" style={{ left: 6, bottom: 4 }}><Plant /></Box>
      <Box className="hq-plant" style={{ right: 6, bottom: 4 }}><Plant /></Box>
      {!ss.length && <Text size="sm" c="dimmed" className="hq-empty">빈 방입니다. 세션을 끌어다 놓으세요.</Text>}
      {ss.map(s => { const p = pos.get(s.sid)!; return <DeskSprite key={s.sid} s={s} x={p.x} y={p.y} ghost={drag === s.sid} onDown={onDown} /> })}
    </Box>
  </Box>
}

export function Office({ S }: { S: Snapshot }) {
  const [drag, setDrag] = useState<{ s: Session; sx: number; sy: number; x: number; y: number; dx: number; dy: number; moved: boolean } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const ref = useRef(drag)
  ref.current = drag
  const onDown = (e: React.PointerEvent, s: Session) => {
    if (e.button !== 0) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDrag({ s, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), moved: false })
  }
  const roomAt = (x: number, y: number) => document.elementsFromPoint(x, y).find(el => (el as HTMLElement).dataset?.room !== undefined) as HTMLElement | undefined
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const d = ref.current!
      const moved = d.moved || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5
      setDrag({ ...d, x: e.clientX, y: e.clientY, moved })
      if (moved) setOver(roomAt(e.clientX, e.clientY)?.dataset.room ?? null)
    }
    const up = async (e: PointerEvent) => {
      const d = ref.current!
      setDrag(null); setOver(null)
      if (!d.moved) { pick(d.s.sid); return }
      const el = roomAt(e.clientX, e.clientY)
      if (!el) return
      const r = el.getBoundingClientRect()
      // 책상 가운데가 놓인 자리를 방 안 비율로 저장한다
      const body: Record<string, unknown> = { sid: d.s.sid, x: (e.clientX - d.dx - r.left) / r.width, y: (e.clientY - d.dy - r.top) / r.height }
      const task = el.dataset.room || ''
      if (task !== d.s.task) body.task = task
      if (await api('layout', body) && 'task' in body) toast(task ? `"${tname(S, task)}" 방으로 옮겼습니다.` : '로비(미배치)로 옮겼습니다.')
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up, { once: true })
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
  }, [drag?.s.sid])

  return <Box className="hq-office" style={{ userSelect: drag ? 'none' : undefined }}>
    {S.tasks.map(t => <Room key={t.id} S={S} t={t} ss={sessOf(S, t)} over={over === t.id} drag={drag?.moved ? drag.s.sid : ''} onDown={onDown} />)}
    <Room S={S} t={null} ss={S.sessions.filter(s => !s.task).sort(bySt)} over={over === ''} drag={drag?.moved ? drag.s.sid : ''} onDown={onDown} />
    {drag?.moved && <Box className="hq-desk dragging" style={{ position: 'fixed', left: drag.x - drag.dx, top: drag.y - drag.dy }}>
      <svg viewBox="0 0 34 32" width={72} height={68} shapeRendering="crispEdges" aria-hidden="true" dangerouslySetInnerHTML={{ __html: deskSvg(drag.s) }} />
      <Text size="xs" fw={600} ta="center" maw={SLOT_W - 14} className="hq-wrap">{drag.s.title}</Text>
    </Box>}
  </Box>
}
