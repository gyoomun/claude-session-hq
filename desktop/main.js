// HQ 화면을 크롬 없이 창 하나에 띄운다. 크롬이 먼저 가져가던 ⌘T·⌘W·Ctrl+Tab을 화면이 그대로 받는다.
// 맥은 이 맥의 HQ(127.0.0.1)를, 윈도우는 처음 켤 때 입력한 맥 주소를 연다. 로그인 쿠키는 앱 안에 남는다.
const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(app.getPath('userData'), 'config.json');
const SETUP = 'https://hq-setup.invalid/'; // 주소 입력 폼이 보내는 가짜 주소. 실제로 가지 않고 가로챈다
const isMac = process.platform === 'darwin';
const DEFAULT = isMac ? 'http://127.0.0.1:7420/#work' : '';

const readUrl = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).url || ''; } catch { return ''; } };
const saveUrl = url => fs.writeFileSync(CONFIG, JSON.stringify({ url }));

// 서버 주소 입력 화면. 연결에 실패해도 이 화면으로 돌아와 주소를 고칠 수 있다
function setupPage(url, error) {
  const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Claude Session HQ</title>
<style>body{font:15px system-ui,sans-serif;background:#1a1b1e;color:#ddd;display:grid;place-items:center;height:100vh;margin:0}
form{display:grid;gap:10px;width:360px}input,button{font:inherit;padding:8px;border-radius:6px;border:1px solid #444;background:#25262b;color:#eee}
button{background:#2f6f4f;cursor:pointer}.err{color:#e88}</style>
<form action="${SETUP}"><b>HQ 서버 주소</b><input name="url" value="${esc(url)}" placeholder="http://192.168.0.10:7420" autofocus required>
${error ? `<div class="err">${esc(error)}</div>` : ''}<button>연결</button></form>`);
}

function createWindow() {
  const win = new BrowserWindow({ width: 1600, height: 1000, backgroundColor: '#1a1b1e', autoHideMenuBar: true });
  const open = url => win.loadURL(url).catch(() => {});
  const url = readUrl() || DEFAULT;
  url ? open(url) : open(setupPage(''));

  win.webContents.on('will-navigate', (e, to) => {
    if (!to.startsWith(SETUP)) return;
    e.preventDefault();
    const next = new URL(to).searchParams.get('url').trim().replace(/\/+$/, '');
    saveUrl(next);
    open(next);
  });
  win.webContents.on('did-fail-load', (e, code, desc, failed, isMainFrame) => {
    if (isMainFrame && !failed.startsWith('data:')) open(setupPage(readUrl() || DEFAULT, `연결하지 못했습니다 (${desc})`));
  });
  // 메일·일정 링크(window.open)는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 메뉴에는 단축키가 화면과 겹치지 않는 것만 둔다(닫기 ⌘W·새로고침 등은 뺀다). 맥은 편집 메뉴가 없으면 복사·붙여넣기가 안 된다
Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([
  { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
  { role: 'editMenu' },
]) : null);

app.whenReady().then(createWindow);
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
