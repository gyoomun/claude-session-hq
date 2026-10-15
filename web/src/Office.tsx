// 업무별 보기를 회사 하나(가상 사무실)로 그린다. 업무 하나 = 방 하나, 미배치 = 로비, 배치된 세션 = 책상과 사람, 미배치 세션 = 서 있는 사람.
// 방은 그림판처럼 칸(24px) 위에 자유롭게 놓는다: 이름표를 끌면 옮기고, 오른쪽 아래 모서리를 끌면 크기를 바꾼다.
// 책상은 끌어서 방 안에서 자리를 옮기거나 다른 방(업무)으로 옮긴다. 누르면 작업 보기에서 그 세션을 연다.
import { useEffect, useRef, useState } from 'react'
import { Box, Button, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { useElementSize } from '@mantine/hooks'
import { api, toast } from './store'
import { pick, setUI } from './ui'
import type { Rect, Session, Snapshot, Task } from './types'
import { COLOR, LABEL, Since, bySt, cssColor, lastOf, sessOf, stale, taskStatus, tname, waiting } from './util'
import { StatePill } from './parts'
import { deskSvg, standSvg } from './Desk'

const spriteSvg = (s: Session) => s.task ? deskSvg(s) : standSvg(s)

const SLOT_W = 150, SLOT_H = 136 // 책상 한 칸 크기(px)
const CELL = 24 // 방을 놓는 칸 크기(px). 방 자리·크기는 이 칸 단위로 저장한다
const MIN_W = 10, MIN_H = 6

// 저장된 자리가 없는 방은 저장된 방들 아래에 한 줄에 둘(넓으면 셋)씩, 로비는 맨 아래 전체 폭으로 놓는다. 높이는 책상이 다 들어가게
function arrange(S: Snapshot, cols: number) {
  const out: Record<string, Rect> = {}
  const need = (n: number, w: number) => Math.max(MIN_H, Math.ceil((100 + Math.ceil(Math.max(1, n) / Math.max(1, Math.floor(w * CELL / SLOT_W))) * SLOT_H + 24) / CELL))
  const bottom = () => Math.max(1, ...Object.values(out).map(r => r.y + r.h + 1))
  for (const id of [...S.tasks.map(t => t.id), 'lobby']) if (S.rooms?.[id]) out[id] = S.rooms[id]
  const k = Math.max(1, Math.floor((cols - 1) / 21)), w = Math.max(MIN_W, Math.floor((cols - 1) / k) - 1)
  let cx = 1, cy = bottom(), rowH = 0
  for (const t of S.tasks) if (!out[t.id]) {
    if (cx > 1 && cx + w > cols - 1) { cx = 1; cy += rowH + 1; rowH = 0 }
    const h = need(sessOf(S, t).length, w)
    out[t.id] = { x: cx, y: cy, w, h }; cx += w + 1; rowH = Math.max(rowH, h)
  }
  if (!out.lobby) { const lw = Math.max(MIN_W, cols - 2); out.lobby = { x: 1, y: bottom(), w: lw, h: need(S.sessions.filter(s => !s.task).length, lw) } }
  return out
}

// 저장된 자리가 없는 책상은 빈 칸에 차례로 앉힌다
function place(ss: Session[], layout: Snapshot['layout'], cols: number) {
  const rows = Math.max(1, Math.ceil(ss.length / cols))
  const slot = (i: number) => ({ x: (i % cols + 0.5) / cols, y: (Math.floor(i / cols) + 0.5) / rows })
  const pos = new Map<number, { x: number; y: number }>() // 프로세스(pid) 기준: 같은 대화가 둘로 돌 때도 겹치지 않게
  const used: { x: number; y: number }[] = []
  for (const s of ss) if (layout[s.sid] && ![...pos.values()].includes(layout[s.sid])) { pos.set(s.pid, layout[s.sid]); used.push(layout[s.sid]) }
  let i = 0
  for (const s of ss) {
    if (pos.has(s.pid)) continue
    let p = slot(i++)
    while (i < cols * rows * 2 && used.some(u => Math.abs(u.x - p.x) < 0.5 / cols && Math.abs(u.y - p.y) < 0.5 / rows)) p = slot(i++)
    pos.set(s.pid, p); used.push(p)
  }
  return { pos }
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
      <svg viewBox="0 0 34 32" width={72} height={68} shapeRendering="crispEdges" aria-hidden="true" dangerouslySetInnerHTML={{ __html: spriteSvg(s) }} />
      <Text size="xs" fw={600} ta="center" lh={1.3} className="hq-wrap" maw={SLOT_W - 14}>{s.title}</Text>
      <Text fz={11} ta="center" c="dimmed"><Text span c={`${COLOR[s.state]}.5`} fw={600}>{LABEL[s.state]}</Text> <Since t={s.since} /></Text>
    </Box>
  </Tooltip>
}

function Room({ S, t, ss, r, editing, over, drag, onDown, onEdit }: {
  S: Snapshot; t: Task | null; ss: Session[]; r: Rect; editing: boolean; over: boolean; drag: string
  onDown: (e: React.PointerEvent, s: Session) => void; onEdit: (e: React.PointerEvent, kind: 'move' | 'size') => void
}) {
  const { ref, width } = useElementSize()
  const cols = Math.max(1, Math.floor((width || 600) / SLOT_W))
  const { pos } = place(ss, S.layout, cols)
  const st = t ? taskStatus(S, t) : (ss.some(waiting) ? 'myturn' : 'idle')
  const lobby = !t
  return <Box className={'hq-room' + (lobby ? ' lobby' : '') + (editing ? ' editing' : '')}
    style={{ left: r.x * CELL, top: r.y * CELL, width: r.w * CELL, height: r.h * CELL, zIndex: editing ? 5 : 1 }}>
    {/* 벽: 방 이름표, 상태, 사람 대기 메모. 끌면 방을 옮긴다 */}
    <Group className="hq-wall" gap="sm" wrap="nowrap" align="flex-start" onPointerDown={e => onEdit(e, 'move')}>
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
    <Box ref={ref} className={'hq-floor' + (over ? ' over' : '')} data-room={t ? t.id : ''}>
      <Box className="hq-plant" style={{ left: 6, bottom: 4 }}><Plant /></Box>
      <Box className="hq-plant" style={{ right: 6, bottom: 4 }}><Plant /></Box>
      {!ss.length && <Text size="sm" c="dimmed" className="hq-empty">빈 방입니다. 세션을 끌어다 놓으세요.</Text>}
      {ss.map(s => { const p = pos.get(s.pid)!; return <DeskSprite key={s.pid} s={s} x={p.x} y={p.y} ghost={drag === s.sid} onDown={onDown} /> })}
    </Box>
    <Box className="hq-grip" onPointerDown={e => onEdit(e, 'size')} aria-label="방 크기 바꾸기" />
  </Box>
}

export function Office({ S }: { S: Snapshot }) {
  const { ref: canvas, width } = useElementSize()
  // useElementSize는 테두리까지 잰다. 바깥벽(.hq-office 테두리 4px × 2)을 빼야 오른쪽 끝에 붙인 방이 넘치지 않는다
  const cols = Math.max(MIN_W + 2, Math.floor(((width || 1200) - 8) / CELL))
  const [edit, setEdit] = useState<{ id: string; kind: 'move' | 'size'; sx: number; sy: number; orig: Rect; r: Rect; moved: boolean } | null>(null)
  const editRef = useRef(edit)
  editRef.current = edit
  // 놓은 뒤 서버 상태에 반영될 때까지는 놓은 자리를 그대로 보인다(안 그러면 옛 자리로 한 번 튀었다 돌아온다)
  const [pending, setPending] = useState<Record<string, Rect> | null>(null)
  const rects = { ...arrange(S, cols), ...pending }
  if (edit) rects[edit.id] = edit.r
  const moved = useRef(false) // 방을 끈 직후의 클릭(이름표 누르기)은 무시한다
  const onEdit = (id: string) => (e: React.PointerEvent, kind: 'move' | 'size') => {
    if (e.button !== 0) return
    e.stopPropagation()
    setEdit({ id, kind, sx: e.clientX, sy: e.clientY, orig: rects[id], r: rects[id], moved: false })
  }
  useEffect(() => {
    if (!edit) return
    const move = (e: PointerEvent) => {
      const d = editRef.current!
      const dx = Math.round((e.clientX - d.sx) / CELL), dy = Math.round((e.clientY - d.sy) / CELL), o = d.orig
      const r = d.kind === 'move'
        ? { ...o, x: Math.max(0, Math.min(cols - o.w, o.x + dx)), y: Math.max(0, o.y + dy) }
        : { ...o, w: Math.max(MIN_W, Math.min(cols - o.x, o.w + dx)), h: Math.max(MIN_H, o.h + dy) }
      setEdit({ ...d, r, moved: d.moved || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5 })
    }
    const up = () => {
      const d = editRef.current!
      setEdit(null)
      if (!d.moved) return
      moved.current = true; setTimeout(() => { moved.current = false }, 0)
      const next = { ...rects, [d.id]: d.r }
      setPending(next)
      api('rooms', { rooms: next }).then(() => setPending(null)) // api가 새 상태를 먼저 넣고 끝난다
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up, { once: true })
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
  }, [edit?.id, edit?.kind])
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

  const height = Math.max(...Object.values(rects).map(r => r.y + r.h)) + 1
  const right = Math.max(...Object.values(rects).map(r => r.x + r.w))
  const dragged = drag?.moved ? drag.s.sid : ''
  return <Stack gap={8}>
    <Group justify="space-between" gap="xs">
      <Text size="xs" c="dimmed">방 이름표를 끌면 옮기고, 오른쪽 아래 모서리를 끌면 크기를 바꿉니다. 책상은 끌어서 자리나 방을 옮깁니다.</Text>
      {Object.keys(S.rooms || {}).length > 0 && <Button size="compact-xs" variant="subtle" color="gray" onClick={() => api('rooms', { reset: true })}>방 자동 배치로 되돌리기</Button>}
    </Group>
    <Box ref={canvas} className="hq-office" style={{ height: height * CELL, minWidth: right * CELL, userSelect: drag || edit ? 'none' : undefined }}
      onClickCapture={e => { if (moved.current) { e.stopPropagation(); e.preventDefault() } }}>
      {S.tasks.map(t => <Room key={t.id} S={S} t={t} ss={sessOf(S, t)} r={rects[t.id]} editing={edit?.id === t.id} over={over === t.id} drag={dragged} onDown={onDown} onEdit={onEdit(t.id)} />)}
      <Room S={S} t={null} ss={S.sessions.filter(s => !s.task).sort(bySt)} r={rects.lobby} editing={edit?.id === 'lobby'} over={over === ''} drag={dragged} onDown={onDown} onEdit={onEdit('lobby')} />
    </Box>
    {drag?.moved && <Box className="hq-desk dragging" style={{ position: 'fixed', left: drag.x - drag.dx, top: drag.y - drag.dy }}>
      <svg viewBox="0 0 34 32" width={72} height={68} shapeRendering="crispEdges" aria-hidden="true" dangerouslySetInnerHTML={{ __html: spriteSvg(drag.s) }} />
      <Text size="xs" fw={600} ta="center" maw={SLOT_W - 14} className="hq-wrap">{drag.s.title}</Text>
    </Box>}
  </Stack>
}
