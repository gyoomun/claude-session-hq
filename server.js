// claude-session-hq: 이 Mac의 Claude Code 세션을 모아 보고, 웹 안의 터미널로 직접 일하게 하는 로컬 서버.
// 웹에서 연 세션은 전용 tmux 서버 안에서 돌아 이 서버가 꺼져도 살아 있다. 127.0.0.1에서만 열린다.
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
const PAGE = path.join(__dirname, 'public', 'index.html');
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
let db = { tasks: [], assign: {}, seen: {}, web: [], claudeArgs: ['--dangerously-skip-permissions'], nextId: 1 };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
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
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
function scanLines(text, info) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) info.title = d.aiTitle;
    else if (d.type === 'custom-title' && d.customTitle) info.custom = d.customTitle;
    else if (d.isSidechain || d.isMeta) continue;
    else if (d.type === 'assistant') { const t = textOf(d.message?.content).trim(); if (t) info.lastText = t; }
    else if (d.type === 'user') {
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

function stateOf(s, h, now) {
  const at = s.statusUpdatedAt || s.startedAt || now;
  const fresh = h && h.at >= at - 2000;
  if (fresh && h.event === 'PermissionRequest') return ['approval', h.at];
  if (fresh && h.event === 'PreToolUse' && h.tool === 'AskUserQuestion') return ['myturn', h.at];
  if (s.status === 'busy') return ['working', at];
  if (s.status && s.status !== 'idle') return ['working', at];
  return [at > (db.seen[s.sessionId] || 0) ? 'myturn' : 'idle', at];
}

/* 세션이 어디서 돌고 있나: claude 프로세스의 환경 변수로 안다. 웹 세션은 HQ_TMUX, Orca는 ORCA_TERMINAL_HANDLE. 프로세스마다 한 번만 읽는다. */
const handles = new Map(); // pid -> { tmux, orca }
function loadHandles(pids) {
  const need = pids.filter(p => !handles.has(p));
  if (!need.length) return;
  need.forEach(p => handles.set(p, {}));
  execFile('/bin/ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', need.join(',')], { maxBuffer: 64e6 }, (err, out) => {
    for (const line of (out || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s/);
      if (!m) continue;
      const t = line.match(/ HQ_TMUX=(hq-[a-z0-9]+)/), o = line.match(/ ORCA_TERMINAL_HANDLE=(\S+)/);
      // tmux 안에서 돈다면 웹 세션이다. Orca 변수가 남아 있어도 무시한다
      handles.set(+m[1], t ? { tmux: t[1] } : o ? { orca: o[1] } : {});
    }
  });
}

/* tmux */
const q = a => "'" + String(a).replace(/'/g, "'\\''") + "'";
function tmux(args) {
  return new Promise((ok, fail) => execFile(TMUX, [...TMUX_ARGS, ...args], { env: TERM_ENV, timeout: 10000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok(out)));
}
// 로그인 셸로 claude를 띄운다(.zshrc의 PATH를 쓰려고). claude가 끝나면 tmux 세션도 끝난다
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
  for (const w of db.web) {
    if (names.includes(w.name) || !w.sid) continue;
    // 꺼지기 전에 나를 기다리던 세션만 '내 차례'로 남기고, 나머지는 다시 띄운 것만으로 '내 차례'가 되지 않게 한다
    if (w.state !== 'myturn' && w.state !== 'approval') db.seen[w.sid] = Date.now() + 30e3;
    try { await startTmux(w.name, w.cwd, [...w.args, '--resume', w.sid]); console.log('복구:', w.name, w.sid); }
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

/* 2초마다 전체 상태를 만들고, 상태가 바뀐 세션은 이벤트로 남긴다 */
let snapshot = { now: Date.now(), sessions: [], tasks: [], feed: [] };
const prev = new Map();
const feed = [];
let firstScan = true;
function pushFeed(e) { feed.unshift(e); if (feed.length > 300) feed.length = 300; }
function scan() {
  const now = Date.now();
  const live = liveSessions();
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
    }
    if (!(s.sessionId in db.seen)) {
      const at = s.statusUpdatedAt || s.startedAt || now;
      db.seen[s.sessionId] = s.status === 'idle' && now - at > SEEN_GRACE_MS ? at : 0;
      dirty = true;
    }
    const h = hookInfo(s);
    const t = transcriptInfo(s);
    const [state, since] = stateOf(s, h, now);
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
      act: state === 'working' ? (toolNow ? toolLine(h) : '생각 중') : '',
      msg, prompt: clip(t.lastPrompt, 400), task: db.assign[s.sessionId] || '',
      host: where.tmux ? 'web' : where.orca ? 'orca' : '', tmux: where.tmux || '',
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
    pushFeed({ at: now, sid, title: snapshot.sessions.find(x => x.sid === sid)?.title || sid, task: db.assign[sid] || '', from: st, to: 'closed' });
  }
  // 닫힌 세션의 확인 기록은 지운다. 웹 세션은 다시 뜨는 중일 수 있으니 남긴다
  for (const sid of Object.keys(db.seen)) if (!ids.has(sid) && !db.web.some(w => w.sid === sid)) { delete db.seen[sid]; dirty = true; }
  if (dirty) save();
  firstScan = false;
  snapshot = { now, sessions, tasks: db.tasks, feed: feed.slice(0, 120), orca: fs.existsSync(ORCA), worktrees };
}

/* 화면에서 오는 요청 */
const task = id => db.tasks.find(t => t.id === id);
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const routes = {
  'task/add': b => {
    const name = str(b.name, 120); if (!name) throw new Error('업무 이름이 필요합니다');
    const now = Date.now();
    db.tasks.push({ id: 't' + db.nextId++, name, memo: str(b.memo), next: '', waits: [], createdAt: now, updatedAt: now });
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
  },
  'assign': b => {
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    if (b.task) { db.assign[b.sid] = b.task; task(b.task).updatedAt = Date.now(); } else delete db.assign[b.sid];
  },
  'seen': b => { db.seen[b.sid] = Date.now(); },
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
    // 웹 세션을 연다. 첫 지시는 claude 인자로 넘기고, 복구할 때는 첫 지시 없이 --resume으로 이어 띄운다
    const cwd = path.resolve(String(b.cwd || '').replace(/^~(?=\/|$)/, HOME));
    if (!(cwd === HOME || cwd.startsWith(HOME + '/')) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      throw new Error('홈 폴더 아래에 있는 폴더를 골라 주세요');
    if (b.task && !task(b.task)) throw new Error('없는 업무입니다');
    const prompt = str(b.prompt, 8000);
    const name = newName();
    await startTmux(name, cwd, prompt ? [...db.claudeArgs, prompt] : db.claudeArgs);
    db.web.push({ name, cwd, args: db.claudeArgs, sid: '', createdAt: Date.now() });
    if (b.task) pendingAssign.set(name, b.task);
    return name;
  },
  'session/migrate': async b => {
    // Orca 세션을 웹으로: Orca 쪽 claude를 /exit로 끝내고, 원래 옵션 그대로 --resume으로 이어 띄운다
    const s = snapshot.sessions.find(x => x.pid === +b.pid);
    const where = handles.get(+b.pid) || {};
    if (!s || !where.orca) throw new Error('Orca에서 도는 세션만 옮길 수 있습니다');
    if (s.state === 'working' || s.state === 'approval') throw new Error('일하는 중에는 옮길 수 없습니다. 끝난 뒤에 옮겨 주세요');
    const args = keepFlags((await run('/bin/ps', ['-o', 'command=', '-p', String(s.pid)])).trim().split(/\s+/).slice(1));
    await run(ORCA, ['terminal', 'send', '--terminal', where.orca, '--text', '/exit', '--enter', '--json']);
    for (let i = 0; i < 40 && alive(s.pid); i++) await sleep(500);
    if (alive(s.pid)) throw new Error('Orca 쪽 Claude가 끝나지 않았습니다. Orca에서 직접 /exit 해 주세요');
    const name = newName();
    await startTmux(name, s.dir, [...args, '--resume', s.sid]);
    db.web.push({ name, cwd: s.dir, args, sid: s.sid, createdAt: Date.now() });
    if (db.assign[s.sid]) pendingAssign.set(name, db.assign[s.sid]);
    run(ORCA, ['terminal', 'close', '--terminal', where.orca, '--json']).catch(() => {});
    return name;
  },
  'session/close': async b => {
    const w = db.web.find(x => x.name === b.name);
    if (!w) throw new Error('웹에서 연 세션만 여기서 닫을 수 있습니다');
    await tmux(['kill-session', '-t', w.name]).catch(() => {});
    db.web = db.web.filter(x => x !== w);
  },
  'term/switch': b => orca(b.pid, ['terminal', 'switch']),
  'term/send': async b => {
    const text = str(b.text, 4000); if (!text) throw new Error('보낼 내용이 없습니다');
    const where = handles.get(+b.pid) || {};
    if (where.tmux) {
      await tmux(['send-keys', '-t', where.tmux, '-l', text]);
      return tmux(['send-keys', '-t', where.tmux, 'Enter']);
    }
    return orca(b.pid, ['terminal', 'send', '--text', text, '--enter']);
  },
};
function orca(pid, args) {
  const h = (handles.get(+pid) || {}).orca;
  if (!h) throw new Error('이 세션은 Orca 터미널이 아닙니다');
  return new Promise((ok, fail) => execFile(ORCA, [...args, '--terminal', h, '--json'], { timeout: 15000 },
    (err, out, errOut) => err ? fail(new Error(clip((errOut || err.message).trim(), 300))) : ok()));
}

/* HTTP */
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
const VENDOR = {
  '/vendor/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};

/* 웹 터미널: 브라우저 하나가 붙을 때마다 tmux 클라이언트 하나를 pty로 띄워 출력은 SSE로, 입력은 POST로 주고받는다 */
const ptys = new Map();
const int = (v, lo, hi, d) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));
function stream(req, res, params) {
  const name = params.get('name') || '';
  if (!/^hq-[a-z0-9]+$/.test(name)) return json(res, 400, { error: 'bad name' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const p = pty.spawn(TMUX, [...TMUX_ARGS, 'attach-session', '-t', name], {
    name: 'xterm-256color', cols: int(params.get('cols'), 20, 500, 120), rows: int(params.get('rows'), 5, 200, 40), cwd: HOME, env: TERM_ENV,
  });
  const id = crypto.randomUUID();
  ptys.set(id, p);
  res.write(`event: ready\ndata: ${id}\n\n`);
  const out = s => { if (!res.writableEnded && !res.destroyed) res.write(s); };
  p.onData(d => out(`data: ${JSON.stringify(d)}\n\n`));
  p.onExit(() => { ptys.delete(id); out('event: end\ndata: \n\n'); if (!res.writableEnded) res.end(); });
  req.on('close', () => { ptys.delete(id); try { p.kill(); } catch {} });
}

http.createServer((req, res) => {
  // 다른 사이트가 localhost로 요청을 보내지 못하게 Host와 전용 헤더를 확인한다
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden' });
  const [url, qs] = req.url.split('?');
  if (req.method === 'GET' && url === '/') return fs.readFile(PAGE, (e, b) => e ? json(res, 500, { error: e.message }) : send(res, 200, 'text/html; charset=utf-8', b));
  if (req.method === 'GET' && VENDOR[url]) return fs.readFile(require.resolve(VENDOR[url][0]), (e, b) => e ? json(res, 404, { error: 'not found' }) : send(res, 200, VENDOR[url][1], b));
  if (req.method === 'GET' && url === '/api/state') return json(res, 200, snapshot);
  if (req.method === 'GET' && url === '/api/term/stream') return stream(req, res, new URLSearchParams(qs || ''));
  if (req.method !== 'POST' || !url.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (req.headers['x-hq'] !== '1') return json(res, 403, { error: 'forbidden' });
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let b; try { b = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    // 키 입력과 크기 조정은 자주 오므로 상태를 다시 만들지 않고 바로 답한다
    if (url === '/api/term/input') { ptys.get(b.id)?.write(String(b.data || '')); return send(res, 204, 'text/plain', ''); }
    if (url === '/api/term/resize') { try { ptys.get(b.id)?.resize(int(b.cols, 20, 500, 120), int(b.rows, 5, 200, 40)); } catch {} return send(res, 204, 'text/plain', ''); }
    const route = routes[url.slice(5)];
    if (!route) return json(res, 404, { error: 'not found' });
    try {
      const result = await route(b);
      save(); scan();
      json(res, 200, { ...snapshot, result });
    } catch (e) { json(res, 400, { error: e.message }); }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`claude-session-hq: http://127.0.0.1:${PORT}`));

restoreWeb().finally(() => { scan(); setInterval(scan, SCAN_MS); });
