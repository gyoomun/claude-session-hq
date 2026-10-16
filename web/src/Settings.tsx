// 환경설정 창(IntelliJ 설정 창을 본떴다): 제목줄을 잡고 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다.
// 왼쪽은 검색과 목차(분류), 오른쪽은 늘 모든 분류를 이어서 보인다. 목차를 누르면 그 자리로 스크롤하고, 스크롤하면 목차가 따라온다. 값을 고르는 항목은 [적용]·[확인]을 눌러야 반영되고(바꾼 줄은 왼쪽에 파란 표시),
// 되돌리기·모두 재시작 같은 동작 버튼과 접속 관리는 누르면 바로 실행된다
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Button, CloseButton, Code, Group, SegmentedControl, Stack, Switch, Text, TextInput, UnstyledButton } from '@mantine/core'
import { IconAccessPoint, IconCalendar, IconKeyboard, IconLayoutColumns, IconMail, IconPalette, IconRefresh, IconSearch } from '@tabler/icons-react'
import { api, toast } from './store'
import { AREAS, DEFAULT_KEYS, TOAST_POS, type ToastPos, resetLayout, setKeys, setDetail, setMotion, setToast, setUI, setView, useUI } from './ui'
import type { Snapshot } from './types'
import { AccessPanel } from './Modals'
import { KeyRec, isRecording } from './Keys'

interface Draft { view: 'chat' | 'term'; detail: boolean; motion: 'system' | 'on'; toast: ToastPos }
// 분류와 그 안의 항목 글(검색에 쓴다)
const PAGES = [
  { id: 'view', name: '화면', icon: IconPalette, words: '웹 세션 화면 대화 터미널 작업 과정 자세히 도구 움직임 애니메이션 동작 줄이기 알림 토스트 위치 자리' },
  { id: 'layout', name: '배치', icon: IconLayoutColumns, words: '칸 높이 너비 핀 메모 btw 세션 목록 즐겨찾기 대화 경계 되돌리기 기본값' },
  { id: 'keys', name: '단축키', icon: IconKeyboard, words: '단축키 키보드 영역 세션 목록 즐겨찾기 대화 핀 메모 btw 녹화 F1 F2 F3 F4 Ctrl Tab Cmd T Esc 되감기' },
  { id: 'calendar', name: '일정', icon: IconCalendar, words: '일정 캘린더 구글 연차 반차 휴가 회사 iCal 다시 읽기' },
  { id: 'mail', name: '메일', icon: IconMail, words: '메일 이메일 Gmail 지메일 받은편지함 앱 비밀번호 다시 읽기' },
  { id: 'session', name: '세션', icon: IconRefresh, words: '모두 재시작 웹 세션 CLAUDE.md zshrc' },
  { id: 'access', name: '접속', icon: IconAccessPoint, words: '사내망 접속 인증 메일 로그인 기기 끊기 로그아웃' },
] as const

const Query = createContext('')
const GAP = 24 // 목차로 옮겼을 때 분류 제목 위 여백(px). 첫 분류는 맨 위(0)와 같아진다
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

// 알림 자리: 화면을 그린 네모 위 여덟 점(네 꼭짓점, 네 변의 가운데) 중 하나를 누른다
const SPOT: Record<ToastPos, [number, number, string]> = {
  'top-left': [16, 22, '왼쪽 위'], 'top-center': [50, 22, '위 가운데'], 'top-right': [84, 22, '오른쪽 위'], 'right-center': [84, 56, '오른쪽 가운데'],
  'bottom-right': [84, 88, '오른쪽 아래'], 'bottom-center': [50, 88, '아래 가운데'], 'bottom-left': [16, 88, '왼쪽 아래'], 'left-center': [16, 56, '왼쪽 가운데'],
}
function ToastPicker({ value, onChange }: { value: ToastPos; onChange: (v: ToastPos) => void }) {
  return <Group gap="sm" wrap="nowrap">
    <Text size="xs" c="dimmed" w={70} ta="right">{SPOT[value][2]}</Text>
    <Box className="hq-toastpick" role="radiogroup" aria-label="알림 자리">
      {TOAST_POS.map(p => <button key={p} type="button" role="radio" aria-checked={p === value} aria-label={SPOT[p][2]} title={SPOT[p][2]}
        className={p === value ? 'on' : undefined} style={{ left: `${SPOT[p][0]}%`, top: `${SPOT[p][1]}%` }} onClick={() => onChange(p)} />)}
    </Box>
  </Group>
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
    <Section title="알림">
      <Row label="알림 자리" help="'세션을 다시 띄웁니다' 같은 알림이 뜨는 곳. 적용하면 고른 자리에 보기 알림이 뜹니다" changed={d.toast !== ui.toast}>
        <ToastPicker value={d.toast} onChange={v => set({ toast: v })} />
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
  if (id === 'keys') {
    const fixed: [string, string][] = [['F1 · F2 · F3 · F4', '작업 · 업무별 · 세션 전체 · 메모 보기'], ['Ctrl+Tab · Ctrl+Shift+Tab', '같은 목록(즐겨찾기 또는 세션 목록) 안에서 다음·이전 세션'],
      ['⌘T (Ctrl+T)', '새 세션'], ['Esc', '대화에서: Claude 중단 · 다른 영역에서: 대화 입력칸으로'], ['Esc Esc', '대화에서 Claude가 쉴 때: 되감기'],
      ['↑ ↓ · Enter', '세션 목록·즐겨찾기: 옮기기 · 열고 입력칸으로'], ['스페이스 · Enter · ⌫⌫', '메모 줄: 끝남 표시 · 고치기 · 지우기']]
    return <>
      <Section title="영역 옮기기">
        {AREAS.map(([a, label]) => <Row key={a} label={label} help={`${label}(으)로 커서를 옮깁니다. 영역 이름 옆 ⌨로도 바꿉니다`}><KeyRec area={a} /></Row>)}
        <Row label="처음 값으로" help="영역 단축키를 ⌥1~⌥6으로 되돌립니다"><Button size="xs" variant="default" onClick={() => { setKeys(DEFAULT_KEYS); toast('영역 단축키를 처음 값으로 되돌렸습니다.') }}>기본값으로</Button></Row>
      </Section>
      <Section title="정해진 키">
        {fixed.map(([k, what]) => <Row key={k} label={what}><Text size="xs" ff="monospace" c="dimmed">{k}</Text></Row>)}
      </Section>
    </>
  }
  if (id === 'calendar') {
    const c = S.calendar
    return <>
      <Section title="구글 캘린더">
        <Row label="연결" help={!c?.sources ? '아직 이은 캘린더가 없습니다. 아래 순서대로 이으면 머리 아래에 7일 일정이 보입니다'
          : `캘린더 ${c.sources}개 · 일정 ${c.events.length}개(오늘부터 7일) · ${c.at ? new Date(c.at).toLocaleTimeString('ko-KR', { hour12: false }) + '에 읽음' : '아직 못 읽음'} · 10분마다 다시 읽습니다`}>
          <Button size="xs" variant="default" onClick={async () => { const r = await api<string>('calendar/reload'); if (r) toast(r.result ? '일부를 읽지 못했습니다: ' + r.result : '일정을 다시 읽었습니다.', r.result ? 'red' : undefined) }}>다시 읽기</Button>
        </Row>
        {c?.error && <Row label="읽지 못한 캘린더" help={c.error}><Text size="xs" c="red.4">확인 필요</Text></Row>}
      </Section>
      <Section title="잇는 법">
        <Stack gap={6} px={10}>
          <Text size="sm">1. 구글 캘린더(hjkim.engsoft@gmail.com)에서 설정 → 왼쪽 '내 캘린더의 설정'에서 팀 일정이 있는 캘린더를 고릅니다.</Text>
          <Text size="sm">2. '캘린더 통합'의 <b>비공개 주소(iCal 형식)</b>를 복사합니다. 이 주소는 비밀번호처럼 다룹니다(아는 사람은 일정을 볼 수 있다).</Text>
          <Text size="sm">3. 이 맥의 <Code>~/.claude/board/calendar.env</Code> 파일에 한 줄에 하나씩 <Code>이름=주소</Code>로 적습니다(캘린더가 여럿이면 여러 줄).</Text>
          <Text size="sm">4. 위의 '다시 읽기'를 누릅니다.</Text>
        </Stack>
      </Section>
    </>
  }
  if (id === 'mail') {
    const b = S.inbox
    return <>
      <Section title="받은편지함">
        <Row label="연결" help={!b?.accounts.length ? '아직 이은 메일이 없습니다. 아래 순서대로 이으면 화면 왼쪽 여백에 최근 메일이 보입니다'
          : `${b.accounts.join(', ')} · ${b.at ? new Date(b.at).toLocaleTimeString('ko-KR', { hour12: false }) + '에 읽음' : '아직 못 읽음'} · 2분마다 다시 읽습니다(읽음 표시는 바꾸지 않습니다)`}>
          <Button size="xs" variant="default" onClick={async () => { const r = await api<string>('inbox/reload'); if (r) toast(r.result ? '일부를 읽지 못했습니다: ' + r.result : '메일을 다시 읽었습니다.', r.result ? 'red' : undefined) }}>다시 읽기</Button>
        </Row>
        {b?.error && <Row label="읽지 못한 메일" help={b.error}><Text size="xs" c="red.4">확인 필요</Text></Row>}
      </Section>
      <Section title="잇는 법 (Gmail)">
        <Stack gap={6} px={10}>
          <Text size="sm">1. 그 구글 계정에 2단계 인증이 켜져 있어야 합니다.</Text>
          <Text size="sm">2. 구글 계정 관리 → 보안 → <b>앱 비밀번호</b>(myaccount.google.com/apppasswords)에서 하나 만듭니다. 비밀번호처럼 다룹니다.</Text>
          <Text size="sm">3. 이 맥의 <Code>~/.claude/board/inbox.env</Code> 파일에 한 줄에 하나씩 <Code>메일주소=앱 비밀번호</Code>로 적습니다(계정이 여럿이면 여러 줄).</Text>
          <Text size="sm">4. 위의 '다시 읽기'를 누릅니다.</Text>
        </Stack>
      </Section>
    </>
  }
  if (id === 'session') return <Section title="웹 세션">
    <Row label="모두 재시작" help="전역 CLAUDE.md·.zshrc를 바꾼 뒤. 웹 세션을 모두 끄고 같은 대화로 다시 띄웁니다(일하는 중이어도 끊습니다)"><RestartAll S={S} /></Row>
  </Section>
  return <AccessPanel S={S} />
}

export function SettingsWindow({ S }: { S: Snapshot }) {
  const ui = useUI()
  const cur: Draft = { view: ui.view, detail: ui.detail, motion: ui.motion, toast: ui.toast }
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
  const close = () => setUI({ settings: false, settingsPage: '' }) // 다음엔 맨 위에서 연다
  const changed = d.view !== ui.view || d.detail !== ui.detail || d.motion !== ui.motion || d.toast !== ui.toast
  const apply = () => {
    if (d.view !== ui.view) setView(d.view)
    if (d.detail !== ui.detail) setDetail(d.detail)
    if (d.motion !== ui.motion) setMotion(d.motion)
    if (d.toast !== ui.toast) { setToast(d.toast); setTimeout(() => toast('알림은 이제 여기에 뜹니다.'), 50) }
  }
  useEffect(() => {
    if (!ui.settings) return
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !isRecording()) { e.stopPropagation(); close() } }
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
  // 목차: 누르면 그 분류로 스크롤, 스크롤하면 지금 보이는 분류에 불이 들어온다(맨 위면 첫 분류)
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('')
  const pinned = useRef(0) // 목차를 누른 직후(부드러운 스크롤 중)에는 누른 것에 불을 둔다
  const go = (id: string, smooth = true) => {
    const box = scroller.current, el = box?.querySelector<HTMLElement>(`[data-page="${id}"]`)
    if (!box) return
    setActive(id); pinned.current = Date.now() + 700
    const crumb = box.querySelector<HTMLElement>('.hq-set-crumb')?.offsetHeight || 0 // 위에 붙은 경로 줄 밑으로
    box.scrollTo({ top: !el ? 0 : Math.max(0, el.offsetTop - box.offsetTop - crumb - GAP), behavior: smooth ? 'smooth' : 'auto' })
  }
  const spy = () => {
    const box = scroller.current
    if (!box || Date.now() < pinned.current) return
    const top = box.getBoundingClientRect().top + (box.querySelector<HTMLElement>('.hq-set-crumb')?.offsetHeight || 0) + GAP + 8
    const el = [...box.querySelectorAll<HTMLElement>('[data-page]')].filter(x => x.getBoundingClientRect().top <= top).pop()
    setActive(el?.dataset.page || box.querySelector<HTMLElement>('[data-page]')?.dataset.page || '')
  }
  // 열 때 고른 분류(예: 머리의 '사내망 접속 꺼짐' → 접속)가 있으면 그 자리에서 시작한다
  useLayoutEffect(() => { if (ui.settings) { go(ui.settingsPage, false); if (!PAGES.some(p => p.id === ui.settingsPage)) { pinned.current = 0; spy() } } }, [ui.settings])
  if (!ui.settings) return null
  const pages = PAGES.filter(p => hit(q, p.name + ' ' + p.words))
  const nav = pages
  const name = (nav.find(p => p.id === active) || nav[0])?.name || ''
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
