// 가운데 창들: 새 세션, 업무 추가, 상황 브리핑, 접속 관리, 환경설정
import { useEffect, useState } from 'react'
import { Autocomplete, Badge, Button, Code, Group, List, Modal, NativeSelect, Paper, SegmentedControl, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core'
import { api, toast } from './store'
import { lastCwd, pickNew, rememberCwd, resetLayout, setDetail, setMode, setMotion, setUI, setView, useUI } from './ui'
import type { Snapshot } from './types'
import { Since, bySt, fmt, lastOf, overdue, stale, tname, waiting } from './util'

export function NewSessionModal({ S }: { S: Snapshot }) {
  const ui = useUI()
  const [cwd, setCwd] = useState(lastCwd())
  const [task, setTask] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (ui.newFor !== null) setTask(ui.newFor) }, [ui.newFor])
  // 폴더 후보: 지금 세션들이 쓰는 폴더 + Orca 워크스페이스. 목록에 없는 폴더도 직접 적을 수 있다
  const dirs = [...new Set([...S.sessions.map(s => s.cwd), ...S.worktrees.map(w => w.path.replace(/^\/Users\/[^/]+/, '~'))])].sort()
  const close = () => setUI({ newFor: null })
  return <Modal opened={ui.newFor !== null} onClose={close} title="새 세션" size="lg">
    <form onSubmit={async e => {
      e.preventDefault()
      if (!cwd.trim()) { toast('폴더를 적거나 골라 주세요.', 'red'); return }
      setBusy(true)
      const r = await api<string>('session/new', { cwd: cwd.trim(), task, prompt })
      setBusy(false)
      if (r) { rememberCwd(cwd.trim()); setPrompt(''); close(); pickNew(r.result) }
    }}>
      <Stack gap="sm">
        <Autocomplete label="폴더" placeholder="예: ~/01dev/13engsoft" data={dirs} value={cwd} onChange={setCwd} data-autofocus={!cwd || undefined} />
        <NativeSelect label="업무" value={task} onChange={e => setTask(e.currentTarget.value)}
          data={[{ value: '', label: '미배치' }, ...S.tasks.map(t => ({ value: t.id, label: t.name }))]} />
        <Textarea label="첫 지시" description="비워 두면 빈 세션으로 엽니다" autosize minRows={3} maxRows={10} value={prompt}
          onChange={e => setPrompt(e.currentTarget.value)} data-autofocus={cwd ? true : undefined} />
        <Group justify="flex-end"><Button variant="default" onClick={close}>취소</Button><Button type="submit" loading={busy}>시작</Button></Group>
      </Stack>
    </form>
  </Modal>
}

export function AddTaskModal() {
  const ui = useUI()
  const [name, setName] = useState(''), [memo, setMemo] = useState('')
  const close = () => setUI({ addTask: false })
  return <Modal opened={ui.addTask} onClose={close} title="업무 추가">
    <form onSubmit={async e => {
      e.preventDefault()
      if (!name.trim()) { toast('업무 이름을 적어 주세요.', 'red'); return }
      if (await api('task/add', { name, memo })) {
        toast(`"${name}" 업무를 만들었습니다. 미배치 세션을 끌어다 놓으세요.`)
        setName(''); setMemo(''); close(); setMode('task')
      }
    }}>
      <Stack gap="sm">
        <TextInput label="업무 이름" placeholder="예: VPN 장비 교체" maxLength={120} value={name} onChange={e => setName(e.currentTarget.value)} data-autofocus />
        <TextInput label="관련 사람·메모" placeholder="선택" maxLength={300} value={memo} onChange={e => setMemo(e.currentTarget.value)} />
        <Group justify="flex-end"><Button variant="default" onClick={close}>취소</Button><Button type="submit">추가</Button></Group>
      </Stack>
    </form>
  </Modal>
}

export function BriefModal({ S }: { S: Snapshot }) {
  const ui = useUI()
  const n = Date.now(), ss = S.sessions
  const appr = ss.filter(s => s.state === 'approval').sort(bySt), mine = ss.filter(s => s.state === 'myturn').sort(bySt)
  const over = S.tasks.flatMap(t => t.waits.filter(overdue).map(w => ({ t, w })))
  const st = S.tasks.filter(t => stale(S, t)), working = ss.filter(s => s.state === 'working'), un = ss.filter(s => !s.task)
  const oldIdle = un.filter(s => s.state === 'idle' && n - s.since > 864e5)
  const todo = [
    ...appr.map(s => <><b>승인</b> {s.title} <Text span c="dimmed" size="sm">({tname(S, s.task)}, {fmt(n - s.since)}째)</Text></>),
    ...mine.map(s => <><b>답하기</b> {s.title} <Text span c="dimmed" size="sm">({tname(S, s.task)}, {fmt(n - s.since)}째)</Text></>),
    ...over.map(x => <><b>재촉</b> {x.w.who}에게 "{x.w.what}" <Text span c="dimmed" size="sm">({x.t.name}, {fmt(n - x.w.since)}째)</Text></>),
    ...st.map(t => <><b>정체 점검</b> {t.name} <Text span c="dimmed" size="sm">({fmt(n - lastOf(S, t))}째 진행 없음)</Text></>),
  ]
  return <Modal opened={ui.brief} onClose={() => setUI({ brief: false })} title="지금 상황 브리핑" size="lg">
    <Stack gap="sm">
      <Text>열린 Claude 세션 {ss.length}개 중 <Text span c="teal.5" fw={600}>{working.length}개가 일하는 중</Text>이고, <Text span c="yellow.5" fw={600}>{appr.length + mine.length}개가 나를 기다립니다.</Text> 사람 쪽으로는 {over.length}건이 4시간 넘게 답이 없습니다.</Text>
      {todo.length ? <><Text size="xs" c="dimmed">이 순서로 처리하면 됩니다</Text><List type="ordered" spacing={4}>{todo.map((x, i) => <List.Item key={i}>{x}</List.Item>)}</List></>
        : <Text>지금 내가 처리할 일은 없습니다.</Text>}
      {working.length > 0 && <><Text size="xs" c="dimmed">맡겨 둔 일 (손댈 필요 없음)</Text>
        <List type="ordered" spacing={4}>{working.map(s => <List.Item key={s.pid}>{s.title} — <Text span ff="monospace" size="xs" c="teal.5">{s.act}</Text></List.Item>)}</List></>}
      {un.length > 0 && <><Text size="xs" c="dimmed">정리할 것</Text><List type="ordered" spacing={4}>
        <List.Item>미배치 세션 {un.length}개 중 {un.filter(waiting).length}개가 나를 기다립니다. 업무에 배치하면 업무 카드에서 함께 보입니다.</List.Item>
        {oldIdle.length > 0 && <List.Item>하루 넘게 쉬는 미배치 세션 {oldIdle.length}개: {oldIdle.map(s => s.title).join(', ')}. 닫아도 되는지 보세요.</List.Item>}
      </List></>}
    </Stack>
  </Modal>
}

export function AccessModal({ S }: { S: Snapshot }) {
  const ui = useUI()
  const a = S.access
  const [renaming, setRenaming] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  const local = a.me === 'local', others = a.logins.filter(l => l.id !== a.me)
  return <Modal opened={ui.access} onClose={() => setUI({ access: false })} title="접속 관리" size="lg">
    <Stack gap="sm">
      <Paper withBorder p="sm"><Stack gap={6}>
        <Group><Text fw={600}>사내망 접속</Text><Badge color={a.lan ? 'teal' : 'gray'} variant="light">{a.lan ? '켜짐' : '꺼짐'}</Badge>
          {local && <Button ml="auto" size="xs" variant="default" disabled={!a.lan && !a.mail} onClick={() => api('access/lan', { on: !a.lan })}>{a.lan ? '끄기' : '켜기'}</Button>}</Group>
        <Text size="sm" c="dimmed">{a.lan ? '같은 망의 다른 PC에서 아래 주소로 들어와 메일 인증번호로 로그인할 수 있습니다. 끄면 다른 기기는 모두 바로 끊깁니다.' : '지금은 이 맥에서만 열립니다.'}</Text>
        {a.lan && a.addresses.map(x => <Code key={x}>{x}</Code>)}
      </Stack></Paper>
      <Paper withBorder p="sm"><Stack gap={6}>
        <Text fw={600}>인증 메일</Text>
        {a.mail ? <Text size="sm" c="dimmed">인증번호는 <b>{a.mail}</b>으로 갑니다. 이 메일함에 들어갈 수 있는 사람만 로그인할 수 있습니다.</Text> : <>
          <Text size="sm" c="dimmed">아직 설정되지 않아 사내망 접속을 켤 수 없습니다. 아래 내용으로 <Code>{a.mailFile}</Code> 파일을 만드세요. Gmail이면 비밀번호 자리에 앱 비밀번호를 씁니다.</Text>
          <Code block>{'SMTP_USER=보내는메일@gmail.com\nSMTP_PASS=앱비밀번호16자리\nMAIL_TO=인증번호받을메일@gmail.com'}</Code></>}
      </Stack></Paper>
      <Paper withBorder p="sm"><Stack gap={8}>
        <Group><Text fw={600}>로그인한 기기</Text><Text size="xs" c="dimmed">{a.logins.length}대</Text>
          {others.length > 0 && <Button ml="auto" size="xs" variant="outline" color="red" onBlur={() => setConfirmAll(false)} onClick={async () => {
            if (!confirmAll) { setConfirmAll(true); return }
            setConfirmAll(false)
            if (await api('access/revoke', { id: 'all' })) toast('다른 기기의 로그인을 모두 끊었습니다.')
          }}>{confirmAll ? '한 번 더 누르면 모두 끊기' : local ? '모두 끊기' : '다른 기기 모두 끊기'}</Button>}</Group>
        {a.logins.length ? [...a.logins].sort((x, y) => y.lastSeenAt - x.lastSeenAt).map(l => <Paper key={l.id} withBorder p="8px 10px">
          <Group wrap="nowrap" align="flex-start">
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              {renaming === l.id ? <form onSubmit={async e => {
                e.preventDefault(); setRenaming(null)
                if (await api('access/rename', { id: l.id, label })) toast('이름을 바꿨습니다. 같은 PC가 다시 로그인해도 이 이름으로 보입니다.')
              }}><Group gap={6} wrap="nowrap"><TextInput size="xs" value={label} maxLength={60} onChange={e => setLabel(e.currentTarget.value)} autoFocus style={{ flex: 1 }} /><Button size="xs" type="submit">저장</Button></Group></form>
                : <Group gap={6}><Text fw={600} size="sm">{l.label}</Text>
                  <Button size="compact-xs" variant="subtle" color="gray" onClick={() => { setLabel(l.label); setRenaming(l.id) }}>이름 바꾸기</Button>
                  {l.id === a.me && <Badge size="xs" variant="light">지금 이 기기</Badge>}</Group>}
              <Text size="xs" c="dimmed">{l.pc && l.pc !== l.label ? l.pc + ' · ' : ''}{l.device} · {l.ip} · 로그인 {new Date(l.createdAt).toLocaleString('ko-KR')} · 마지막 접속 <Since t={l.lastSeenAt} suf=" 전" /></Text>
            </Stack>
            {l.id === a.me
              ? <Button size="xs" variant="default" onClick={async () => { await api('access/logout'); location.href = '/login' }}>로그아웃</Button>
              : <Button size="xs" variant="outline" color="red" onClick={async () => { if (await api('access/revoke', { id: l.id })) toast('그 기기의 로그인을 끊었습니다.') }}>끊기</Button>}
          </Group>
        </Paper>) : <Text size="sm" c="dimmed">로그인한 다른 기기가 없습니다.</Text>}
      </Stack></Paper>
    </Stack>
  </Modal>
}

// 웹 세션을 모두 끄고 같은 대화로 다시 띄운다(전역 CLAUDE.md·.zshrc를 바꾼 뒤). 일하는 중이어도 끊으므로 두 번 눌러야 한다
function RestartAll({ S }: { S: Snapshot }) {
  const [confirm, setConfirm] = useState(false)
  const n = S.sessions.filter(s => s.host === 'web').length
  return <Button variant="default" size="xs" color={confirm ? 'red' : undefined} disabled={!n} onBlur={() => setConfirm(false)} onClick={async () => {
    if (!confirm) { setConfirm(true); return }
    setConfirm(false)
    const r = await api<number>('session/restart')
    if (r) toast(`웹 세션 ${r.result}개를 다시 띄웁니다. 대화는 그대로 이어집니다.`)
  }}>{confirm ? `한 번 더 누르면 ${n}개 재시작` : '모두 재시작'}</Button>
}

// 자주 바꾸지 않는 화면 설정과 관리 동작을 한곳에 모은다
export function SettingsModal({ S }: { S: Snapshot }) {
  const ui = useUI()
  const row = (label: string, desc: string, control: React.ReactNode) => <Group justify="space-between" wrap="nowrap" gap="md">
    <Stack gap={0}><Text size="sm" fw={600}>{label}</Text><Text size="xs" c="dimmed">{desc}</Text></Stack>{control}</Group>
  return <Modal opened={ui.settings} onClose={() => setUI({ settings: false })} title="환경설정">
    <Stack gap="lg">
      {row('웹 세션 화면', '터미널은 Claude Code 화면 그대로입니다', <SegmentedControl size="xs" value={ui.view} onChange={v => setView(v as 'chat' | 'term')}
        data={[{ label: '대화', value: 'chat' }, { label: '터미널', value: 'term' }]} />)}
      {row('작업 과정 자세히', '대화 화면에서 도구 사용을 하나하나 봅니다', <Switch checked={ui.detail} onChange={e => setDetail(e.currentTarget.checked)} aria-label="작업 과정 자세히" />)}
      {row('접속', '사내망 접속과 로그인한 기기를 관리합니다', <Button size="xs" variant="default" onClick={() => setUI({ settings: false, access: true })}>열기</Button>)}
      {row('움직임', '컴퓨터의 \'동작 줄이기\'가 켜져 있으면 움직임이 꺼집니다. 이 화면만 켜려면 항상 켜기', <SegmentedControl size="xs" value={ui.motion} onChange={v => setMotion(v as 'system' | 'on')}
        data={[{ label: '컴퓨터 설정 따르기', value: 'system' }, { label: '항상 켜기', value: 'on' }]} />)}
      {row('칸 높이 되돌리기', '핀·메모·btw 사이 경계를 처음 높이로', <Button size="xs" variant="default" onClick={() => { resetLayout('hq-side'); toast('핀·메모·btw 높이를 처음으로 되돌렸습니다.') }}>되돌리기</Button>)}
      {row('칸 너비 되돌리기', '세션 목록·즐겨찾기·대화 사이 경계를 처음 너비로', <Button size="xs" variant="default" onClick={() => { resetLayout('hq-work'); toast('목록·즐겨찾기·대화 너비를 처음으로 되돌렸습니다.') }}>되돌리기</Button>)}
      {row('모두 재시작', '웹 세션을 모두 끄고 같은 대화로 다시 띄웁니다(일하는 중이어도)', <RestartAll S={S} />)}
    </Stack>
  </Modal>
}
