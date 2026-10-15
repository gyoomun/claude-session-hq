# claude-session-hq

이 Mac에서 열린 Claude Code 세션을 브라우저 한 화면에 모아, 업무 단위로 묶어 보는 개인용 관제판이다. 목적은 "탭을 오가지 않고 지금 나를 기다리는 세션과 늦어지는 업무를 한눈에 보는 것"이다.
하지 않는 일: 원격 머신 세션 수집, 여러 사람이 같이 쓰기, Claude 대신 판단하기(브리핑은 화면에서 규칙으로 계산한다).

## 실행·반영
- 서버는 launchd(`dev.gyoomun.claude-session-hq`)가 Homebrew Node로 띄운다. 주소는 http://127.0.0.1:7420
- `server.js`를 고친 뒤: `launchctl kickstart -k gui/$(id -u)/dev.gyoomun.claude-session-hq`
- `public/index.html`만 고쳤으면 브라우저 새로고침으로 충분하다(서버가 요청마다 파일을 읽는다)
- 훅·launchd 설치/제거: `node scripts/install.js` / `--uninstall`. 서버 로그: `~/.claude/board/server.log`
- 실험할 때는 `PORT=7499 node server.js`로 따로 띄운다. 단 데이터 파일(`~/.claude/board/hq.json`)은 같이 쓰므로 시험용 업무는 지운다

## 구조
- `server.js`: 2초마다 세션 파일·대화 기록·훅 파일을 읽어 상태를 만들고, 페이지와 `/api/*`를 제공
- `public/index.html`: 화면 전부(빌드 없음). 2초마다 `/api/state`를 읽는다
- `hooks/hook.sh`: Claude Code 훅. 이벤트를 `~/.claude/board/hooks/<pid>.json`에 덮어쓰기만 한다
- `scripts/install.js`: settings.json 훅 등록 + launchd plist

## 핵심 개념
- 열린 세션의 기준은 `~/.claude/sessions/<pid>.json` 중 프로세스가 살아 있고 `kind`가 interactive인 것. `status`는 `busy`/`idle`
- 상태 판정(`stateOf`): 승인 요청 훅 → 승인 필요, AskUserQuestion → 내 차례, busy → 작업중, idle이면서 `statusUpdatedAt > seen` → 내 차례, 아니면 쉼
- `seen[sessionId]`: 확인함을 누른 시각. 처음 보는 세션이 30분 넘게 쉬던 중이면 그 시각으로 채워 쉼으로 시작한다
- 업무 배치는 sessionId 기준(`db.assign`). 폴더(cwd)로 묶지 않는다. 사용자가 폴더 단위 묶음을 짐으로 느껴서 일부러 뺐다
- 세션 제목 순서: custom-title → Orca 탭 제목 → ai-title → `name`(예: etc-ef)

## 함정
- 훅 명령은 `CLAUDE_PID=$PPID '<hook.sh>'` 형태여야 한다. `$PPID`가 claude 프로세스여야 세션 파일과 짝이 맞는다
- 훅은 stdout에 아무것도 쓰면 안 된다(UserPromptSubmit 출력은 대화에 섞인다). 큰 입력은 16KB만 남기고 나머지는 읽어 버린다. 잘린 JSON은 서버가 정규식으로 읽는다
- launchd는 nvm 경로를 모른다. Node 경로를 `/opt/homebrew/bin/node`로 고정했다
- Orca 터미널 핸들은 `ps -E`로 claude 프로세스 환경 변수 `ORCA_TERMINAL_HANDLE`에서 읽는다. 터미널 열기·답 보내기는 `orca terminal switch/send`
- 새 세션은 `orca terminal create --worktree path:<폴더> --command "claude '<첫 지시>'"`로 연다. 명령은 셸에 타이핑되므로 첫 지시의 줄바꿈은 공백으로 바꾼다. 폴더는 Orca 워크스페이스(`orca worktree list`의 `result.worktrees`)만 허용한다
- 새 세션의 업무 배치는 만들 때 받은 Orca 핸들로 기억해 두었다가(`pendingAssign`, 메모리), 그 핸들의 세션이 나타나면 넣는다
- 쓰기 API는 Host가 localhost/127.0.0.1이고 `x-hq: 1` 헤더가 있어야 받는다. 다른 사이트가 보내는 요청을 막으려는 것이니 빼지 않는다
- 연결된 Claude in Chrome이 다른 PC(Windows)라 이 Mac의 localhost를 열 수 없다. 화면 확인은 Mac의 headless Chrome 스크린샷으로 한다

## 확인하지 못한 것
- 실제 브라우저에서 끌어다 놓기·메뉴 배치를 손으로 해 보지 않았다(API와 headless 화면만 확인)
- 승인 대기(PermissionRequest)와 AskUserQuestion 표시는 실제 상황에서 확인하지 않았다

## 작업 방식
- 작업자는 한 명이다. main에서 바로 작업하고 기능 단위로 커밋한다. 계획을 따로 보고하지 않고 끝까지 진행한다
- 공개 저장소다. 업무 내용이 담긴 데이터는 저장소 밖(`~/.claude/board`)에만 둔다
