// 환경설정 창(IntelliJ 설정 창을 본떴다): 제목줄을 잡고 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다.
// 왼쪽은 검색과 목차(전체·분류), 오른쪽은 늘 모든 분류를 이어서 보인다. 목차를 누르면 그 자리로 스크롤하고, 스크롤하면 목차가 따라온다. 값을 고르는 항목은 [적용]·[확인]을 눌러야 반영되고(바꾼 줄은 왼쪽에 파란 표시),
// 되돌리기·모두 재시작 같은 동작 버튼과 접속 관리는 누르면 바로 실행된다
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Button, CloseButton, Group, SegmentedControl, Stack, Switch, Text, TextInput, UnstyledButton } from '@mantine/core'
import { IconAccessPoint, IconLayoutColumns, IconLayoutList, IconPalette, IconRefresh, IconSearch } from '@tabler/icons-react'
import { api, toast } from './store'
import { resetLayout, setDetail, setMotion, setUI, setView, useUI } from './ui'
import type { Snapshot } from './types'
import { AccessPanel } from './Modals'

interface Draft { view: 'chat' | 'term'; detail: boolean; motion: 'system' | 'on' }
// 분류와 그 안의 항목 글(검색에 쓴다)
const PAGES = [
  { id: 'view', name: '화면', icon: IconPalette, words: '웹 세션 화면 대화 터미널 작업 과정 자세히 도구 움직임 애니메이션 동작 줄이기' },
  { id: 'layout', name: '배치', icon: IconLayoutColumns, words: '칸 높이 너비 핀 메모 btw 세션 목록 즐겨찾기 대화 경계 되돌리기 기본값' },
  { id: 'session', name: '세션', icon: IconRefresh, words: '모두 재시작 웹 세션 CLAUDE.md zshrc' },
  { id: 'access', name: '접속', icon: IconAccessPoint, words: '사내망 접속 인증 메일 로그인 기기 끊기 로그아웃' },
] as const

const Query = createContext('')
const hit = (q: string, text: string) => !q || text.toLowerCase().includes(q.toLowerCase())

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Stack gap={4} mb="lg">
    <Group gap={8} wrap="nowrap"><Text size="xs" fw={600} c="dimmed" style={{ flex: 'none' }}>{title}</Text><Box className="hq-set-rule" /></Group>
    {children}
  </Stack>
}
// 항목 한 줄: 이름·설명 | 조절. 조절 칸은 필요한 만큼 넓어져 잘리지 않는다
function Row({ label, help, changed, children }: { label: string; help?: string; changed?: boolean; children: React.ReactNode }) {
  const q = useContext(Query)
  return <Box className={'hq-set-row' + (changed ? ' changed' : '')} style={{ opacity: hit(q, label + ' ' + (help || '')) ? 1 : .35 }}>
    <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm">{label}</Text>{help && <Text size="xs" c="dimmed">{help}</Text>}</Stack>
    <Box style={{ flex: 'none' }}>{children}</Box>
  </Box>
}

function RestartAll({ S }: { S: Snapshot }) {
  const [confirm, setConfirm] = useState(false)
  const n = S.sessions.filter(s => s.host === 'web').length
  return <Button variant="default" size="xs" color={confirm ? 'red' : undefined} disabled={!n} onBlur={() => setConfirm(false)} onClick={async () => {
    if (!confirm) { setConfirm(true); return }
    setConfirm(false)
    const r = await api<number>('session/restart')
    if (r) toast(`웹 세션 ${r.result}개를 다시 띄웁니다. 대화는 그대로 이어집니다.`)
  }}>{confirm ? `한 번 더 누르면 ${n}개 재시작` : `모두 재시작 (${n}개)`}</Button>
}

function Page({ id, S, d, set, ui }: { id: string; S: Snapshot; d: Draft; set: (p: Partial<Draft>) => void; ui: Draft }) {
  if (id === 'view') return <>
    <Section title="대화 화면">
      <Row label="웹 세션 화면" help="터미널은 Claude Code 화면 그대로입니다" changed={d.view !== ui.view}>
        <SegmentedControl size="xs" value={d.view} onChange={v => set({ view: v as Draft['view'] })} data={[{ label: '대화', value: 'chat' }, { label: '터미널', value: 'term' }]} />
      </Row>
      <Row label="작업 과정 자세히" help="도구 사용을 한 줄로 접지 않고 하나하나 봅니다" changed={d.detail !== ui.detail}>
        <Switch checked={d.detail} onChange={e => set({ detail: e.currentTarget.checked })} aria-label="작업 과정 자세히" />
      </Row>
    </Section>
    <Section title="움직임">
      <Row label="화면 움직임" help="컴퓨터의 '동작 줄이기'가 켜져 있으면 움직임이 꺼집니다. 이 화면만 켜려면 항상 켜기" changed={d.motion !== ui.motion}>
        <SegmentedControl size="xs" value={d.motion} onChange={v => set({ motion: v as Draft['motion'] })} data={[{ label: '컴퓨터 설정 따르기', value: 'system' }, { label: '항상 켜기', value: 'on' }]} />
      </Row>
    </Section>
  </>
  if (id === 'layout') return <Section title="칸 크기">
    <Row label="핀·메모·btw 높이" help="대화 오른쪽 칸 사이 경계를 처음 높이로 되돌립니다">
      <Button size="xs" variant="default" onClick={() => { resetLayout('hq-side'); toast('핀·메모·btw 높이를 처음으로 되돌렸습니다.') }}>기본값으로</Button>
    </Row>
    <Row label="세션 목록·즐겨찾기·대화 너비" help="작업 보기의 세 칸 사이 경계를 처음 너비로 되돌립니다">
      <Button size="xs" variant="default" onClick={() => { resetLayout('hq-work'); toast('목록·즐겨찾기·대화 너비를 처음으로 되돌렸습니다.') }}>기본값으로</Button>
    </Row>
  </Section>
  if (id === 'session') return <Section title="웹 세션">
    <Row label="모두 재시작" help="전역 CLAUDE.md·.zshrc를 바꾼 뒤. 웹 세션을 모두 끄고 같은 대화로 다시 띄웁니다(일하는 중이어도 끊습니다)"><RestartAll S={S} /></Row>
  </Section>
  return <AccessPanel S={S} />
}

export function SettingsWindow({ S }: { S: Snapshot }) {
  const ui = useUI()
  const cur: Draft = { view: ui.view, detail: ui.detail, motion: ui.motion }
  const [d, setD] = useState<Draft>(cur)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const win = useRef<HTMLDivElement>(null)
  // 열 때마다 지금 값으로 시작하고 화면 가운데에 놓는다
  useEffect(() => {
    if (!ui.settings) return
    setD(cur); setQ('')
    const w = Math.min(940, innerWidth - 32), h = Math.min(640, innerHeight - 32)
    setPos({ x: Math.round((innerWidth - w) / 2), y: Math.round((innerHeight - h) / 2) })
  }, [ui.settings])
  const close = () => setUI({ settings: false, settingsPage: 'all' }) // 다음엔 '전체'(맨 위)에서 연다
  const changed = d.view !== ui.view || d.detail !== ui.detail || d.motion !== ui.motion
  const apply = () => {
    if (d.view !== ui.view) setView(d.view)
    if (d.detail !== ui.detail) setDetail(d.detail)
    if (d.motion !== ui.motion) setMotion(d.motion)
  }
  useEffect(() => {
    if (!ui.settings) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); close() } }
    addEventListener('keydown', on, true)
    return () => removeEventListener('keydown', on, true)
  }, [ui.settings])
  // 제목줄을 잡고 옮긴다. 제목줄이 화면 밖으로 나가지 않게 막는다
  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const sx = e.clientX - pos.x, sy = e.clientY - pos.y, w = win.current!.offsetWidth
    const move = (m: PointerEvent) => setPos({ x: Math.min(innerWidth - 80, Math.max(80 - w, m.clientX - sx)), y: Math.min(innerHeight - 40, Math.max(0, m.clientY - sy)) })
    addEventListener('pointermove', move)
    addEventListener('pointerup', () => removeEventListener('pointermove', move), { once: true })
  }
  // 목차: 누르면 그 분류로 스크롤, 스크롤하면 지금 보이는 분류에 불이 들어온다('전체'는 맨 위일 때)
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('all')
  const go = (id: string, smooth = true) => {
    const box = scroller.current, el = box?.querySelector<HTMLElement>(`[data-page="${id}"]`)
    if (!box) return
    const crumb = box.querySelector<HTMLElement>('.hq-set-crumb')?.offsetHeight || 0 // 위에 붙은 경로 줄 밑으로
    box.scrollTo({ top: id === 'all' || !el ? 0 : el.offsetTop - box.offsetTop - crumb, behavior: smooth ? 'smooth' : 'auto' })
  }
  const spy = () => {
    const box = scroller.current
    if (!box) return
    if (box.scrollTop < 8) { setActive('all'); return }
    const top = box.getBoundingClientRect().top + (box.querySelector<HTMLElement>('.hq-set-crumb')?.offsetHeight || 0) + 8
    const el = [...box.querySelectorAll<HTMLElement>('[data-page]')].filter(x => x.getBoundingClientRect().top <= top).pop()
    setActive(el?.dataset.page || 'all')
  }
  // 열 때 고른 분류(예: 머리의 '사내망 접속 꺼짐' → 접속)가 있으면 그 자리에서 시작한다
  useLayoutEffect(() => { if (ui.settings) { go(ui.settingsPage, false); spy() } }, [ui.settings])
  if (!ui.settings) return null
  const pages = PAGES.filter(p => hit(q, p.name + ' ' + p.words))
  const nav = [{ id: 'all', name: '전체', icon: IconLayoutList }, ...pages]
  const name = (nav.find(p => p.id === active) || nav[0]).name
  return createPortal(<Box className="hq-overlay">
    <Box ref={win} className="hq-window" role="dialog" aria-label="환경설정" style={{ left: pos.x, top: pos.y }}>
      <Group className="hq-window-title" justify="space-between" wrap="nowrap" onPointerDown={drag}>
        <Text size="sm" fw={600}>환경설정</Text>
        <CloseButton size="sm" onClick={close} aria-label="닫기" />
      </Group>
      <Box className="hq-window-body">
        <Stack gap={6} className="hq-set-nav">
          <TextInput size="xs" leftSection={<IconSearch size={14} />} placeholder="설정 찾기" value={q} onChange={e => { setQ(e.currentTarget.value); requestAnimationFrame(spy) }} autoFocus />
          {nav.map(p => <UnstyledButton key={p.id} className={'hq-set-cat' + (p.id === active ? ' on' : '')} onClick={() => go(p.id)}>
            <Group gap={8} wrap="nowrap"><p.icon size={16} stroke={1.6} /><Text size="sm">{p.name}</Text></Group>
          </UnstyledButton>)}
          {!pages.length && <Text size="xs" c="dimmed" px={8}>찾는 설정이 없습니다</Text>}
        </Stack>
        <Box className="hq-set-page" ref={scroller} onScroll={spy}>
          <Text size="sm" c="dimmed" className="hq-set-crumb">환경설정 › <Text span c="var(--mantine-color-text)" fw={600}>{name}</Text></Text>
          <Query.Provider value={q}>
            {pages.map(p => <Box key={p.id} data-page={p.id} mb="xl">
              <Text fw={700} mb="sm">{p.name}</Text>
              <Page id={p.id} S={S} d={d} set={x => setD(v => ({ ...v, ...x }))} ui={cur} />
            </Box>)}
          </Query.Provider>
          <Box className="hq-set-spacer" />
        </Box>
      </Box>
      <Group className="hq-window-foot" justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={close}>취소</Button>
        <Button size="xs" variant="default" disabled={!changed} onClick={apply}>적용</Button>
        <Button size="xs" onClick={() => { apply(); close() }}>확인</Button>
      </Group>
    </Box>
  </Box>, document.body)
}
