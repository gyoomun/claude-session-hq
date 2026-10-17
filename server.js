// claude-session-hq: 이 Mac의 Claude Code 세션을 모아 보고, 웹 안의 터미널로 직접 일하게 하는 로컬 서버.
// 웹에서 연 세션은 전용 tmux 서버 안에서 돌아 이 서버가 꺼져도 살아 있다. 이 맥 밖(사내망)에서는 메일 인증으로 로그인해야 쓴다(auth.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const pty = require('node-pty');

const HOME = os.homedir();
const PORT = +process.env.PORT || 7420;
const CLAUDE_DIR = path.join(HOME, '.claude');
const SESS_DIR = path.join(CLAUDE_DIR, 'sessions'); // Claude Code가 프로세스마다 <pid>.json을 쓴다
const PROJ_DIR = path.join(CLAUDE_DIR, 'projects'); // 대화 기록(<sessionId>.jsonl)
const BOARD_DIR = path.join(CLAUDE_DIR, 'board');
const HOOK_DIR = path.join(BOARD_DIR, 'hooks'); // hooks/hook.sh가 <pid>.json으로 마지막 이벤트를 남긴다
const DB_FILE = path.join(BOARD_DIR, 'hq.json');
const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const DIST = path.join(__dirname, 'dist'); // 화면(web/)을 npm run build로 만든 결과
const SCAN_MS = 2000;
// 처음 보는 세션이 이만큼 넘게 쉬고 있었다면 '내 차례'가 아니라 '쉼'으로 시작한다
const SEEN_GRACE_MS = 30 * 60e3;

/* tmux: 사용자가 따로 쓰는 tmux와 섞이지 않게 전용 소켓과 설정 파일을 쓴다 */
const TMUX = fs.existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : 'tmux';
const TMUX_ARGS = ['-L', 'claude-hq', '-f', path.join(__dirname, 'tmux.conf'), '-u'];
const SHELL = os.userInfo().shell || '/bin/zsh';
// tmux와 그 안의 셸이 받을 환경. launchd나 Orca의 변수(ORCA_*, CLAUDECODE 등)가 새 세션에 섞이지 않게 새로 만든다
const TERM_ENV = {
  HOME, USER: os.userInfo().username, LOGNAME: os.userInfo().username, SHELL, TMPDIR: os.tmpdir(),
  PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: process.env.LANG || 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
};

/* 저장소: 업무, 세션 배치, 확인 시각, 웹 세션 목록(재부팅 뒤 복구용) */
let db = { tasks: [], assign: {}, seen: {}, web: [], layout: {}, rooms: {}, favs: { mode: 'auto', items: [] }, usageShare: {}, forks: {}, keepSince: {}, pins: {}, btw: {}, memos: {}, closed: [], claudeArgs: ['--dangerously-skip-permissions'], nextId: 1 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
// 세션별 한도 추정은 한도 종류(5시간·주간)마다 따로 둔다. 예전 모양(대화 ID가 바로 키)은 창이 지나면 버려지는 값이라 옮기지 않는다
// 메모는 세션마다 글 하나(화면에서 큰 칸 하나로 고친다). 예전 모양(줄 목록 items)은 줄을 이어 붙여 옮긴다(끝난 줄은 앞에 ✓)
for (const m of Object.values(db.memos)) if (m.items) { m.text = m.items.map(x => (x.done ? '✓ ' : '') + x.text).join('\n'); m.at = Math.max(0, ...m.items.map(x => x.at)); delete m.items; }
db.usageShare = { five_hour: db.usageShare.five_hour || {}, seven_day: db.usageShare.seven_day || {} };
// 서버가 꺼지면서 끊긴 곁가지 질문은 실패로 표시한다
for (const list of Object.values(db.btw || {})) for (const it of list) if (it.state === 'asking') { it.state = 'error'; it.a = '서버가 다시 시작돼 답을 받지 못했습니다.'; }
function save() {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 1));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function liveSessions() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter(f => /^\d+\.json$/.test(f)); } catch {}
  return files.map(f => readJSON(path.join(SESS_DIR, f)))
    .filter(s => s && s.sessionId && (s.kind || 'interactive') === 'interactive' && alive(s.pid));
}

/* 대화 기록에서 제목, 마지막 지시, 마지막 답을 읽는다. 파일이 바뀔 때만 끝부분을 다시 읽는다. */
const tcache = new Map();
const hcache = new Map(); // 모든 대화 목록(history/list)용: 파일 → {mtime, title, cwd}
function findTranscript(s) {
  const guess = path.join(PROJ_DIR, s.cwd.replace(/[^A-Za-z0-9]/g, '-'), s.sessionId + '.jsonl');
  if (fs.existsSync(guess)) return guess;
  try {
    for (const d of fs.readdirSync(PROJ_DIR)) {
      const f = path.join(PROJ_DIR, d, s.sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}
function readTail(file, size, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8');
    return len < size ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}
// "t1 [>] 할 일" / "d1 [?] 결정할 것" 줄을 항목으로. 표시: ' ' 할 일, '>' 하는 중, 'x' 끝남, '?' 결정할 것
const pinItems = text => text.split('\n').map(l => l.match(/^(\w+) \[(.)\] (.*)$/)).filter(Boolean).map(m => ({ id: m[1], mark: m[2], text: m[3] }));
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
function scanLines(text, info) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) info.title = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) info.custom = d.customTitle;
    else if (d.isSidechain || d.isMeta || d.isCompactSummary) continue; // 자동 압축 요약은 Claude Code가 넣은 글이라 내 말로 치지 않는다
    else if (d.type === 'assistant') {
      const t = textOf(d.message?.content).trim(); if (t) info.lastText = t;
      // 마지막 답을 만든 모델과 effort(/model·/effort로 바꾸면 다음 답부터 바뀐다)
      if (d.requestedModel || d.message?.model) info.model = d.requestedModel || d.message.model;
      if (d.effort) info.effort = d.effort;
    }
    if (d.type === 'user' && d.permissionMode) info.mode = d.permissionMode; // 권한 모드(보낸 말마다 남는다. 화면을 못 읽는 세션에서 쓴다)
    else if (d.type === 'user') {
      // /model·/effort를 치면 Claude Code가 'Set effort level to medium (saved…' 같은 줄을 남긴다. 다음 답을 기다리지 않고 바로 화면에 반영한다
      const set = textOf(d.message?.content).match(/^<local-command-stdout>Set (effort level|model) to `?(.+?)`?(?: and saved| \(saved| for this| \(this|<\/)/);
      if (set) info[set[1] === 'model' ? 'model' : 'effort'] = set[2];
      // 핀보드 플러그인은 바꿀 때마다 보드 전체를 도구 결과로 남긴다("Pinboard now: …"). 그 마지막 것이 지금 보드다
      for (const x of Array.isArray(d.message?.content) ? d.message.content : []) {
        const r = x.type === 'tool_result' ? textOf(x.content) : '';
        if (/^Pinboard (now:|is empty\.)/.test(r)) info.pin = { text: r, at: Date.parse(d.timestamp) || 0 };
      }
      const t = textOf(d.message?.content).trim();
      if (t && !t.startsWith('<') && !t.startsWith('[Request interrupted')) info.lastPrompt = t;
    }
  }
}
function transcriptInfo(s) {
  let c = tcache.get(s.sessionId);
  if (!c) { c = { file: findTranscript(s), mtime: 0 }; tcache.set(s.sessionId, c); }
  if (!c.file) { c.file = findTranscript(s); if (!c.file) return c; }
  let st; try { st = fs.statSync(c.file); } catch { return c; }
  if (st.mtimeMs !== c.mtime) {
    // 처음에는 제목을 찾으려고 넉넉히, 이후에는 끝부분만 읽는다
    scanLines(readTail(c.file, st.size, c.mtime ? 1e6 : 8e6), c);
    c.mtime = st.mtimeMs;
  }
  return c;
}

/* 훅이 남긴 마지막 이벤트. 큰 입력은 잘려 있어 JSON이 깨질 수 있으므로 필요한 값은 정규식으로도 꺼낸다. */
function hookInfo(s) {
  const f = path.join(HOOK_DIR, s.pid + '.json');
  let st; try { st = fs.statSync(f); } catch { return null; }
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { return null; }
  let d = null; try { d = JSON.parse(raw); } catch {}
  const get = k => d ? d[k] : (raw.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]*)"')) || [])[1];
  if (get('session_id') && get('session_id') !== s.sessionId) return null;
  return { event: get('hook_event_name'), tool: get('tool_name'), input: d && d.tool_input, raw, at: st.mtimeMs };
}
function toolLine(h) {
  if (!h || !h.tool) return '';
  const i = h.input || {};
  let x = i.command || i.file_path || i.pattern || i.url || i.description || i.query || '';
  if (!h.input) { const m = h.raw.match(/"(?:command|file_path|pattern|url|description)"\s*:\s*"((?:[^"\\]|\\.){0,200})/); x = m ? m[1] : ''; }
  const tool = h.tool.replace(/^mcp__(.+?)__/, '$1:');
  return clip((tool + (x ? ' · ' + x : '')).replace(/\s+/g, ' '), 160);
}

const quiet = new Map(); // sid -> 마지막으로 본 쉬는 상태(idle/myturn). 압축이 끝난 뒤 되돌릴 때 쓴다
function stateOf(s, h, now) {
  const at = s.statusUpdatedAt || s.startedAt || now;
  const fresh = h && h.at >= at - 2000;
  if (fresh && h.event === 'PermissionRequest') return ['approval', h.at];
  if (fresh && h.event === 'PreToolUse' && h.tool === 'AskUserQuestion') return ['myturn', h.at];
  // 대화 압축(PreCompact 훅 직후의 busy)은 일이 아니므로 따로 '압축 중'으로 보인다
  if (s.status && s.status !== 'idle') return [fresh && h.event === 'PreCompact' ? 'compact' : 'working', at];
  let st = at > (db.seen[s.sessionId] || 0) ? 'myturn' : 'idle';
  // Claude Code는 쉬는 동안 스스로 대화를 압축한다(PreCompact 훅이 마지막 이벤트). 끝나면 상태 시각만 바뀌고 새로 할 말은 없으니 압축 전 상태로 둔다
  if (st === 'myturn' && h && h.event === 'PreCompact' && quiet.get(s.sessionId) === 'idle') { db.seen[s.sessionId] = at; st = 'idle'; }
  quiet.set(s.sessionId, st);
  return [st, at];
}

/* 세션이 어디서 돌고 있나: claude 프로세스의 환경 변수로 안다. 웹 세션은 HQ_TMUX, Orca는 ORCA_TERMINAL_HANDLE. 프로세스마다 한 번만 읽는다. */
const handles = new Map(); // pid -> { tmux, orca }
const argsByPid = new Map(); // pid -> 다시 띄울 때 쓸 원래 옵션(--dangerously-skip-permissions 등)
let soonTimer = null;
const scanSoon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(scan, 60); };
function loadHandles(pids) {
  const need = pids.filter(p => !handles.has(p));
  if (!need.length) return;
  need.forEach(p => handles.set(p, {}));
  execFile('/bin/ps', ['-ww', '-o', 'pid=,command=', '-p', need.join(',')], (err, out) => {
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m) argsByPid.set(+m[1], keepFlags(m[2].trim().split(/\s+/).slice(1)));
    }
  });
  execFile('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', need.join(',')], { maxBuffer: 64e6 }, (err, out) => {
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      if (!m) continue;
      const t = line.match(/ HQ_TMUX=(hq-[a-z0-9]+)/), o = line.match(/ ORCA_TERMINAL_HANDLE=(\S+)/);
      // tmux 안에서 돈다면 웹 세션이다. Orca 변수가 남아 있어도 무시한다
      handles.set(+m[1], t ? { tmux: t[1] } : o ? { orca: o[1] } : {});
    }
    scanSoon(); // 어디서 도는지(웹·Orca) 알았으니 다음 훑기(2초)를 기다리지 않는다
  });
}

/* tmux */
const q = a => "'" + String(a).replace(/'/g, "'\\''") + "'";
function tmux(args) {
  return new Promise((ok, fail) => execFile(TMUX, [...TMUX_ARGS, ...args], { env: TERM_ENV, timeout: 10000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok(out)));
}
// 로그인 셸로 claude를 띄운다(.zshrc의 PATH를 쓰려고). claude가 끝나면 tmux 세션도 끝난다
// 같은 대화로 다시 띄우는 인자. 아직 한마디도 안 한 세션은 기록 파일이 없어 --resume이 실패하고 바로 꺼지므로, 같은 대화 ID로 새로 띄운다(메모·즐겨찾기가 이어진다)
const resumeArgs = (cwd, sid) => findTranscript({ cwd, sessionId: sid }) ? ['--resume', sid] : ['--session-id', sid];
function startTmux(name, cwd, args) {
  return tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '200', '-y', '50', '-e', 'HQ_TMUX=' + name,
    SHELL, '-lic', 'exec claude ' + args.map(q).join(' ')]);
}
const tmuxPanes = new Map(); // tmux 세션 이름 -> 탭 제목(Claude가 정한 제목)
let tmuxAlive = false;
function loadTmuxPanes() {
  execFile(TMUX, [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_title}'], { env: TERM_ENV, timeout: 5000 }, (err, out) => {
    tmuxAlive = !err;
    tmuxPanes.clear();
    for (const line of (out || '').split('\n')) {
      const [name, title] = line.split('\t');
      if (name) tmuxPanes.set(name, String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim());
    }
  });
}
// 서버가 켜질 때: 목록에 있는데 tmux에 없는 웹 세션(재부팅 등으로 죽은 것)을 같은 명령으로 다시 띄운다
async function restoreWeb() {
  let names = [];
  try { names = (await tmux(['list-sessions', '-F', '#{session_name}'])).split('\n'); } catch {}
  const openSids = new Set(liveSessions().map(x => x.sessionId));
  for (const w of db.web) {
    if (names.includes(w.name) || !w.sid) continue;
    // 그 대화가 이미 다른 곳(Orca 등)에서 열려 있으면 다시 띄우지 않는다. 같은 대화가 둘로 돌면 엉킨다
    if (openSids.has(w.sid)) { console.log('복구 건너뜀(다른 곳에서 열려 있음):', w.name, w.sid); w.sid = ''; w.createdAt = 0; continue; }
    // 꺼지기 전에 나를 기다리던 세션만 '내 차례'로 남기고, 나머지는 다시 띄운 것만으로 '내 차례'가 되지 않게 한다
    if (w.state !== 'myturn' && w.state !== 'approval') db.seen[w.sid] = Date.now() + 30e3;
    try { await startTmux(w.name, w.cwd, [...w.args, ...resumeArgs(w.cwd, w.sid)]); console.log('복구:', w.name, w.sid); }
    catch (e) { console.error('복구 실패:', w.name, e.message); }
  }
  db.web = db.web.filter(w => w.sid || Date.now() - w.createdAt < 60e3);
  save();
}
function keepFlags(tokens) {
  // 원래 실행 옵션 중 이어 띄울 때도 의미 있는 것만 남긴다
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--dangerously-skip-permissions') out.push(tokens[i]);
    else if (['--permission-mode', '--model', '--add-dir'].includes(tokens[i]) && tokens[i + 1]) out.push(tokens[i], tokens[++i]);
  }
  return out;
}
const run = (cmd, args) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 15000 }, (e, out, err) => e ? fail(new Error(clip((err || e.message).trim(), 300))) : ok(out)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newName = () => 'hq-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

/* Orca 탭 제목: 사용자가 Orca에서 보는 이름과 같게 맞춘다. 10초마다 새로 읽는다. */
const orcaTitles = new Map();
let orcaTitlesAt = 0;
function loadOrcaTitles(now) {
  if (now - orcaTitlesAt < 10000 || !fs.existsSync(ORCA)) return;
  orcaTitlesAt = now;
  execFile(ORCA, ['terminal', 'list', '--json'], { timeout: 8000, maxBuffer: 16e6 }, (err, out) => {
    if (err) return;
    try {
      orcaTitles.clear();
      for (const t of JSON.parse(out).result.terminals) {
        const title = String(t.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
        if (title && title !== 'Claude Code') orcaTitles.set(t.handle, title);
      }
    } catch {}
  });
}

/* 새 세션을 열 수 있는 폴더: Orca 워크스페이스 목록. 1분마다 새로 읽는다. */
let worktrees = [];
let worktreesAt = 0;
function loadWorktrees(now) {
  if (now - worktreesAt < 60000 || !fs.existsSync(ORCA)) return;
  worktreesAt = now;
  execFile(ORCA, ['worktree', 'list', '--json'], { timeout: 8000, maxBuffer: 16e6 }, (err, out) => {
    if (err) return;
    try {
      worktrees = JSON.parse(out).result.worktrees.map(w => ({ path: w.path, name: w.displayName || path.basename(w.path) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    } catch {}
  });
}
// 화면에서 연 세션: tmux 이름으로 기억해 두었다가 세션이 나타나면 고른 업무에 배치한다
const pendingAssign = new Map();
// 화면 밖에서(예: 웹 안의 Claude가) 세션을 열었을 때, 열려 있는 화면이 그 세션으로 넘어가게 하는 신호
let focusReq = null;

/* 2초마다 전체 상태를 만들고, 상태가 바뀐 세션은 이벤트로 남긴다 */
let snapshot = { now: Date.now(), sessions: [], tasks: [], feed: [] };
const prev = new Map();
const feed = [];
let firstScan = true;
function pushFeed(e) { feed.unshift(e); if (feed.length > 300) feed.length = 300; }
function scan() {
  const now = Date.now();
  const live = liveSessions().filter(s => s.cwd !== LOGIN_DIR); // 계정 줄로 띄운 로그인 claude는 세션이 아니다(목록·닫힌 기록에 넣지 않는다)
  loadHandles(live.map(s => s.pid));
  loadOrcaTitles(now);
  loadWorktrees(now);
  loadTmuxPanes();
  let dirty = false;
  const sessions = live.map(s => {
    const where = handles.get(s.pid) || {};
    if (where.tmux) {
      const task = pendingAssign.get(where.tmux);
      if (task) {
        pendingAssign.delete(where.tmux);
        if (db.tasks.some(t => t.id === task)) { db.assign[s.sessionId] = task; dirty = true; }
      }
      const w = db.web.find(x => x.name === where.tmux);
      if (w && w.sid !== s.sessionId) { w.sid = s.sessionId; dirty = true; }
      if (w?.forkOf && s.sessionId !== w.forkOf && !db.forks[s.sessionId]) { db.forks[s.sessionId] = w.forkOf; favBelow(s.sessionId, w.forkOf); dirty = true; }
      // 즐겨찾기의 세션을 보다가 연 새 세션은 그 세션 바로 밑에 넣는다(한 번만. 사용자가 나중에 빼면 다시 넣지 않는다)
      if (w?.favOf && w.sid) { favBelow(w.sid, w.favOf); delete w.favOf; dirty = true; }
    }
    if (!(s.sessionId in db.seen)) {
      const at = s.statusUpdatedAt || s.startedAt || now;
      // 닫혔다가 다시 열린 대화는 닫히기 전 상태를 따른다(다시 띄운 것만으로 '내 차례'가 되지 않게)
      const c = db.closed.find(x => x.sid === s.sessionId);
      db.seen[s.sessionId] = c ? (c.state === 'myturn' || c.state === 'approval' ? 0 : now + 30e3)
        : s.status === 'idle' && now - at > SEEN_GRACE_MS ? at : 0;
      dirty = true;
    }
    const h = hookInfo(s);
    const t = transcriptInfo(s);
    let [state, since] = stateOf(s, h, now);
    // 다시 띄운 세션은 상태가 그대로면 상태가 시작된 시각도 그대로 둔다(안 그러면 모두 재시작한 때로 보인다).
    // hq.json에 둔다: 메모리에만 두면 HQ 서버를 다시 띄울 때 사라져 같은 버그가 났다. 다시 띄운 뒤 1분 넘어 생긴 상태 시각은 새 일이라 버린다
    const kept = db.keepSince[s.sessionId];
    if (kept && kept.state === state && since < kept.at + 60e3) since = kept.since;
    else if (kept && !restarting.has(s.sessionId)) { delete db.keepSince[s.sessionId]; dirty = true; }
    // 핀보드는 Claude 프로세스 메모리에만 있어 다시 띄우면 Claude 쪽은 비워진다. 화면에는 마지막 보드를 저장해 두고 계속 보인다
    if (t.pin && (!db.pins[s.sessionId] || t.pin.at > db.pins[s.sessionId].at)) { db.pins[s.sessionId] = { text: t.pin.text, at: t.pin.at }; dirty = true; }
    const toolNow = h && h.at >= (s.statusUpdatedAt || 0) - 2000 && /^(PreToolUse|PostToolUse|PermissionRequest)$/.test(h.event);
    let msg = clip(t.lastText, 600);
    if (state === 'approval') msg = '실행 허락을 기다립니다 · ' + toolLine(h);
    else if (state === 'myturn' && h && h.tool === 'AskUserQuestion' && h.input) msg = clip(h.input.questions?.[0]?.question || msg, 600);
    const web = where.tmux && db.web.find(x => x.name === where.tmux);
    if (web && web.state !== state) { web.state = state; dirty = true; }
    const tabTitle = where.tmux ? tmuxPanes.get(where.tmux) : orcaTitles.get(where.orca);
    return {
      pid: s.pid, sid: s.sessionId, name: s.name, title: t.custom || (tabTitle && tabTitle !== 'Claude Code' ? tabTitle : '') || t.title || s.name,
      cwd: s.cwd.replace(HOME, '~'), dir: s.cwd, state, since, startedAt: s.startedAt,
      act: state === 'working' ? (toolNow ? toolLine(h) : '생각 중') : state === 'compact' ? '대화 압축 중' : '',
      msg, prompt: clip(t.lastPrompt, 400), model: t.model || '', effort: t.effort || '',
      // 권한 모드와 뒤에서 도는 작업: 웹 세션은 Claude Code 화면 맨 아래 줄을 읽는다(모드를 바꾸면 바로 보인다), 아니면 대화 기록의 마지막 모드
      mode: (where.tmux && footers.get(where.tmux)?.mode) || t.mode || '', bg: (where.tmux && footers.get(where.tmux)?.bg) || { shells: 0, agents: [] }, next: (where.tmux && footers.get(where.tmux)?.next) || [], task: db.assign[s.sessionId] || '',
      pin: db.pins[s.sessionId] ? pinItems(db.pins[s.sessionId].text) : [],
      host: where.tmux ? 'web' : where.orca ? 'orca' : '', tmux: where.tmux || '', forkOf: db.forks[s.sessionId] || '',
    };
  });
  // 웹 세션이 스스로 끝났으면(/exit 등) 목록에서 뺀다. 다시 띄우지 않는다
  if (tmuxAlive) {
    const before = db.web.length;
    db.web = db.web.filter(w => tmuxPanes.has(w.name) || now - w.createdAt < 30e3);
    if (db.web.length !== before) dirty = true;
  }
  const ids = new Set(sessions.map(s => s.sid));
  for (const s of sessions) {
    const p = prev.get(s.sid);
    if (!firstScan && p !== s.state) pushFeed({ at: now, sid: s.sid, title: s.title, task: s.task, from: p || 'open', to: s.state });
    prev.set(s.sid, s.state);
  }
  for (const [sid, st] of prev) if (!ids.has(sid)) {
    prev.delete(sid);
    const was = snapshot.sessions.find(x => x.sid === sid);
    pushFeed({ at: now, sid, title: was?.title || sid, task: db.assign[sid] || '', from: st, to: 'closed' });
    // 닫힌 세션(제한 없이 보관): Orca가 꺼지는 등으로 한꺼번에 사라져도 웹에서 같은 명령으로 다시 열 수 있게 남긴다
    if (was && !restarting.has(sid)) {
      db.closed = [{ sid, title: was.title, dir: was.dir, cwd: was.cwd, args: argsByPid.get(was.pid) || [], host: was.host, state: was.state, closedAt: now, quiet: userClosed.delete(sid) || was.host !== 'web' },
        ...db.closed.filter(c => c.sid !== sid)];
      dirty = true;
    }
  }
  // 다시 열린 대화는 목록에서 뺀다
  const keep = db.closed.filter(c => !ids.has(c.sid));
  if (keep.length !== db.closed.length) { db.closed = keep; dirty = true; }
  // 닫힌 세션의 확인 기록은 지운다. 웹 세션은 다시 뜨는 중일 수 있으니 남긴다
  for (const sid of Object.keys(db.seen)) if (!ids.has(sid) && !db.web.some(w => w.sid === sid)) { delete db.seen[sid]; dirty = true; }
  // 다시 띄우기 전 상태 시각은 떠 있는(또는 다시 뜨는 중인) 세션 것만 둔다
  for (const sid of Object.keys(db.keepSince)) if (!ids.has(sid) && !db.web.some(w => w.sid === sid)) { delete db.keepSince[sid]; dirty = true; }
  // 포크 관계는 다시 열 수 있는 동안(닫힌 세션)만 둔다
  for (const sid of Object.keys(db.forks)) if (!ids.has(sid) && !db.web.some(w => w.sid === sid) && !db.closed.some(c => c.sid === sid)) { delete db.forks[sid]; dirty = true; }
  if (dirty) save();
  firstScan = false;
  checkLogin();
  // 모두 재시작 중 잠깐 꺼진 세션은 끄기 전 모습으로 목록에 남긴다(사라졌다 나타나지 않게)
  const rebootGhosts = reboot ? reboot.items.filter(x => (x.phase === 'kill' || x.phase === 'start') && !ids.has(x.sid)).map(x => x.s) : [];
  snapshot = { now, sessions: [...sessions, ...rebootGhosts], tasks: db.tasks, feed: feed.slice(0, 120), orca: fs.existsSync(ORCA), worktrees, focus: focusReq, layout: db.layout, rooms: db.rooms, favs: db.favs, notice, calendar, inbox, flow, usage: readUsage(), account: readAccount(), usageStale: !!(usage && account && usageOwner !== account.email), login: !!login, usageShare: db.usageShare, btw: db.btw, memos: db.memos, closed: db.closed, migrating,
    reboot: reboot && { at: reboot.at, end: reboot.end, items: reboot.items.map(({ sid, title, phase, ms }) => ({ sid, title, phase, ms })) },
    // 화면 빌드 시각: 열려 있는 화면이 자기보다 새 빌드가 나왔는지 알아채게 한다
    build: (() => { try { return fs.statSync(path.join(DIST, 'index.html')).mtimeMs; } catch { return 0; } })() };
}

/* 대화 화면: 대화 기록(jsonl)을 웹에서 그릴 수 있는 메시지로 바꾼다. 처음엔 끝부분만, 이후엔 늘어난 만큼만 읽는다 */
const cut = (v, n) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > n ? t.slice(0, n) + '…' : (t || ''); };
function toolInput(name, i = {}) {
  return cut(i.command || i.file_path || i.pattern || i.url || i.query || i.description || i.prompt || i.skill || (Object.keys(i).length ? i : ''), 400);
}
// 붙여넣은 긴 글은 Claude Code가 <pasted_content id="…">로 감싼다. 시스템 문구(<로 시작)인지는 태그를 벗기고 본다. 태그는 남겨 화면이 붙여넣은 칸으로 그린다
const unwrapPaste = t => t.replace(/<\/?pasted_content(?: id="[^"]*")?>/g, '').trim();
// 일하던 중에 Esc로 멈추면 Claude Code가 내 말 자리에 남기는 표시. 내 말풍선이 아니라 흐린 안내 줄(notice)로 보인다(터미널의 'Interrupted')
const INTERRUPT = /^\[Request interrupted by user( for tool use)?\]$/;
const interruptNote = m => m[1] ? '도구 실행 중 중단함' : '여기서 중단함';
function chatItems(entries) {
  const out = [];
  for (const d of entries) {
    // 자동 압축 요약(isCompactSummary)은 Claude Code가 내 말처럼 넣은 긴 글이라 보이지 않는다(터미널에서도 접혀 있다)
    // Claude가 일하는 중에 보낸 말은 user 항목이 아니라 첨부(queued_command)로 남는다. 이것도 내 말풍선으로
    // 다른 세션이 SendMessage로 보낸 말: 쉬던 중이면 isMeta user 항목, 일하던 중이면 queued_command 첨부로 남는다. 보낸 세션 이름을 붙여 따로 보인다(내 말로 세지 않는다)
    const peer = !d.isSidechain && (d.type === 'user' ? d.origin : d.type === 'attachment' && d.attachment?.type === 'queued_command' ? d.attachment.origin : null);
    if (peer?.kind === 'peer') { if (peer.body?.trim()) out.push({ id: d.uuid || String(out.length), at: Date.parse(d.timestamp) || 0, t: 'peer', name: peer.name || '', text: peer.body.trim() }); continue; }
    const q = d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.commandMode === 'prompt' && !d.isSidechain ? d.attachment : null;
    if (q) { const t = typeof q.prompt === 'string' ? q.prompt : textOf(q.prompt); if (t.trim()) out.push({ id: d.uuid || String(out.length), at: Date.parse(q.timestamp || d.timestamp) || 0, t: 'user', text: t.trim() }); continue; }
    if (d.isSidechain || d.isMeta || d.isCompactSummary || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const c = d.message && d.message.content, at = Date.parse(d.timestamp) || 0, id = d.uuid || String(out.length);
    if (d.type === 'user') {
      if (typeof c === 'string') {
        const u = unwrapPaste(c);
        const cmd = c.match(/<command-name>([^<]*)<\/command-name>(?:[\s\S]*<command-args>([^<]*)<\/command-args>)?/);
        const stop = u.match(INTERRUPT);
        if (cmd) out.push({ id, at, t: 'user', text: (cmd[1] + ' ' + (cmd[2] || '')).trim() });
        else if (stop) out.push({ id, at, t: 'notice', text: interruptNote(stop) });
        else if (u && !u.startsWith('<')) out.push({ id, at, t: 'user', text: c.trim() });
        continue;
      }
      // 한 메시지의 글과 이미지는 말풍선 하나로. 이미지는 글 속 [Image #N]이 자리를 표시하므로, 글이 없을 때만 따로 적는다
      for (const x of c || []) { const stop = x.type === 'text' && x.text.trim().match(INTERRUPT); if (stop) out.push({ id: id + ':stop', at, t: 'notice', text: interruptNote(stop) }); }
      const texts = (c || []).filter(x => x.type === 'text' && !INTERRUPT.test(x.text.trim()) && (u => u && !u.startsWith('<'))(unwrapPaste(x.text))).map(x => x.text.trim());
      const imgs = (c || []).filter(x => x.type === 'image').length;
      if (texts.length || imgs) out.push({ id, at, t: 'user', text: texts.join('\n') || `[이미지 ${imgs}장]` });
      for (const [k, x] of (c || []).entries()) {
        if (x.type === 'tool_result') {
          const r = Array.isArray(x.content) ? x.content.filter(y => y.type === 'text').map(y => y.text).join('\n') : x.content;
          out.push({ id: id + k, at, t: 'result', toolId: x.tool_use_id, text: cut(r, 3000), error: !!x.is_error });
        }
      }
    } else {
      for (const [k, x] of (c || []).entries()) {
        if (x.type === 'text' && x.text.trim()) out.push({ id: id + k, at, t: 'assistant', text: x.text });
        else if (x.type === 'tool_use') out.push({ id: id + k, at, t: 'tool', toolId: x.id, name: x.name.replace(/^mcp__(.+?)__/, '$1:'), text: toolInput(x.name, x.input) });
      }
    }
  }
  return out;
}
// 되감기(rewind)나 '답 전에 Esc → 고쳐서 다시 보내기'를 하면 버린 말도 파일에 남고, 새 말은 그 앞 지점(parentUuid)에 이어 붙는다.
// 그래서 내가 친 말의 부모가 그보다 앞서 친 말보다 앞에 있으면, 그 사이(버린 갈래)는 보이지 않는다.
// parentUuid 사슬 전체를 따라가면 안 된다: 병렬 도구 결과 등 사슬 밖에 있는 정상 항목이 많다
const typed = d => d.type === 'user' && !d.isMeta && !d.isCompactSummary && !d.isSidechain && !INTERRUPT.test(textOf(d.message?.content).trim()) &&
  (typeof d.message?.content === 'string' || !(d.message?.content || []).some(x => x.type === 'tool_result'));
function dropRewound(entries) {
  const at = new Map(entries.map((d, i) => [d.uuid, i]));
  const hidden = new Set();
  entries.forEach((d, i) => {
    const from = at.get(d.parentUuid);
    if (!typed(d) || from === undefined) return;
    for (let j = from + 1; j < i; j++) if (typed(entries[j]) && !hidden.has(j)) { for (let k = j; k < i; k++) hidden.add(k); break; }
  });
  return entries.filter((_, i) => !hidden.has(i));
}
// 마지막으로 친 말부터 끝까지의 uuid. 이어 읽을 때 새로 친 말의 부모가 여기 없으면 갈래가 바뀐 것이다(처음부터 다시 그린다)
const sinceTyped = (entries, set = new Set()) => { for (const d of entries) { if (typed(d)) set.clear(); if (d.uuid) set.add(d.uuid); } return set; };
const turns = new Map(); // `${sid}:${next}` -> sinceTyped
const parseLines = text => text.split('\n').flatMap(l => { if (!l) return []; try { return [JSON.parse(l)]; } catch { return []; } });

/* 커밋 조율 장부(`/api/edits`): 저장소의 커밋 안 한 파일마다 어느 세션이 Edit·Write로 고쳤는지.
   떠 있는 세션(하위 에이전트 포함)만 보고, 그 파일의 마지막 커밋 뒤에 고친 것만 센다. Bash로 고친 파일은 모른다(sessions가 빈다) */
const commitLocks = new Map(); // 저장소 → { sid, name, at }
const editCache = new Map(); // 기록 파일 → { size, edits: [{ file, at }] }, 늘어난 만큼만 읽는다
const realOf = f => { try { return fs.realpathSync(f); } catch { return f; } };
function editsIn(file) {
  let size; try { size = fs.statSync(file).size; } catch { return []; }
  let c = editCache.get(file);
  if (!c || size < c.size) { c = { size: 0, edits: [] }; editCache.set(file, c); }
  if (size > c.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size);
      const end = buf.lastIndexOf(10) + 1; // 덜 써진 끝 줄은 다음에 읽는다
      for (const d of parseLines(buf.subarray(0, end).toString('utf8'))) {
        if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
        for (const x of d.message.content) {
          const f = x.type === 'tool_use' && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(x.name) && (x.input?.file_path || x.input?.notebook_path);
          if (f) c.edits.push({ file: realOf(path.resolve(d.cwd || '/', f)), at: Date.parse(d.timestamp) || 0 });
        }
      }
      c.size += end;
    } finally { fs.closeSync(fd); }
  }
  return c.edits;
}
const git = (cwd, args) => new Promise((ok, no) => execFile('git', ['-C', cwd, ...args], { timeout: 8000, maxBuffer: 16e6 }, (e, out) => e ? no(new Error(String(e.message).split('\n')[0])) : ok(out)));
async function repoRoot(cwd) {
  if (!path.isAbsolute(String(cwd || ''))) throw new Error('cwd는 절대 경로여야 합니다');
  return realOf((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
}
async function edits(params) {
  const root = await repoRoot(params.get('cwd'));
  const parts = (await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0');
  const dirty = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    dirty.push({ path: parts[i].slice(3), status: parts[i].slice(0, 2).trim() });
    if (/[RC]/.test(parts[i][0])) i++; // 이름 바꾸기는 다음 칸이 옛 이름
  }
  // 세션마다 고친 파일(저장소 기준 경로) → 마지막으로 고친 시각
  const bySession = snapshot.sessions.map(s => {
    const file = findTranscript({ cwd: s.dir, sessionId: s.sid });
    const subDir = file && path.join(path.dirname(file), s.sid, 'subagents');
    let subs = []; try { subs = fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(subDir, f)); } catch {}
    const last = new Map();
    for (const f of file ? [file, ...subs] : []) for (const e of editsIn(f)) {
      const rel = path.relative(root, e.file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && e.at > (last.get(rel) || 0)) last.set(rel, e.at);
    }
    return { sid: s.sid, name: s.name, title: s.title, last };
  }).filter(s => s.last.size);
  const files = await Promise.all(dirty.map(async d => {
    const since = (Number((await git(root, ['log', '-1', '--format=%ct', '--', d.path]).catch(() => '')).trim()) || 0) * 1000;
    const sessions = bySession.filter(s => (s.last.get(d.path) || 0) > since).map(({ sid, name, title }) => ({ sid, name, title }));
    return { ...d, sessions, shared: sessions.length > 1 };
  }));
  return { root, files };
}

function transcript(params) {
  const sid = params.get('sid') || '';
  if (!/^[0-9a-f-]{36}$/.test(sid)) throw new Error('대화 ID 형식이 아닙니다');
  const live = liveSessions().find(x => x.sessionId === sid);
  const file = findTranscript({ cwd: live ? live.cwd : '', sessionId: sid });
  if (!file) return { next: 0, items: [], missing: true };
  const size = fs.statSync(file).size;
  const read = (from, first) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // 처음 읽을 때는 잘린 첫 줄을 버리고, 끝의 덜 써진 줄은 다음에 읽는다(바이트 기준이라 한글이 잘리지 않는다)
      const start = first && from > 0 ? buf.indexOf(10) + 1 : 0;
      const end = Math.max(start, buf.lastIndexOf(10) + 1);
      return { end: from + end, entries: parseLines(buf.subarray(start, end).toString('utf8')) };
    } finally { fs.closeSync(fd); }
  };
  const reply = (end, entries, turn, reset) => {
    turns.set(sid + ':' + end, turn);
    if (turns.size > 200) turns.delete(turns.keys().next().value); // 닫힌 화면이 남긴 것
    return { next: end, items: chatItems(reset ? dropRewound(entries) : entries), reset };
  };
  let from = Number(params.get('from'));
  const turn = turns.get(sid + ':' + from);
  turns.delete(sid + ':' + from);
  if (from >= 0 && from <= size && turn) {
    const { end, entries } = read(from, false);
    const branched = entries.some(d => {
      const off = typed(d) && d.parentUuid && !turn.has(d.parentUuid);
      sinceTyped([d], turn);
      return off;
    });
    if (!branched) return reply(end, entries, turn, false);
  }
  const { end, entries } = read(Math.max(0, size - 3e6), true); // 처음(또는 갈래가 바뀌면) 끝부분 3MB를 새로 그린다
  return reply(end, entries, sinceTyped(entries), true);
}

/* 이미지 올리기: 대화 화면에 붙여넣거나 끌어다 놓은 이미지를 파일로 저장하고, 그 경로를 Claude에 붙여넣는다(Claude Code는 붙여넣은 이미지 경로를 이미지로 받는다) */
const UPLOAD_DIR = path.join(BOARD_DIR, 'uploads');
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function upload(req, res) {
  const ext = IMAGE_EXT[String(req.headers['content-type'] || '').split(';')[0]];
  if (!ext) return json(res, 400, { error: 'png, jpg, gif, webp 이미지만 올릴 수 있습니다' });
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 20e6) { req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const f = path.join(UPLOAD_DIR, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
    fs.writeFileSync(f, Buffer.concat(chunks), { mode: 0o600 });
    json(res, 200, { path: f });
  });
}
const isUpload = f => typeof f === 'string' && path.resolve(f).startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(f);

/* btw: Claude Code의 /btw를 그 세션(웹, tmux)에 쳐 넣는다. Claude가 일하는 중에도 끊지 않고 화면 위 상자에 답한다.
   상자 바닥 줄에 'c to copy'가 뜨고 답이 더 바뀌지 않으면 c(복사)를 눌러 tmux 복사 칸에 든 답 전체를 읽고(화면은 길면 잘린다),
   Esc로 닫는다. 질문·답은 db.btw에 남는다. 대화를 복사해 따로 묻던 예전 방식(claude -p --fork-session)은 무거워서 버렸다 */
const typing = new Set(); // tmux 이름: 대화에 보낼 말을 넣는 중. 이때 /btw를 치면 보낼 말 뒤에 붙는다
const btwBusy = new Set(); // tmux 이름: 상자가 떠 있는 동안. 이때 친 글자는 상자의 키(c·f·x)가 되므로 대화 보내기를 막는다
async function btwBox(name) {
  const lines = (await tmux(['capture-pane', '-p', '-t', name])).split('\n').map(l => l.trimEnd());
  const foot = lines.findLastIndex(l => /Esc to close/.test(l));
  if (foot < 0) return null;
  const last = lines.findLastIndex((l, i) => i < foot && /^\s*\/btw /.test(l));
  return { ready: /c to copy|Copied/.test(lines[foot]), q: last < 0 ? '' : lines[last].trim(), body: lines.slice(last + 1, foot).join('\n') };
}
const topBuffer = async () => ((await tmux(['list-buffers', '-F', '#{buffer_name}']).catch(() => '')).split('\n')[0] || '');
async function askBtw(name, item) {
  btwBusy.add(name);
  try {
    const q = item.q.replace(/\s+/g, ' ').trim(); // /btw는 한 줄이다
    const before = await topBuffer();
    await tmux(['send-keys', '-t', name, '-l', '--', '/btw ' + q]);
    await sleep(300);
    // 입력칸에 다른 글(전해지지 않은 말 등)이 있었으면 /btw가 그 뒤에 붙어 보통 말로 간다. 내가 친 것만 지우고 묻지 않는다
    if ((await inputBox(name)).replace(/\s+/g, '') !== ('/btw ' + q).replace(/\s+/g, '')) {
      await tmux(['send-keys', '-t', name, '-N', String([...('/btw ' + q)].length), 'BSpace']);
      throw new Error('Claude 입력칸에 다른 글이 있어 묻지 않았습니다');
    }
    await tmux(['send-keys', '-t', name, 'Enter']);
    // 상자 맨 아래 질문이 이것이고, 답이 다 나와(c to copy) 두 번 연달아 같으면 끝난 것으로 본다
    let prev = null, ready = false;
    for (const t0 = Date.now(); Date.now() - t0 < 180e3; await sleep(500)) {
      const box = await btwBox(name);
      const mine = box && box.ready && box.q.startsWith(('/btw ' + q).slice(0, 30));
      if (mine && prev === box.body) { ready = true; break; }
      prev = mine ? box.body : null;
    }
    if (!ready) throw new Error('답을 받지 못했습니다(3분 안에 답이 끝나지 않음)');
    await tmux(['send-keys', '-t', name, 'c']);
    let text = '';
    for (let i = 0; i < 20 && !text; i++) { await sleep(150); if (await topBuffer() !== before) text = await tmux(['show-buffer']); }
    item.state = text ? 'done' : 'error';
    item.a = text ? text.slice(0, 20000) : '답은 왔지만 읽지 못했습니다. 터미널 화면에서 확인하세요.';
  } catch (e) {
    item.state = 'error'; item.a = e.message;
  } finally {
    if (await btwBox(name).catch(() => null)) await tmux(['send-keys', '-t', name, 'Escape']).catch(() => {});
    btwBusy.delete(name);
    item.doneAt = Date.now(); save(); scan();
  }
}

/* 회사 일정(구글 캘린더): ~/.claude/board/calendar.env 에 '이름=비공개 iCal 주소'를 한 줄에 하나(# 주석). 10분마다 캘린더 전체를 받아 두고,
   상태에는 오늘부터 7일을, 달 보기는 요청한 범위(`calendar/range`)를 그때 펼쳐 준다(받아 둔 것을 펼치기만 해서 가볍다).
   반복 일정과 그 예외(한 번만 옮긴 회차)는 ical.js가 펼친다. 주소는 비밀이라 화면·API로 내보내지 않는다 */
const ICAL = require('ical.js');
const CAL_FILE = path.join(BOARD_DIR, 'calendar.env');
let calendar = { at: 0, error: '', events: [], sources: 0 };
let calSources = []; // [{ cal, masters }] 마지막으로 받은 캘린더(펼치기 전)
function expand(from, to) {
  const events = [];
  for (const { cal, masters } of calSources) {
    const push = (ev, s, e) => {
      const start = s.toJSDate(), end = (e || s).toJSDate();
      if (end > from && start < to) events.push({ id: ev.uid + ':' + +start, title: ev.summary || '(제목 없음)', start: +start, end: +end, allDay: s.isDate, cal });
    };
    for (const ev of masters.values()) {
      if (!ev.isRecurring()) { push(ev, ev.startDate, ev.endDate); continue; }
      const it = ev.iterator();
      for (let next, n = 0; (next = it.next()) && n < 5000; n++) {
        if (next.toJSDate() >= to) break;
        const o = ev.getOccurrenceDetails(next);
        push(o.item, o.startDate, o.endDate); // 한 번만 옮긴 회차는 그 회차의 제목을 쓴다
      }
    }
  }
  return events.sort((a, b) => a.start - b.start || b.allDay - a.allDay);
}
async function loadCalendar() {
  let lines = [];
  try { lines = fs.readFileSync(CAL_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); }
  catch { calSources = []; calendar = { at: Date.now(), error: '', events: [], sources: 0 }; return; }
  const sources = [], errors = [];
  for (const line of lines) {
    const m = line.match(/^(?:([^=]+)=)?(https?:\/\/\S+)$/);
    if (!m) { errors.push('알아볼 수 없는 줄이 있습니다'); continue; }
    try {
      const r = await fetch(m[2], { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const comp = new ICAL.Component(ICAL.parse(await r.text()));
      const cal = (m[1] || '').trim() || comp.getFirstPropertyValue('x-wr-calname') || '';
      const all = comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v));
      const masters = new Map(all.filter(e => !e.isRecurrenceException()).map(e => [e.uid, e]));
      for (const e of all) if (e.isRecurrenceException() && masters.has(e.uid)) masters.get(e.uid).relateException(e);
      sources.push({ cal, masters });
    } catch (e) { errors.push(((m[1] || '').trim() || '캘린더') + ': ' + e.message); }
  }
  calSources = sources;
  const from = new Date(); from.setHours(0, 0, 0, 0);
  calendar = { at: Date.now(), error: errors.join(' · '), events: expand(from, new Date(from.getTime() + 7 * 864e5)), sources: lines.length };
  scan();
}

/* 메일(받은편지함): ~/.claude/board/inbox.env 에 '메일주소=앱 비밀번호'(Gmail)를 한 줄에 하나. 2분마다 계정마다 최근 15통의 머리(보낸 사람·제목·시각·읽음)만
   읽기 전용으로 읽는다(읽음 표시를 바꾸지 않는다). 계정들을 합쳐 최근 순으로 30통을 준다. 비밀번호는 화면·API로 내보내지 않는다 */
const { ImapFlow } = require('imapflow');
const INBOX_FILE = path.join(BOARD_DIR, 'inbox.env');
let inbox = { at: 0, error: '', mails: [], accounts: [] };
async function loadInbox() {
  let lines = [];
  try { lines = fs.readFileSync(INBOX_FILE, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); }
  catch { inbox = { at: Date.now(), error: '', mails: [], accounts: [] }; return; }
  const mails = [], errors = [], accounts = [];
  for (const line of lines) {
    const m = line.match(/^([^=\s]+@[^=\s]+)=(.+)$/);
    if (!m) { errors.push('알아볼 수 없는 줄이 있습니다'); continue; }
    const user = m[1];
    accounts.push(user);
    // 구글은 앱 비밀번호를 네 글자씩 띄어 보여 준다
    const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass: m[2].replace(/\s+/g, '') }, logger: false });
    c.on('error', () => {}); // 연결이 끊겨도 서버가 죽지 않게. 실패는 아래 catch가 남긴다
    try {
      await c.connect();
      const lock = await c.getMailboxLock('INBOX', { readOnly: true });
      try {
        const n = c.mailbox.exists;
        if (n) for await (const x of c.fetch(`${Math.max(1, n - 14)}:*`, { envelope: true, flags: true, threadId: true, internalDate: true })) {
          const f = x.envelope.from?.[0] || {};
          mails.push({ id: user + ':' + x.uid, account: user, from: f.name || f.address || '', subject: x.envelope.subject || '(제목 없음)', at: +x.internalDate, unread: !x.flags.has('\\Seen'),
            url: `https://mail.google.com/mail/u/${user}/#inbox` + (x.threadId ? '/' + BigInt(x.threadId).toString(16) : '') });
        }
      } finally { lock.release(); }
      await c.logout();
    } catch (e) { errors.push(user + ': ' + (e.authenticationFailed ? '로그인 실패(앱 비밀번호 확인)' : e.message)); c.close(); }
  }
  mails.sort((a, b) => b.at - a.at);
  inbox = { at: Date.now(), error: errors.join(' · '), mails: mails.slice(0, 30), accounts };
  scan();
}

/* 플로우 안 읽음: ~/.claude/flow.py inbox-json 을 30초마다 돌려 안 읽은 채팅방(마지막 메시지)과 안 읽은 알림을 받는다. 읽기만 한다.
   flow.py 의 세션이 만료되면 flow.py 가 새로 받는데, 그때 브라우저(flow.team)의 로그인이 풀린다(플로우는 웹 로그인을 한 곳만 유지). 데스크톱 앱은 그대로 */
const FLOW_PY = path.join(HOME, '.claude', 'flow.py');
let flow = { at: 0, error: '', chats: [], alarms: [] }, flowBusy = false;
const flowTime = t => { const m = String(t).match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/); return m ? +new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0; };
function loadFlow() {
  if (flowBusy || !fs.existsSync(FLOW_PY)) return Promise.resolve();
  flowBusy = true;
  return new Promise(ok => execFile('/opt/homebrew/bin/python3', [FLOW_PY, 'inbox-json'], { timeout: 60000 }, (e, out, err) => {
    flowBusy = false;
    try {
      if (e) throw new Error(clip(String(err || e.message).trim().split('\n').pop(), 300));
      const d = JSON.parse(out);
      flow = { at: Date.now(), error: '', chats: d.chats.map(c => ({ ...c, at: flowTime(c.at) })).sort((a, b) => b.at - a.at), alarms: d.alarms.map(a => ({ ...a, at: flowTime(a.at) })).sort((a, b) => b.at - a.at) };
    } catch (x) { flow = { ...flow, at: Date.now(), error: x.message }; }
    scan(); ok();
  }));
}

/* Claude 사용량 한도(5시간·주간): 플러그인 hq-usage(~/.claude/my-mods)가 응답마다 ~/.claude/board/usage.json에 남긴다(계정 단위) */
const USAGE_FILE = path.join(BOARD_DIR, 'usage.json');
// 파일에는 어느 계정 값인지가 없어서, 새로 써질 때 로그인돼 있던 계정을 주인으로 기억한다(서버가 켜질 때는 지금 계정).
// 계정을 바꾼 뒤 아무 세션도 답하지 않았으면 주인이 달라 낡은 값이다(usageStale, 화면은 스피너)
let usage = null, usageMtime = 0, usageOwner = '';
function readUsage() {
  try {
    const st = fs.statSync(USAGE_FILE);
    if (st.mtimeMs !== usageMtime) { usageMtime = st.mtimeMs; usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); usageOwner = readAccount()?.email ?? ''; }
  } catch {}
  return usage;
}

/* 세션별 한도 추정(5시간·주간): 한도 창 안에서 세션이 쓴 가중 토큰 ÷ 이 맥 전체 가중 토큰 × 지금 한도 %. 무게는 API 가격 비율. 한도가 실제로 어떻게 세는지는 공개돼 있지 않아 추정이다.
   하위 에이전트 기록(<대화ID>/subagents/)은 원래 세션 몫으로 합친다. 전체 합산은 파일을 다 읽어 몇 초 걸려서 1분 캐시한다 */
const WEIGHT = { input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 };
let windowCache = null; // { start, at, bySid: Map }
async function transcriptFiles(dir, key, since, out) {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) await transcriptFiles(f, key || e.name, since, out);
    else if (e.name.endsWith('.jsonl') && (await fs.promises.stat(f)).mtimeMs >= since) out.push({ file: f, sid: key || e.name.slice(0, -6) });
  }
}
async function windowTokens(start) {
  if (windowCache && windowCache.start === start && Date.now() - windowCache.at < 60000) return windowCache.bySid;
  const files = [];
  for (const d of await fs.promises.readdir(PROJ_DIR).catch(() => [])) await transcriptFiles(path.join(PROJ_DIR, d), '', start, files);
  const byMsg = new Map(); // 같은 답이 여러 줄로 남는다. 마지막 줄이 최종 값
  for (const { file, sid } of files) {
    for (const line of (await fs.promises.readFile(file, 'utf8')).split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const u = d.message?.usage;
      if (d.type !== 'assistant' || !u || !(Date.parse(d.timestamp) >= start)) continue;
      byMsg.set(d.message.id || d.uuid, { sid, w: Object.entries(WEIGHT).reduce((a, [k, v]) => a + (u[k] || 0) * v, 0) });
    }
  }
  const bySid = new Map();
  for (const { sid, w } of byMsg.values()) bySid.set(sid, (bySid.get(sid) || 0) + w);
  windowCache = { start, at: Date.now(), bySid };
  return bySid;
}

/* 이 맥의 Claude 로그인 계정: 모든 세션이 같은 설정 폴더를 쓰므로 하나다. 로그인을 바꾸면 ~/.claude.json이 바뀐다 */
const ACCOUNT_FILE = path.join(os.homedir(), '.claude.json');
let account = null, accountMtime = 0;
function readAccount() {
  try {
    const st = fs.statSync(ACCOUNT_FILE);
    if (st.mtimeMs !== accountMtime) {
      accountMtime = st.mtimeMs;
      const o = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')).oauthAccount;
      account = o?.emailAddress ? { email: o.emailAddress, plan: (o.organizationRateLimitTier || '').replace(/^default_claude_/, '') } : null;
    }
  } catch {}
  return account;
}

/* 계정 바꾸기: 계정 줄을 누르면 tmux 'login'(HQ 목록에 넣지 않는다)에서 claude /login을 화면 없이 띄운다. 사용자는 저절로 열리는 브라우저에서 로그인만 한다.
   ~/.claude/board/login 에서 띄우면 폴더 신뢰 확인이 나오지 않는다(확인함). 로그인 방식 메뉴(1번 구독이 기본)는 Enter를 대신 누르고,
   'Login successful'이 보이거나 이메일이 바뀌면 기본 브라우저의 로그인 완료 탭을 닫고, 새 계정 사용량을 바로 받으려고 그 claude에 '.'을 한 번 보낸다
   (한도 값은 답과 함께만 온다. hq-usage 플러그인이 usage.json에 쓰면, 또는 1분이 지나면 tmux를 끈다). 10분 안에 로그인하지 않으면 그만둔다.
   이미 떠 있던 세션도 새 계정 토큰을 쓴다(확인함) */
const LOGIN_TMUX = 'login', LOGIN_DIR = path.join(BOARD_DIR, 'login');
const LOGIN_TAB = 'https://platform.claude.com/oauth/code/success';
let login = null; // { from: 시작할 때 이메일, at, entered: 방식 메뉴에서 Enter를 눌렀는지, phase: 로그인 뒤 'enter'(완료 화면 넘김)·'ping'(사용량 받는 중), phaseAt, mtime }
async function closeLoginTab() {
  // 기본 브라우저(https를 여는 앱)의 번들 ID로 부른다. Safari·Chrome·Brave·Edge·Arc는 같은 문법이고, AppleScript가 없는 브라우저(Firefox)는 닫지 못한다
  const ls = path.join(HOME, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  const id = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', ls])
    .then(out => JSON.parse(out).LSHandlers.find(h => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll).catch(() => '') || 'com.apple.safari';
  await run('/usr/bin/osascript', ['-e', `tell application id ${JSON.stringify(id)} to close (every tab of every window whose URL starts with ${JSON.stringify(LOGIN_TAB)})`]).catch(() => {});
}
let checking = false; // 2초마다 부르는데 tmux가 늦으면 겹쳐 같은 키를 두 번 보낼 수 있어서
async function checkLogin() {
  if (!login || checking) return;
  checking = true;
  try { await checkLoginOnce(); } finally { checking = false; }
}
async function checkLoginOnce() {
  const screen = await tmux(['capture-pane', '-p', '-t', LOGIN_TMUX]).catch(() => null);
  if (screen === null) { login = null; return; } // 끝났거나 누가 껐다
  const end = async () => { login = null; await tmux(['kill-session', '-t', LOGIN_TMUX]).catch(() => {}); };
  if (login.phase === 'enter') {
    // 완료 화면이 넘어가 입력칸이 나오면 짧은 말을 보낸다
    if (screen.includes('Login successful') && Date.now() - login.phaseAt < 10e3) return;
    Object.assign(login, { phase: 'ping', phaseAt: Date.now(), mtime: usageMtime });
    await tmux(['send-keys', '-t', LOGIN_TMUX, '-l', '.']).catch(() => {});
    await tmux(['send-keys', '-t', LOGIN_TMUX, 'Enter']).catch(() => {});
    return;
  }
  if (login.phase === 'ping') {
    readUsage();
    if (usageMtime !== login.mtime || Date.now() - login.phaseAt > 60e3) await end();
    return;
  }
  const done = screen.includes('Login successful') || (readAccount()?.email ?? '') !== login.from;
  if (done) {
    Object.assign(login, { phase: 'enter', phaseAt: Date.now() });
    await tmux(['send-keys', '-t', LOGIN_TMUX, 'Enter']).catch(() => {});
    await closeLoginTab();
  } else if (Date.now() - login.at > 10 * 60e3) await end();
  else if (!login.entered && screen.includes('Select login method')) {
    login.entered = true;
    await tmux(['send-keys', '-t', LOGIN_TMUX, 'Enter']).catch(() => {});
  }
}

/* 포크본을 즐겨찾기의 원본 바로 밑에 넣는다(원본이 즐겨찾기에 있을 때만). 자동 정렬은 배열 순서가 보이는 순서, 자유 배치는 원본 아래 가장 가까운 빈 칸 */
function favBelow(sid, origin) {
  const items = db.favs.items, i = items.findIndex(x => x.sid === origin);
  if (i < 0 || items.some(x => x.sid === sid)) return;
  const used = new Set(items.map(x => x.slot));
  let slot = items[i].slot + 1;
  while (used.has(slot)) slot++;
  if (db.favs.mode === 'free') items.push({ sid, slot });
  else items.splice(i + 1, 0, { sid, slot });
}

function memoSid(b) {
  if (!/^[0-9a-f-]{36}$/.test(String(b.sid))) throw new Error('대화 ID 형식이 아닙니다');
  return b.sid;
}
// 그 대화의 메모(없으면 만든다). 제목은 메모 보기(F4)에서 닫힌 대화도 알아보게 남겨 둔다
function memoOf(sid) {
  const live = snapshot.sessions.find(x => x.sid === sid), c = db.closed.find(x => x.sid === sid);
  const m = db.memos[sid] = db.memos[sid] || { title: '', text: '', at: 0 };
  m.title = live?.title || c?.title || m.title || sid.slice(0, 8);
  return m;
}

let migrating = false;
const userClosed = new Set(); // 사용자가 '세션 종료'로 닫은 대화: 기록은 남기되 경고(quiet)는 띄우지 않는다
// HQ 밖(Orca·iTerm 등)에서 돈 세션도 경고하지 않는다: 사용자가 일부러 끈 것이다. 경고는 HQ tmux 세션이 한꺼번에 꺼지는 사고만 알린다
const restarting = new Set(); // 다시 띄우는 중인 대화: 잠깐 사라져도 '닫힌 세션'에 넣지 않는다
let notice = null; // 화면에 한 번 띄울 알림 { text, color, at } (세션 하나 재시작이 끝났을 때 등)
// 모두 재시작의 진행: { at, end, items: [{ sid, title, phase, ms, s }] }. phase: wait→kill→start→ok(돌아옴)|fail(30초 안에 안 돌아옴).
// 화면 오른쪽 아래 부팅 패널과 목록의 도는 표시가 이것을 본다(모든 기기). 끝나고 15초 뒤 지운다
let reboot = null;
async function migrateOne(pid) {
  // Orca 세션을 웹으로: Orca 쪽 claude를 /exit로 끝내고, 원래 옵션 그대로 --resume으로 이어 띄운다
  const s = snapshot.sessions.find(x => x.pid === pid);
  const where = handles.get(pid) || {};
  if (!s || !where.orca) throw new Error('Orca에서 도는 세션만 옮길 수 있습니다');
  if (s.state === 'working' || s.state === 'compact' || s.state === 'approval') throw new Error('일하는 중에는 옮길 수 없습니다. 끝난 뒤에 옮겨 주세요');
  const args = argsByPid.get(pid) || keepFlags((await run('/bin/ps', ['-o', 'command=', '-p', String(pid)])).trim().split(/\s+/).slice(1));
  await run(ORCA, ['terminal', 'send', '--terminal', where.orca, '--text', '/exit', '--enter', '--json']);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(500);
  if (alive(pid)) throw new Error('Orca 쪽 Claude가 끝나지 않았습니다. Orca에서 직접 /exit 해 주세요');
  const name = newName();
  await startTmux(name, s.dir, [...args, ...resumeArgs(s.dir, s.sid)]);
  db.web.push({ name, cwd: s.dir, args, sid: s.sid, createdAt: Date.now() });
  if (db.assign[s.sid]) pendingAssign.set(name, db.assign[s.sid]);
  db.closed = db.closed.filter(x => x.sid !== s.sid);
  run(ORCA, ['terminal', 'close', '--terminal', where.orca, '--json']).catch(() => {});
  return name;
}

/* 화면에서 오는 요청 */
const task = id => db.tasks.find(t => t.id === id);
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const routes = {
  'task/add': b => {
    const name = str(b.name, 120); if (!name) throw new Error('업무 이름이 필요합니다');
    const now = Date.now();
    const id = 't' + db.nextId++;
    db.tasks.push({ id, name, memo: str(b.memo), next: '', waits: [], createdAt: now, updatedAt: now });
    return id;
  },
  'task/update': b => {
    const t = task(b.id); if (!t) throw new Error('없는 업무입니다');
    for (const k of ['name', 'memo', 'next']) if (k in b) t[k] = str(b[k], k === 'name' ? 120 : 500);
    if (!t.name) throw new Error('업무 이름이 필요합니다');
    t.updatedAt = Date.now();
  },
  'task/delete': b => {
    db.tasks = db.tasks.filter(t => t.id !== b.id);
    for (const [sid, tid] of Object.entries(db.assign)) if (tid === b.id) delete db.assign[sid];
    delete db.rooms[b.id];
  },
  'assign': b => {
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    if (b.task) { db.assign[b.sid] = b.task; task(b.task).updatedAt = Date.now(); } else delete db.assign[b.sid];
  },
  'seen': b => { db.seen[b.sid] = Date.now(); },
  // 가상 사무실에서 책상을 옮겼을 때: 방 안 위치(0~1 비율)를 남기고, 다른 방(업무)으로 옮겼으면 배치도 바꾼다
  'layout': b => {
    const n = v => Math.min(0.97, Math.max(0.03, Number(v) || 0.5));
    if (!b.sid || typeof b.sid !== 'string') throw new Error('세션이 없습니다');
    if (b.reset) { delete db.layout[b.sid]; return; } // 자동 배치로 되돌리기
    if ('task' in b) routes.assign({ sid: b.sid, task: b.task || '' });
    db.layout[b.sid] = { x: n(b.x), y: n(b.y) };
  },
  // 즐겨찾기(작업 보기의 목록과 대화 사이 칸): 넣은 순서(자동 정렬)와 칸 번호(자유 배치). 칸은 겹치지 않는다
  'favs': b => {
    const mode = b.mode === 'free' ? 'free' : 'auto';
    const seen = new Set(), slots = new Set(), items = [];
    for (const x of Array.isArray(b.items) ? b.items.slice(0, 200) : []) {
      if (!x || typeof x.sid !== 'string' || !/^[0-9a-f-]{36}$/.test(x.sid) || seen.has(x.sid)) continue;
      let slot = Math.min(500, Math.max(0, Math.round(Number(x.slot) || 0)));
      while (slots.has(slot)) slot++;
      seen.add(x.sid); slots.add(slot); items.push({ sid: x.sid, slot });
    }
    db.favs = { mode, items };
  },
  // 가상 사무실의 방(업무 id 또는 'lobby') 자리와 크기. 칸(24px) 단위. 하나를 옮겨도 나머지가 밀리지 않게 화면에 보이는 방 전부를 한꺼번에 받는다
  'rooms': b => {
    if (b.reset) { db.rooms = {}; return; } // 자동 배치로 되돌리기
    const i = (v, lo) => Math.min(400, Math.max(lo, Math.round(Number(v) || 0)));
    for (const [id, r] of Object.entries(b.rooms || {})) {
      if (id !== 'lobby' && !task(id)) continue;
      db.rooms[id] = { x: i(r.x, 0), y: i(r.y, 0), w: i(r.w, 10), h: i(r.h, 6) };
    }
  },
  'wait/add': b => {
    const t = task(b.task); const who = str(b.who, 60), what = str(b.what);
    if (!t || !who || !what) throw new Error('누구와 무엇을 둘 다 적어 주세요');
    t.waits.push({ id: 'w' + db.nextId++, who, what, since: Date.now() }); t.updatedAt = Date.now();
  },
  'wait/done': b => {
    const t = task(b.task); if (!t) throw new Error('없는 업무입니다');
    t.waits = t.waits.filter(w => w.id !== b.id); t.updatedAt = Date.now();
  },
  'session/new': async b => {
    // 웹 세션을 연다. 첫 지시는 claude 인자로 넘기고, 복구할 때는 첫 지시 없이 --resume으로 이어 띄운다.
    // fork: 그 대화를 복제해 새 대화로 띄운다(--resume --fork-session, 폴더는 그 대화의 폴더). name: 세션 이름(--name). 둘 다 웹 안의 Claude가 쓴다(skills/hq-team)
    const fork = b.fork ? String(b.fork) : '';
    if (fork && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fork)) throw new Error('복제할 대화 ID 형식이 아닙니다');
    const forkFile = fork && findTranscript({ cwd: '', sessionId: fork });
    if (fork && !forkFile) throw new Error('복제할 대화 기록을 찾지 못했습니다');
    const forkCwd = forkFile && (readTail(forkFile, Math.min(fs.statSync(forkFile).size, 262144), 262144).match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1];
    const cwd = path.resolve(b.cwd ? String(b.cwd).replace(/^~(?=\/|$)/, HOME) : forkCwd ? JSON.parse(`"${forkCwd}"`) : '');
    if (!(cwd === HOME || cwd.startsWith(HOME + '/')) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('홈 폴더 아래에 있는 폴더를 골라 주세요');
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    const prompt = str(b.prompt, 8000);
    const label = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const extra = [...(fork ? ['--resume', fork, '--fork-session'] : []), ...(label ? ['--name', label] : []), ...(prompt ? [prompt] : [])];
    const name = newName();
    await startTmux(name, cwd, [...db.claudeArgs, ...extra]);
    const favOf = /^[0-9a-f-]{36}$/.test(String(b.favOf)) ? String(b.favOf) : '';
    db.web.push({ name, cwd, args: db.claudeArgs, sid: '', createdAt: Date.now(), ...(fork ? { forkOf: fork } : {}), ...(favOf ? { favOf } : {}) });
    // 포크본은 원본과 같은 업무에 넣는다(목록에서 원본 바로 밑에 붙으려면 같은 묶음이어야 한다)
    const assignTo = b.task || (fork && db.assign[fork]);
    if (assignTo) pendingAssign.set(name, assignTo);
    return name;
  },
  'session/migrate': b => migrateOne(+b.pid),
  // Orca에서 도는 세션을 모두 웹(tmux)으로 옮긴다. 일하는 중인 것은 건너뛴다. 오래 걸리므로 뒤에서 하나씩 한다
  'session/migrate-all': () => {
    if (migrating) throw new Error('이미 옮기는 중입니다');
    const list = snapshot.sessions.filter(x => x.host === 'orca' && x.state !== 'working' && x.state !== 'compact' && x.state !== 'approval');
    if (!list.length) throw new Error('지금 옮길 수 있는 Orca 세션이 없습니다(일하는 중인 것은 끝난 뒤에 옮깁니다)');
    migrating = true;
    (async () => {
      for (const x of list) { try { await migrateOne(x.pid); } catch (e) { console.error('옮기기 실패:', x.title, e.message); } }
      migrating = false; save(); scan();
    })();
    return list.length;
  },
  // 닫힌 세션을 웹에서 같은 옵션으로 다시 연다(하나 또는 여러 개)
  'session/reopen': async b => {
    const sids = Array.isArray(b.sids) ? b.sids : [b.sid];
    const names = [];
    for (const sid of sids) {
      const c = db.closed.find(x => x.sid === sid);
      if (!c) continue;
      if (snapshot.sessions.some(x => x.sid === sid)) { db.closed = db.closed.filter(x => x !== c); continue; }
      const cwd = fs.existsSync(c.dir) ? c.dir : HOME;
      const args = c.args.length ? c.args : db.claudeArgs;
      const name = newName();
      await startTmux(name, cwd, [...args, ...resumeArgs(cwd, sid)]);
      db.web.push({ name, cwd, args, sid, createdAt: Date.now() });
      db.closed = db.closed.filter(x => x !== c);
      names.push(name);
    }
    if (!names.length) throw new Error('다시 열 세션이 없습니다');
    if (names.length === 1) focusReq = { name: names[0], at: Date.now() };
    return names;
  },
  'session/quiet-closed': b => { for (const c of db.closed) if ((b.sids || []).includes(c.sid)) c.quiet = true; },
  // 환경설정의 '모든 대화': 이 맥에 남은 대화 기록 전부(HQ의 닫힌 세션 목록을 비워도, HQ 밖에서 쓴 대화도 나온다). 누를 때만 읽는다
  'history/list': () => {
    const out = [], live = new Map(snapshot.sessions.map(s => [s.sid, s]));
    for (const d of fs.readdirSync(PROJ_DIR)) {
      let names; try { names = fs.readdirSync(path.join(PROJ_DIR, d)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(PROJ_DIR, d, n), sid = n.slice(0, -6);
        let st; try { st = fs.statSync(file); } catch { continue; }
        let c = hcache.get(file);
        if (!c || c.mtime !== st.mtimeMs) {
          // ponytail: 파일마다 끝 1MB만 읽는다. 제목 줄이 그보다 앞에만 있으면 첫 내 말로 대신한다
          const info = {}; scanLines(readTail(file, st.size, 1e6), info);
          let first = '';
          if (!info.title && !info.custom) { const m = readTail(file, Math.min(st.size, 65536), 65536).match(/"type":"user"[^\n]*?"content":"((?:[^"\\]|\\.){1,200})/); if (m) try { first = JSON.parse(`"${m[1]}"`) } catch {} if (first.startsWith('<')) first = '' }
          const cwd = readTail(file, Math.min(st.size, 65536), 65536).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
          c = { mtime: st.mtimeMs, title: info.custom || info.title || first || info.lastPrompt || '(제목 없음)', cwd: cwd ? JSON.parse(`"${cwd[1]}"`) : '' };
          hcache.set(file, c);
        }
        if (!st.size || c.cwd === LOGIN_DIR) continue; // 로그인 claude는 세션이 아니다
        const s = live.get(sid);
        out.push({ sid, title: s?.title || c.title, cwd: c.cwd.replace(HOME, '~'), at: st.mtimeMs, open: !!s });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  },
  'session/forget-closed': b => { db.closed = b.sid ? db.closed.filter(x => x.sid !== b.sid) : []; },
  'session/resume': async b => {
    // 닫힌 대화를 웹에서 다시 연다. 보통 웹 안의 Claude가 대화 기록을 뒤져 찾은 뒤 이 API를 부른다(skills/hq-open)
    const sid = String(b.sid || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid)) throw new Error('대화 ID 형식이 아닙니다');
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    const open = snapshot.sessions.find(x => x.sid === sid);
    if (open && open.host === 'web') { focusReq = { name: open.tmux, at: Date.now() }; return open.tmux; }
    // 다른 곳에서 열려 있으면 막는다. 사용자가 경고를 보고 그래도 열겠다고 하면(force) 같은 대화를 하나 더 띄운다
    if (open && !b.force) throw new Error(`이 대화는 ${open.host === 'orca' ? 'Orca' : '다른 터미널'}에서 열려 있습니다. 거기서 /exit 한 뒤 다시 여세요`);
    const file = findTranscript({ cwd: '', sessionId: sid });
    if (!file) throw new Error('그 대화 기록을 찾지 못했습니다');
    const m = readTail(file, Math.min(fs.statSync(file).size, 262144), 262144).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    const cwd = m && fs.existsSync(JSON.parse(`"${m[1]}"`)) ? JSON.parse(`"${m[1]}"`) : HOME;
    const name = newName();
    await startTmux(name, cwd, [...db.claudeArgs, ...resumeArgs(cwd, sid)]);
    db.web.push({ name, cwd, args: db.claudeArgs, sid, createdAt: Date.now() });
    if (b.task) db.assign[sid] = b.task;
    focusReq = { name, at: Date.now() };
    return name;
  },
  'btw/ask': async b => {
    const question = str(b.question, 4000);
    if (!question) throw new Error('질문을 적어 주세요');
    const s = snapshot.sessions.find(x => x.sid === b.sid && x.host === 'web');
    if (!s) throw new Error('btw는 웹에서 띄운 세션에서만 쓸 수 있습니다(Claude Code 화면을 읽어야 해서)');
    if (btwBusy.has(s.tmux)) throw new Error('앞의 btw 답을 받는 중입니다');
    if (typing.has(s.tmux)) throw new Error('대화에 보낼 말을 넣는 중입니다. 잠깐 뒤에 물으세요');
    if (s.state === 'approval') throw new Error('실행 허락을 기다리는 중에는 물을 수 없습니다');
    if (await rewindScreen(s.tmux)) throw new Error('Claude 쪽에 되감기 창이 열려 있습니다');
    if (await inputBox(s.tmux)) throw new Error('Claude 입력칸에 글이 남아 있어 물을 수 없습니다');
    const list = db.btw[b.sid] = (db.btw[b.sid] || []).slice(-19);
    const item = { id: crypto.randomBytes(4).toString('hex'), q: question, a: '', state: 'asking', at: Date.now() };
    list.push(item);
    askBtw(s.tmux, item);
  },
  'calendar/reload': async () => { await loadCalendar(); return calendar.error || ''; },
  'inbox/reload': async () => { await loadInbox(); return inbox.error || ''; },
  'flow/reload': async () => { await loadFlow(); return flow.error || ''; },
  'flow/open': () => run('/usr/bin/open', ['-a', 'flow']),
  'account/login': async () => {
    if (login) return; // 이미 로그인 중
    fs.mkdirSync(LOGIN_DIR, { recursive: true });
    await tmux(['kill-session', '-t', LOGIN_TMUX]).catch(() => {});
    await tmux(['new-session', '-d', '-s', LOGIN_TMUX, '-c', LOGIN_DIR, '-x', '120', '-y', '40', SHELL, '-lic', 'exec claude /login']);
    login = { from: readAccount()?.email ?? '', at: Date.now(), entered: false };
  },
  // 달 보기: 그 달 칸(앞뒤 주 포함)의 일정. 받아 둔 캘린더를 펼치기만 한다
  'calendar/range': b => {
    const from = +b.from, to = +b.to;
    if (!(to > from) || to - from > 62 * 864e5) throw new Error('일정 범위가 잘못됐습니다');
    return expand(new Date(from), new Date(to));
  },
  'btw/clear': b => { delete db.btw[b.sid]; },
  // 커밋 잠금(skills/hq-commit): 같은 저장소에서 두 세션이 동시에 올리고(add) 커밋하면 남이 올린 것까지 들어간다. 저장소마다 하나.
  // 2분 지나면 풀린 것으로 본다(잡은 Claude가 중간에 죽어도 막히지 않게). 메모리에만 둔다
  'commit/lock': async b => {
    const root = await repoRoot(b.cwd), held = commitLocks.get(root);
    if (held && held.sid !== b.sid && Date.now() - held.at < 120e3) return { ok: false, root, holder: held.name, since: held.at };
    const s = snapshot.sessions.find(x => x.sid === b.sid);
    commitLocks.set(root, { sid: b.sid, name: s ? s.name : String(b.sid || ''), at: Date.now() });
    return { ok: true, root };
  },
  'commit/unlock': async b => {
    const root = await repoRoot(b.cwd);
    if (commitLocks.get(root)?.sid === b.sid) commitLocks.delete(root);
  },
  // 세션 메모: 세션마다 글 하나. 내가 화면의 큰 칸에서 고치거나, 내가 시킬 때 Claude가 한 줄 덧붙인다(skills/hq-memo). 대화 ID에 붙어 있어 닫았다 다시 열어도 남는다
  'memo/set': b => {
    const sid = memoSid(b), text = String(b.text ?? '').slice(0, 20000);
    if (!text.trim()) { delete db.memos[sid]; return; }
    Object.assign(memoOf(sid), { text, at: Date.now() });
  },
  'memo/add': b => {
    const text = str(b.text, 2000); if (!text) throw new Error('메모 내용을 적어 주세요');
    const m = memoOf(memoSid(b));
    Object.assign(m, { text: m.text.trim() ? m.text.replace(/\n*$/, '\n') + text : text, at: Date.now() });
  },
  // 웹 세션 다시 띄우기(전역 CLAUDE.md·.zshrc를 바꾼 뒤 등): 일하는 중이어도 바로 끄고, 같은 tmux 이름·옵션으로 --resume 해서 이어 띄운다.
  // 응답부터 보내고 뒤에서 한다. 이 요청을 보낸 세션(웹 안의 Claude)도 같이 다시 뜬다
  'session/restart': b => {
    const list = db.web.filter(w => !Array.isArray(b.names) || b.names.includes(w.name))
      .map(w => ({ w, s: snapshot.sessions.find(x => x.tmux === w.name) })).filter(x => x.s);
    if (!list.length) throw new Error('다시 띄울 웹 세션이 없습니다');
    // 이름을 안 주면 모두 재시작: 부팅 패널로 진행을 보인다. 세션 하나 재시작은 끝나고 알림만
    const all = !Array.isArray(b.names);
    const r = all ? { at: Date.now(), end: 0, items: list.map(({ s }) => ({ sid: s.sid, title: s.title, phase: 'wait', ms: 0, t0: 0, s })) } : null;
    if (r) reboot = r;
    const item = sid => r?.items.find(x => x.sid === sid);
    const old = new Set(list.map(({ s }) => s.pid));
    const isBack = sid => snapshot.sessions.some(x => x.sid === sid && x.host === 'web' && !old.has(x.pid));
    // 띄운 세션이 새 프로세스로 목록에 돌아오면 ok
    const tick = r && setInterval(() => { for (const x of r.items) if (x.phase === 'start' && isBack(x.sid)) { x.phase = 'ok'; x.ms = Date.now() - x.t0; } }, 300);
    (async () => {
      for (const { w, s } of list) {
        const x = item(s.sid); if (x) { x.phase = 'kill'; x.t0 = Date.now(); }
        restarting.add(s.sid);
        db.keepSince[s.sid] = { state: s.state, since: s.since, at: Date.now() }; // 끄기 전 상태와 그 시각(hq.json)
        w.sid = s.sid; w.createdAt = Date.now(); // 끈 사이에 목록에서 빠지지 않게
        if (s.state !== 'myturn' && s.state !== 'approval') db.seen[s.sid] = Date.now() + 30e3;
        try {
          await tmux(['kill-session', '-t', w.name]).catch(() => {});
          for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(250);
          if (x) x.phase = 'start';
          await startTmux(w.name, w.cwd, [...w.args, ...resumeArgs(w.cwd, s.sid)]);
        } catch (e) { console.error('다시 띄우기 실패:', w.name, e.message); if (x) x.phase = 'fail'; }
      }
      save();
      setTimeout(() => list.forEach(({ s }) => restarting.delete(s.sid)), 30e3);
      // 다 뜨면(새 프로세스로 목록에 돌아오면, 길어도 30초) 알린다
      const back = () => list.every(({ s }) => isBack(s.sid));
      for (let i = 0; i < 60 && !back(); i++) await sleep(500);
      if (r) {
        clearInterval(tick);
        for (const x of r.items) if (x.phase === 'start' && isBack(x.sid)) { x.phase = 'ok'; x.ms = Date.now() - x.t0; } else if (x.phase !== 'ok') x.phase = 'fail';
        r.end = Date.now();
        setTimeout(() => { if (reboot === r) { reboot = null; scan(); } }, 15e3);
      } else notice = { text: `웹 세션 ${list.length}개를 다시 띄웠습니다.`, color: 'teal', at: Date.now() };
      scan();
    })();
    return list.length;
  },
  // 사용량 칸의 동전: 떠 있는 세션 전체(sids, 하나면 sid)가 이번 5시간 창의 한도를 얼마나 썼는지 추정해서 hq.json에 남긴다
  'session/limit-share': async b => {
    const kind = b.kind === 'seven_day' ? 'seven_day' : 'five_hour', name = kind === 'seven_day' ? '주간' : '5시간';
    const lim = readUsage()?.limits.find(l => l.kind === kind);
    const end = lim?.resetsAt && Date.parse(lim.resetsAt);
    if (!end || end < Date.now()) throw new Error(`지금 ${name} 한도 값을 모릅니다(아무 세션에서 한 번 더 답을 받은 뒤 다시 누르세요)`);
    const start = end - (kind === 'seven_day' ? 7 * 24 : 5) * 3600e3, bySid = await windowTokens(start);
    const total = [...bySid.values()].reduce((a, v) => a + v, 0);
    const out = {};
    for (const sid of b.sids || [b.sid]) {
      const share = total ? Math.round((bySid.get(sid) || 0) / total * lim.percentUsed * 10) / 10 : 0;
      out[sid] = db.usageShare[kind][sid] = { share, windowEnd: end, at: Date.now() };
    }
    save(); scanSoon();
    return out;
  },
  // 입력칸 아래 권한 모드·모델·effort를 누를 때: mode는 Shift+Tab 한 번(Claude Code가 모드를 순환한다),
  // model·effort는 /model·/effort 선택창을 띄운다. 고르고 확인하는 것은 사용자가 터미널 화면에서 한다.
  // '/model 이름'처럼 이름까지 치면 새 세션의 기본값까지 바뀌므로 창만 띄운다(창 안에서 s를 누르면 이 세션만)
  'session/menu': async b => {
    const { name, s } = webPane(b.pid);
    if (!['mode', 'model', 'effort'].includes(b.kind)) throw new Error('모르는 메뉴입니다');
    if (['working', 'compact', 'approval'].includes(s.state)) throw new Error('일하는 중에는 바꿀 수 없습니다. 먼저 중단하세요');
    if (await rewindScreen(name)) throw new Error('Claude 쪽에 되감기 창이 열려 있습니다');
    if (b.kind === 'mode') {
      // Shift+Tab 뒤 화면 맨 아래 줄이 바뀔 때까지 기다려 바로 화면에 반영한다(주기 읽기는 3초마다라 늦다)
      const before = footers.get(name)?.mode;
      await tmux(['send-keys', '-t', name, 'BTab']);
      for (let i = 0; i < 8; i++) {
        await sleep(200);
        const f = parseFooter(await tmux(['capture-pane', '-p', '-t', name]).catch(() => ''));
        if (f && f.mode !== before) { footers.set(name, f); break; }
      }
      scanSoon();
      return;
    }
    if (await inputBox(name)) throw new Error('Claude 입력칸에 글이 남아 있습니다. 터미널 화면에서 비운 뒤 다시 하세요');
    await tmux(['send-keys', '-t', name, '-l', '--', '/' + b.kind]);
    await sleep(300);
    await tmux(['send-keys', '-t', name, 'Enter']);
  },
  // /model·/effort 창(과 effort의 확인 창)이 닫혀 보통 입력칸으로 돌아왔는지. 화면이 대화 보기로 돌아갈 때를 알아내는 데 쓴다
  'session/prompt-ready': async b => promptReady(webPane(b.pid).name),
  // 세션 이름 바꾸기: 그 세션에 Claude Code의 /rename을 쳐 넣는다. 세션 이름(상태줄, 다른 Claude가 부르는 이름)과
  // 대화 제목이 함께 바뀌고, 화면 제목은 대화 기록의 custom-title을 따라 바뀐다
  'session/rename': async b => {
    const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new Error('이름을 적어 주세요');
    // 화면은 pid로, 웹 안의 Claude는 대화 ID(sid)로 부른다(skills/hq-team)
    const pid = b.sid ? snapshot.sessions.find(x => x.sid === b.sid)?.pid : +b.pid;
    const where = handles.get(+pid) || {};
    if (where.tmux) {
      if (await rewindScreen(where.tmux)) throw new Error('Claude 쪽에 되감기 창이 열려 있습니다');
      if (await inputBox(where.tmux)) throw new Error('Claude 입력칸에 글이 남아 있어 이름을 바꿀 수 없습니다. 터미널 화면에서 비운 뒤 다시 하세요');
      await tmux(['send-keys', '-t', where.tmux, '-l', '--', '/rename ' + name]);
      await sleep(300);
      await tmux(['send-keys', '-t', where.tmux, 'Enter']);
    } else if (where.orca) await orca(pid, ['terminal', 'send', '--text', '/rename ' + name, '--enter']);
    else throw new Error('다른 터미널에서 직접 띄운 세션은 여기서 이름을 바꿀 수 없습니다');
  },
  'session/close': async b => {
    const w = db.web.find(x => x.name === b.name);
    if (!w) throw new Error('웹에서 연 세션만 여기서 닫을 수 있습니다');
    if (w.sid) userClosed.add(w.sid);
    await tmux(['kill-session', '-t', w.name]).catch(() => {});
    db.web = db.web.filter(x => x !== w);
  },
  'term/switch': b => orca(b.pid, ['terminal', 'switch']),
  'term/send': async b => {
    // 글과 이미지를 쓴 순서대로 받는다: [{ text }, { image: 올린 파일 경로 }, …]. 이미지를 붙인 자리가 Claude에게도 그대로 간다
    const parts = (Array.isArray(b.parts) ? b.parts : [{ text: b.text }]).slice(0, 60)
      .map(x => isUpload(x && x.image) ? { image: x.image }
        : typeof (x && x.paste) === 'string' ? { paste: x.paste.replace(/\r\n?/g, '\n').slice(0, 500000) } // 붙여넣은 긴 글: 붙여넣기로 넣는다
        : { text: String((x && x.text) ?? '').replace(/\r\n?/g, '\n').slice(0, 20000) });
    const first = parts[0], last = parts[parts.length - 1];
    if (first && 'text' in first) first.text = first.text.trimStart();
    if (last && 'text' in last) last.text = last.text.trimEnd();
    const list = parts.filter(x => x.image || x.text || x.paste);
    if (!list.length) throw new Error('보낼 내용이 없습니다');
    if (list.filter(x => x.image).length > 10) throw new Error('이미지는 한 번에 10장까지 보낼 수 있습니다');
    const text = list.length === 1 && list[0].text;
    const where = handles.get(+b.pid) || {};
    if (!where.tmux && !where.orca) throw new Error('이 세션에는 입력을 넣을 수 없습니다');
    // btw 답 상자가 떠 있으면 친 글자가 상자의 키(c·f·x)가 된다
    if (where.tmux && btwBusy.has(where.tmux)) throw new Error('btw 답을 받는 중입니다. 잠깐 뒤에 보내세요');
    // 되감기 창이 떠 있으면 친 글과 Enter가 그 창의 항목을 고른다(되감기가 실행될 수 있다)
    if (where.tmux && await rewindScreen(where.tmux)) throw new Error('Claude 쪽에 되감기 창이 열려 있습니다. 되감기를 마치거나 취소한 뒤 보내세요');
    // 친 글은 친 것처럼 넣고(줄바꿈은 Ctrl-J), 이미지 경로와 붙여넣은 긴 글만 붙여넣기로 넣는다(터미널에서 붙여넣은 것과 똑같이).
    // 친 글까지 붙여넣기로 넣으면 Claude Code가 <pasted_content>로 감싸 Claude가 내 말을 '남이 쓴 글'로 다룬다
    const paste = async t => {
      if (where.tmux) {
        await tmux(['set-buffer', '-b', 'hq', '--', t]);
        await tmux(['paste-buffer', '-p', '-d', '-b', 'hq', '-t', where.tmux]);
      } else await orca(b.pid, ['terminal', 'send', '--text', '\x1b[200~' + t + '\x1b[201~']);
      await sleep(150);
    };
    // 한 번의 tmux 호출로: 줄마다 send-keys -l, 줄 사이에 C-j. 글 안의 줄바꿈 문자는 Claude Code가 버린다
    const type = t => tmux(t.split('\n').flatMap((line, i) => [...(i ? ['send-keys', '-t', where.tmux, 'C-j', ';'] : []),
      ...(line ? ['send-keys', '-t', where.tmux, '-l', '--', line, ';'] : [])]).slice(0, -1));
    if (!where.tmux) {
      if (text && !text.includes('\n')) return orca(b.pid, ['terminal', 'send', '--text', text, '--enter']);
      for (const x of list) await paste(x.image || x.paste || x.text);
      await sleep(120);
      return orca(b.pid, ['terminal', 'send', '--text', '', '--enter']);
    }
    typing.add(where.tmux);
    try {
      for (const x of list) { if (x.image || x.paste) await paste(x.image || x.paste); else await type(x.text); }
      await submit(where.tmux);
    } finally { typing.delete(where.tmux); }
  },
  // 대화 화면의 단축 키: 중단(Esc), 승인 창의 번호 고르기
  'term/key': async b => {
    const keys = { esc: ['Escape', '\x1b'], 1: ['1', '1'], 2: ['2', '2'], 3: ['3', '3'], enter: ['Enter', '\r'] };
    const k = keys[b.key];
    if (!k) throw new Error('모르는 키입니다');
    const where = handles.get(+b.pid) || {};
    if (!where.tmux) return orca(b.pid, ['terminal', 'send', '--text', k[1]]);
    await tmux(['send-keys', '-t', where.tmux, k[0]]);
    if (b.key !== 'esc') return;
    // Claude가 답을 시작하기 전에 중단하면 Claude Code는 보낸 말을 자기 입력칸에 되돌려 놓는다(고쳐서 다시 보내라고).
    // 웹에서는 그 입력칸이 안 보여서, 다음에 보낸 말이 그 뒤에 붙어 둘이 한꺼번에 간다. 그래서 되돌아온 글을 비우고 웹 입력칸으로 돌려준다
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      const text = await inputBox(where.tmux);
      if (text) { await clearInput(where.tmux, text); return { restored: text }; }
    }
  },
  // 되감기: Claude Code의 되감기 창(/rewind)을 tmux 화면에서 읽고 키를 보내 웹 창에서 고르게 한다(웹 세션만).
  // 목록은 맨 아래 (current)에서 위로 한 칸씩 올라가며 고른 줄을 읽어 모은다(창은 몇 줄만 보여서). 고를 때는 그 자리로 옮긴 뒤 글이 맞는지 확인하고 Enter
  'rewind/open': async b => {
    const { name, s } = webPane(b.pid);
    if (['working', 'compact', 'approval'].includes(s.state)) throw new Error('일하는 중에는 되감을 수 없습니다. 먼저 중단하세요');
    if (await inputBox(name)) throw new Error('Claude 입력칸에 글이 남아 있습니다. 터미널 화면에서 비운 뒤 다시 하세요');
    await tmux(['send-keys', '-t', name, '-l', '--', '/rewind']);
    await sleep(300);
    await tmux(['send-keys', '-t', name, 'Enter']);
    let screen = await waitScreen(name, x => x && x.some(l => l.includes('(current)')));
    if (!screen) throw new Error('되감기 창이 열리지 않았습니다');
    const items = [];
    for (let i = 0; i < 50; i++) {
      await tmux(['send-keys', '-t', name, 'Up']);
      const next = await waitScreen(name, x => x && x.join('\n') !== screen.join('\n'), 600);
      if (!next) break; // 맨 위
      screen = next;
      const at = screen.findIndex(l => /^\s*❯ /.test(l));
      if (at < 0) break;
      items.push({ k: i + 1, text: screen[at].replace(/^\s*❯ /, '').trim(), detail: (screen[at + 1] || '').trim() });
    }
    rewinds.set(name, items.length);
    return items.reverse(); // 오래된 것부터
  },
  'rewind/pick': async b => {
    const { name } = webPane(b.pid);
    const pos = rewinds.get(name);
    if (pos === undefined) throw new Error('되감기 창이 열려 있지 않습니다');
    const k = Number(b.k), move = k - pos;
    if (move) await tmux(['send-keys', '-t', name, '-N', String(Math.abs(move)), move > 0 ? 'Up' : 'Down']);
    rewinds.set(name, k);
    await sleep(250);
    const screen = await rewindScreen(name);
    const sel = (screen || []).find(l => /^\s*❯ /.test(l));
    if (!sel || sel.replace(/^\s*❯ /, '').trim() !== String(b.text)) throw new Error('고른 말이 화면과 맞지 않습니다. 다시 열어 주세요');
    await tmux(['send-keys', '-t', name, 'Enter']);
    const confirm = await waitScreen(name, x => x && x.some(l => /^\s*❯ \d+\. /.test(l)));
    if (!confirm) throw new Error('확인 창이 뜨지 않았습니다');
    rewinds.set(name, 'confirm');
    return {
      message: confirm.filter(l => /^\s*│/.test(l)).map(l => l.replace(/^\s*│ ?/, '')).filter(l => !/^\(.+ ago\)$/.test(l)).join('\n').trim(),
      notes: confirm.filter(l => /^\s*(The (code|conversation) |⚠)/.test(l)).map(l => l.trim()),
      // 항목이 많으면 창이 스크롤되어 앞에 ↑·↓가 붙는다
      options: confirm.map(l => l.match(/^\s*(?:[❯↑↓] )?(\d+)\. (.+)$/)).filter(Boolean).map(m => ({ n: +m[1], label: m[2].trim() })),
    };
  },
  'rewind/confirm': async b => {
    const { name } = webPane(b.pid);
    if (rewinds.get(name) !== 'confirm') throw new Error('확인 창이 열려 있지 않습니다');
    const screen = await rewindScreen(name) || [];
    const opts = screen.map(l => l.match(/^\s*([❯↑↓] )?(\d+)\. /)).filter(Boolean);
    const cur = opts.findIndex(m => m[1] === '❯ '), want = opts.findIndex(m => +m[2] === Number(b.n));
    if (cur < 0 || want < 0) throw new Error('고를 수 없는 항목입니다');
    if (want !== cur) await tmux(['send-keys', '-t', name, '-N', String(Math.abs(want - cur)), want > cur ? 'Down' : 'Up']);
    await sleep(200);
    await tmux(['send-keys', '-t', name, 'Enter']);
    rewinds.delete(name);
    await waitScreen(name, x => !x, 3000);
    // 대화를 되돌리면 그때 보낸 말이 Claude 입력칸에 돌아온다. 비우고 웹 입력칸으로 돌려준다
    await sleep(300);
    const text = await inputBox(name);
    if (text) await clearInput(name, text);
    return { restored: text };
  },
  'rewind/cancel': async b => {
    const { name } = webPane(b.pid);
    rewinds.delete(name);
    for (let i = 0; i < 3 && await rewindScreen(name); i++) { await tmux(['send-keys', '-t', name, 'Escape']); await sleep(300); }
  },
};
// 되감기 창: 화면에서 맨 아래 'Rewind' 제목 아래 줄들. 창이 없으면 null
const rewinds = new Map(); // tmux 이름 -> 목록에서 (current) 위로 몇 칸 올라가 있는지, 또는 'confirm'(확인 창)
async function rewindScreen(name) {
  const lines = (await tmux(['capture-pane', '-p', '-t', name])).split('\n');
  const t = lines.map(l => l.trim());
  const top = t.findLastIndex((l, i) => l === 'Rewind' && /^(Restore the code|Confirm you want)/.test(t.slice(i + 1).find(x => x) || ''));
  return top < 0 ? null : lines.slice(top + 1).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
}
async function waitScreen(name, ok, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(40)) { const x = await rewindScreen(name); if (ok(x)) return x || []; }
  return null;
}
function webPane(pid) {
  const name = (handles.get(+pid) || {}).tmux, s = snapshot.sessions.find(x => x.pid === +pid);
  if (!name || !s) throw new Error('웹에서 띄운 세션만 되감을 수 있습니다');
  return { name, s };
}
/* Claude Code 화면 맨 아래(입력칸 아래 줄들): 권한 모드('⏵⏵ bypass permissions on', '⏸ plan mode on' 등, 기본 모드면 안 나온다),
   뒤에서 도는 셸('· 2 shells'), 뒤에서 도는 하위 에이전트('◯ general-purpose  설명  6s · ↓ 44k tokens' 줄들). 웹 세션마다 3초마다 읽는다 */
const footers = new Map(); // tmux 이름 -> { mode, bg: { shells, agents: [설명] }, next: [라벨] }
const MODES = { 'bypass permissions': 'bypassPermissions', 'accept edits': 'acceptEdits', 'plan mode': 'plan', 'auto mode': 'auto', 'manual mode': 'default' };
function parseFooter(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const border = lines.findLastIndex(l => /^─{20,}(?: .+ ─+)?$/.test(l.trim()));
  if (border < 0) return null;
  const below = lines.slice(border + 1);
  const m = below.join('\n').match(/(?:⏵⏵|⏸)\s*([a-z ]+?) on\b/);
  const shells = +(below.join(' ').match(/· (\d+) shells?\b/) || [])[1] || 0;
  const agents = below.map(l => l.match(/^\s*◯\s+(.+?)(?:\s{2,}\d+[smh].*)?$/)).filter(Boolean).map(x => x[1].replace(/\s{2,}/g, ' · '));
  // 에이전트 줄 목록이 접히면 '/tasks to see subagents'만 남는다(몇 개인지는 모른다)
  if (!agents.length && /\/tasks to see subagents/.test(below.join(' '))) agents.push('하위 에이전트(목록은 터미널의 /tasks)');
  // 기본 모드면 모드 글이 없다. 그런데 되감기·질문 창 등이 아래를 덮어도 없으니, 화면에서 못 찾으면 대화 기록의 모드를 쓴다('')
  // next-steps-multi 플러그인의 다음 말 제안: 입력칸 바로 위 'next:' 아래 '  1: ☐ 라벨' 줄들. 화면에 보이는 짧은 라벨만 안다. 오른쪽에 핀보드 칸이 있으면 줄 끝에 '│'가 붙는다
  const top = lines.findLastIndex((l, i) => i < border && /^─{20,}(?: .+ ─+)?$/.test(l.trim()));
  const at = lines.findLastIndex((l, i) => i < top && /^\s*next:\s*│?$/.test(l));
  const next = at < 0 || top - at > 6 ? [] : lines.slice(at + 1, top).map(l => l.match(/^\s*[1-3]: [☐☑] (.+?)\s*│?$/)).filter(Boolean).map(x => x[1]);
  return { mode: m ? MODES[m[1]] || m[1] : '', bg: { shells, agents }, next };
}
let readingFooters = false;
async function readFooters() {
  if (readingFooters) return;
  readingFooters = true;
  try {
    for (const w of db.web) {
      const f = parseFooter(await tmux(['capture-pane', '-p', '-t', w.name]).catch(() => ''));
      if (f) footers.set(w.name, f); else footers.delete(w.name);
    }
  } finally { readingFooters = false; }
}
// Claude Code 입력칸(화면 맨 아래 두 가로줄 사이)에 들어 있는 글. 흐린 글씨(빈 칸 안내·다음 말 추천)는 빈 것으로 본다
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
async function inputBox(name) {
  const raw = (await tmux(['capture-pane', '-p', '-e', '-t', name])).split('\n');
  const plain = raw.map(l => l.replace(ANSI, ''));
  // 위 테두리에는 세션 이름이 들어갈 수 있다(/rename 뒤: '──── 이름 ─')
  const borders = plain.map((l, i) => /^─{20,}(?: .+ ─+)?$/.test(l.trim()) ? i : -1).filter(i => i >= 0);
  if (borders.length < 2) return '';
  const [a, b] = borders.slice(-2);
  const at = plain[a + 1]?.indexOf('❯\u00a0') ?? -1;
  if (at < 0 || raw[a + 1].slice(raw[a + 1].indexOf('❯\u00a0') + 2).startsWith('\x1b[2m')) return '';
  return plain.slice(a + 1, b).map((l, i) => i ? l.replace(/^  /, '') : l.slice(at + 2)).join('\n').trim();
}
// Claude Code의 보통 입력칸(❯ 뒤가 NBSP)이 맨 아래에 떠 있나. /model·/effort 창과 확인 창(❯ 1. …)이 떠 있으면 false
async function promptReady(name) {
  const plain = (await tmux(['capture-pane', '-p', '-t', name])).split('\n');
  const borders = plain.map((l, i) => /^─{20,}(?: .+ ─+)?$/.test(l.trim()) ? i : -1).filter(i => i >= 0);
  if (borders.length < 2) return false;
  return (plain[borders[borders.length - 2] + 1] || '').includes('❯\u00a0');
}
// 보내기(Enter). 이미지를 붙여넣은 바로 뒤의 Enter는 Claude Code가 버릴 때가 있어(글은 입력칸에 남는다) 입력칸이 빌 때까지 다시 누른다.
// 끝내 안 가면 입력칸을 비우고 실패로 돌려준다(웹이 입력칸에 되살리므로, 남겨 두면 다음 말에 붙는다)
async function submit(name) {
  for (let i = 0; i < 5; i++) {
    await sleep(i ? 400 : 120);
    await tmux(['send-keys', '-t', name, 'Enter']);
    await sleep(250);
    if (!(await inputBox(name))) return;
  }
  const left = await inputBox(name);
  if (left) await clearInput(name, left);
  throw new Error('Claude가 보낸 말을 받지 않았습니다. 다시 보내 주세요');
}
// 입력칸 비우기: 커서가 어디 있든 앞뒤로 지운다. Ctrl-C는 빈 칸에서 두 번이면 Claude가 꺼지고, Ctrl-U는 여러 줄을 다 못 지워서 쓰지 않는다
async function clearInput(name, text) {
  const n = String(text.length + 20);
  await tmux(['send-keys', '-t', name, '-N', n, 'BSpace']);
  await tmux(['send-keys', '-t', name, '-N', n, 'DC']);
}
function orca(pid, args) {
  const h = (handles.get(+pid) || {}).orca;
  if (!h) throw new Error('이 세션은 Orca 터미널이 아닙니다');
  return new Promise((ok, fail) => execFile(ORCA, [...args, '--terminal', h, '--json'], { timeout: 15000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok()));
}

/* HTTP */
const createAuth = require('./auth');
const auth = createAuth({ db, save, mailFile: process.env.HQ_MAIL_FILE || path.join(BOARD_DIR, 'mail.env'), ipNamesFile: path.join(BOARD_DIR, 'ip-names.json'), port: PORT });
const LOGIN_PAGE = path.join(__dirname, 'public', 'login.html');
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
const file = (res, f, type) => fs.readFile(f, (e, b) => e ? json(res, 404, { error: 'not found' }) : send(res, 200, type, b));
const TYPES = { '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const APP_FILES = new Set(['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']);
// 빌드된 화면 파일. dist/ 밖의 파일은 내주지 않는다
function asset(res, url) {
  const f = path.join(DIST, path.normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(DIST + path.sep)) return json(res, 404, { error: 'not found' });
  file(res, f, TYPES[path.extname(f)] || 'application/octet-stream');
}

/* 웹 터미널: 브라우저 하나가 붙을 때마다 tmux 클라이언트 하나를 pty로 띄워 출력은 SSE로, 입력은 POST로 주고받는다 */
const ptys = new Map(); // id -> { p, login }
const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
function stream(req, res, params, who) {
  const name = params.get('name') || '';
  if (!/^hq-[a-z0-9]+$/.test(name)) return json(res, 400, { error: 'bad name' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const p = pty.spawn(TMUX, [...TMUX_ARGS, 'attach-session', '-t', name], {
    name: 'xterm-256color', cols: int(params.get('cols'), 20, 500, 120), rows: int(params.get('rows'), 5, 200, 40), cwd: HOME, env: TERM_ENV,
  });
  const id = crypto.randomUUID();
  ptys.set(id, { p, login: who.login ? who.login.id : '' });
  res.write(`event: ready\ndata: ${id}\n\n`);
  const out = s => { if (!res.writableEnded && !res.destroyed) res.write(s); };
  p.onData(d => out(`data: ${JSON.stringify(d)}\n\n`));
  p.onExit(() => { ptys.delete(id); out('event: end\ndata: \n\n'); if (!res.writableEnded) res.end(); });
  req.on('close', () => { ptys.delete(id); try { p.kill(); } catch {} });
}
// 끊은 기기의 터미널 연결은 바로 닫는다
function dropLogins(ids) {
  for (const [id, t] of ptys) if (t.login && ids.includes(t.login)) { ptys.delete(id); try { t.p.kill(); } catch {} }
}
const accessRoutes = {
  'access/lan': (b, who) => {
    if (!who.local) throw new Error('사내망 접속은 이 맥에서만 켜고 끌 수 있습니다');
    db.settings.lan = !!b.on;
    if (!b.on) dropLogins(db.logins.map(l => l.id)); // 끄면 다른 PC의 터미널도 끊는다
  },
  'access/revoke': b => dropLogins(auth.revoke(String(b.id || ''))),
  'access/rename': b => auth.rename(String(b.id || ''), b.label),
  'access/logout': (b, who) => { if (who.login) dropLogins(auth.revoke(who.login.id)); },
};

http.createServer((req, res) => {
  const who = auth.identify(req);
  const [url, qs] = req.url.split('?');
  // 앱 설치 정보와 아이콘(web/public)은 로그인 전에도 내준다: 크롬이 쿠키 없이 받아 가고, 로그인 화면 탭에도 아이콘이 보인다
  if (req.method === 'GET' && APP_FILES.has(url)) return asset(res, url);
  if (!who || !who.local) {
    if (!db.settings.lan) return send(res, 403, 'text/plain; charset=utf-8', '사내망 접속이 꺼져 있습니다. 이 맥에서 HQ를 열어 접속 설정에서 켜 주세요.');
    if (req.method === 'GET' && url === '/login') return file(res, LOGIN_PAGE, 'text/html; charset=utf-8');
    // 로그인 전에는 로그인 화면과 인증번호 요청·확인만 된다
    if (!who && !(req.method === 'POST' && (url === '/auth/request' || url === '/auth/verify'))) {
      if (req.method === 'GET' && url === '/') { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return json(res, 401, { error: '로그인이 필요합니다' });
    }
  }
  if (req.method === 'GET' && url === '/login') return file(res, LOGIN_PAGE, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url === '/') {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) return send(res, 500, 'text/plain; charset=utf-8', '화면이 아직 빌드되지 않았습니다. 저장소에서 npm run build 를 실행하세요.');
    return file(res, path.join(DIST, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.startsWith('/assets/')) return asset(res, url);
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, { ...snapshot, access: auth.status(who) });
  if (req.method === 'GET' && url === '/api/term/stream') return stream(req, res, new URLSearchParams(qs || ''), who);
  if (req.method === 'GET' && url === '/api/transcript') { try { return json(res, 200, transcript(new URLSearchParams(qs || ''))); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (req.method === 'GET' && url === '/api/edits') return edits(new URLSearchParams(qs || '')).then(r => json(res, 200, r), e => json(res, 400, { error: e.message }));
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
  // 다른 사이트가 이 주소로 몰래 요청을 보내지 못하게 전용 헤더를 요구한다(브라우저는 다른 사이트에서 이 헤더를 못 붙인다)
  if (req.headers['x-hq'] !== '1') return json(res, 403, { error: 'forbidden' });
  if (url === '/api/upload') return upload(req, res);
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    try {
      if (url === '/auth/request') return json(res, 200, await auth.requestCode(req));
      if (url === '/auth/verify') { await auth.verifyCode(req, res, b); return json(res, 200, { ok: true }); }
    } catch (e) { return json(res, 400, { error: e.message }); }
    // 키 입력과 크기 조정은 자주 오므로 상태를 다시 만들지 않고 바로 답한다
    if (url === '/api/term/input') { ptys.get(b.id)?.p.write(String(b.data || '')); return send(res, 204, 'text/plain', ''); }
    if (url === '/api/term/resize') { try { ptys.get(b.id)?.p.resize(int(b.cols, 20, 500, 120), int(b.rows, 5, 200, 40)); } catch {} return send(res, 204, 'text/plain', ''); }
    const key = url.slice(5);
    const route = url.startsWith('/api/') && (routes[key] || accessRoutes[key]);
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      const result = await route(b, who);
      save(); scan();
      // 방금 자기 자신을 끊었으면 더 보여 줄 것이 없다
      if (!who.local && !db.logins.includes(who.login)) return json(res, 401, { error: '로그아웃했습니다' });
      json(res, 200, { ...snapshot, access: auth.status(who), result });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
// 모든 주소에서 받되, 사내망 접속이 꺼져 있으면 이 맥 밖의 요청은 위에서 막는다
}).listen(PORT, () => console.log(`claude-session-hq: http://127.0.0.1:${PORT}`));

restoreWeb().finally(() => {
  scan(); setInterval(scan, SCAN_MS);
  setInterval(readFooters, 3000);
  loadCalendar(); setInterval(loadCalendar, 10 * 60e3);
  loadInbox(); setInterval(loadInbox, 2 * 60e3);
  loadFlow(); setInterval(loadFlow, 30e3);
  // 새 세션은 Claude가 세션 파일을 쓰는 순간 바로 훑어 목록에 띄운다(2초 간격을 기다리면 새 세션이 늦게 보인다)
  try { fs.watch(SESS_DIR, scanSoon); } catch (e) { console.error('세션 폴더 감시 실패:', e.message); }
});
