#!/usr/bin/env node
// 설치: 훅을 ~/.claude/settings.json에 등록하고, 로그인하면 서버가 뜨도록 launchd에 올린다. 다시 실행해도 같은 결과다.
// 제거: node scripts/install.js --uninstall (쌓인 데이터 ~/.claude/board는 남긴다)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const HOOK = path.join(ROOT, 'hooks', 'hook.sh');
// $PPID는 훅을 실행한 claude 프로세스다. 서버는 이 번호로 ~/.claude/sessions/<pid>.json과 짝을 맞춘다
const COMMAND = `CLAUDE_PID=$PPID '${HOOK}'`;
const EVENTS = { UserPromptSubmit: null, PreToolUse: '*', PostToolUse: '*', PermissionRequest: '*', Stop: null };
const LABEL = 'dev.gyoomun.claude-session-hq';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', LABEL + '.plist');
const BOARD = path.join(HOME, '.claude', 'board');
// launchd는 nvm 경로를 모르므로 Homebrew Node를 먼저 쓴다
const NODE = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
const PORT = process.env.PORT || '7420';
const uninstall = process.argv.includes('--uninstall');
const ours = h => String(h.command || '').includes('claude-session-hq/hooks/hook.sh');

function updateSettings() {
  const s = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.bak-claude-session-hq');
  s.hooks = s.hooks || {};
  for (const ev of new Set([...Object.keys(s.hooks), ...Object.keys(EVENTS)])) {
    // 다른 도구(Orca 등)의 훅은 그대로 두고 이 프로젝트의 훅만 빼거나 넣는다
    const list = (s.hooks[ev] || []).map(m => ({ ...m, hooks: (m.hooks || []).filter(h => !ours(h)) })).filter(m => m.hooks.length);
    if (!uninstall && ev in EVENTS) {
      const entry = { hooks: [{ type: 'command', command: COMMAND, timeout: 5 }] };
      if (EVENTS[ev]) entry.matcher = EVENTS[ev];
      list.push(entry);
    }
    if (list.length) s.hooks[ev] = list; else delete s.hooks[ev];
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

function launchctl(...args) {
  try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch {}
}

function updateLaunchd() {
  const domain = `gui/${process.getuid()}`;
  launchctl('bootout', domain, PLIST);
  if (uninstall) { fs.rmSync(PLIST, { force: true }); return; }
  fs.mkdirSync(BOARD, { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const log = path.join(BOARD, 'server.log');
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${NODE}</string><string>${path.join(ROOT, 'server.js')}</string></array>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>${PORT}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`);
  launchctl('bootstrap', domain, PLIST);
}

if (!uninstall && !fs.existsSync(path.join(ROOT, 'node_modules', 'node-pty'))) {
  console.error('먼저 npm install 을 실행하세요. (launchd가 쓰는 Node와 같은 Node로 설치해야 합니다: ' + NODE + ')');
  process.exit(1);
}
// 이 저장소의 스킬을 ~/.claude/skills에 링크로 건다(지난 대화를 찾아 웹에서 다시 여는 hq-open 등)
function updateSkills() {
  const dir = path.join(HOME, '.claude', 'skills');
  for (const name of fs.readdirSync(path.join(ROOT, 'skills'))) {
    const link = path.join(dir, name), target = path.join(ROOT, 'skills', name);
    const cur = fs.lstatSync(link, { throwIfNoEntry: false });
    if (cur && !cur.isSymbolicLink()) { console.error(`건너뜀: ${link}가 링크가 아닌 실제 폴더입니다`); continue; }
    if (cur) fs.unlinkSync(link);
    if (!uninstall) { fs.mkdirSync(dir, { recursive: true }); fs.symlinkSync(target, link); }
  }
}

if (!uninstall && !fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('먼저 npm run build 로 화면을 만드세요.');
  process.exit(1);
}
fs.chmodSync(HOOK, 0o755);
updateSettings();
updateSkills();
updateLaunchd();
console.log(uninstall
  ? '제거했습니다. 훅과 자동 실행을 뺐고, 데이터(~/.claude/board)는 남겼습니다.'
  : `설치했습니다. http://127.0.0.1:${PORT} 를 여세요.\n훅은 새로 여는 Claude 세션부터 적용됩니다. 이미 열린 세션도 상태와 제목은 바로 보입니다.`);
