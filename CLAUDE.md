# claude-session-hq

Claude Code 세션 여러 개를 브라우저 한 화면에서 보고, 그 안의 터미널로 직접 일하는 개인용 작업 공간이다. 목표는 사용자가 업무 중에 이 웹사이트만 보는 것이고, 지금 쓰는 Orca를 대신한다.
하지 않는 일: 원격 머신 세션, 여러 사람이 같이 쓰기, Claude 대신 판단하기(브리핑은 화면에서 규칙으로 계산한다).
앞으로 할 일(사용자 요청): 세션별 문서(md·html 리포트)와 웹뷰를 보여 주는 칸. 영상의 Muster처럼 세션 하나에 문서 칸 하나가 짝지어지는 모습.

## 실행·반영
- 서버는 launchd(`dev.gyoomun.claude-session-hq`)가 Homebrew Node로 띄운다. 주소는 http://127.0.0.1:7420
- `server.js`를 고친 뒤: `launchctl kickstart -k gui/$(id -u)/dev.gyoomun.claude-session-hq`. 웹 세션은 tmux에서 돌므로 서버를 재시작해도 끊기지 않는다
- 화면은 `web/`(Vite + React + Mantine, TypeScript)이고 서버는 빌드 결과 `dist/`를 내준다. 화면을 고친 뒤: `PATH=/opt/homebrew/bin:$PATH npm run typecheck && npm run build` 후 브라우저 새로고침(서버 재시작 불필요). 바로바로 보면서 고치려면 `npm run dev`(5173, API는 7420으로 넘김)
- 로그인 화면 `public/login.html`은 빌드 없이 그대로 내주는 단독 페이지다
- 의존성: `PATH=/opt/homebrew/bin:$PATH npm install`(launchd와 같은 Node로 깔아야 node-pty가 맞는다). 설치·제거: `node scripts/install.js` / `--uninstall`. 로그: `~/.claude/board/server.log`
- 실험은 `PORT=7499 node server.js`로 따로 띄운다. 데이터 파일과 tmux 소켓은 같이 쓰므로 시험 세션·업무는 지운다

## 구조
- `server.js`: 2초마다 세션 파일·대화 기록·훅 파일·tmux를 읽어 상태를 만들고, 페이지·`/api/*`·터미널 스트림을 제공
- `web/src/`: 화면. `store.ts`(서버 상태 2초 폴링·쓰기 요청), `ui.ts`(보기·선택·창 상태, 주소 #으로 뒤로가기), `App.tsx`(머리·카운터·보기 전환), `Work.tsx`(작업 보기), `Board.tsx`(업무별·세션 전체·내 차례 큐), `Drawers.tsx`, `Modals.tsx`, `Terminal.tsx`(xterm), `Desk.tsx`(픽셀 책상·사람)
- 디자인은 Mantine 컴포넌트를 쓰고, 상태 색은 Mantine 색 이름(`util.tsx`의 `COLOR`)으로 맞춘다. 사용자의 다른 프로젝트(moa)와 같은 조합이라 골랐다
- `tmux.conf`: 웹 세션용 전용 tmux 설정(상태줄·단축키 끔)
- `hooks/hook.sh`: Claude Code 훅. 이벤트를 `~/.claude/board/hooks/<pid>.json`에 덮어쓰기만 한다
- `auth.js`: 사내망 접속 인증(메일 인증번호 → 로그인 쿠키, 로그인 기기 목록·끊기). 외부 라이브러리 없이 SMTP로 메일을 보낸다
- `public/login.html`: 다른 PC가 처음 들어올 때 보는 로그인 화면
- `skills/hq-open`: 웹 안의 Claude가 지난 대화를 기록에서 찾아 `/api/session/resume`으로 다시 여는 스킬. install.js가 `~/.claude/skills`에 링크한다
- `scripts/install.js`: settings.json 훅 등록 + 스킬 링크 + launchd plist

## 핵심 개념
- 열린 세션의 기준은 `~/.claude/sessions/<pid>.json` 중 프로세스가 살아 있고 `kind`가 interactive인 것. `status`는 `busy`/`idle`
- 세션이 어디서 도는지(`host`)는 claude 프로세스 환경 변수로 안다(`ps -E`). `HQ_TMUX=hq-…`면 웹, `ORCA_TERMINAL_HANDLE`이면 Orca
- 웹 세션 = 전용 tmux 세션 하나. `$SHELL -lic 'exec claude …'`로 띄워서 claude가 끝나면 tmux 세션도 끝난다. `db.web`에 이름·폴더·옵션·대화 ID·마지막 상태를 남긴다
- 복구: 서버가 켜질 때 `db.web`에 있는데 tmux에 없는 세션을 `claude <args> --resume <sid>`로 다시 띄운다. 스스로 끝난 세션은 scan이 `db.web`에서 빼서 다시 띄우지 않는다
- 상태 판정(`stateOf`): 승인 요청 훅 → 승인 필요, AskUserQuestion → 내 차례, busy → 작업중, idle이면서 `statusUpdatedAt > seen` → 내 차례, 아니면 쉼
- `seen[sessionId]`: 확인함을 누른 시각. 처음 보는 세션이 30분 넘게 쉬던 중이면 쉼으로 시작. 복구한 세션은 꺼지기 전 상태가 내 차례가 아니었으면 쉼으로 시작
- 업무 배치는 sessionId 기준(`db.assign`). 폴더(cwd)로 묶지 않는다. 사용자가 폴더 단위 묶음을 짐으로 느껴서 일부러 뺐다
- 대화(파일)와 세션(돌고 있는 claude 프로그램)은 다르다. Orca든 웹이든 같은 `~/.claude` 기록을 쓰고, 웹에서 키보드를 꽂을 수 있는 건 웹 tmux에서 돈 프로그램뿐이다. 그래서 지난 대화는 옮기지 않고 `--resume`으로 다시 띄운다
- `focus`: 화면 밖(웹 안의 Claude 등)에서 세션을 열면 서버가 `focus`를 내보내고, 열려 있는 화면이 그 세션으로 넘어간다
- 세션 제목 순서: custom-title → 탭 제목(tmux pane_title 또는 Orca) → ai-title → `name`

## 함정
- tmux 단축키(prefix)는 꺼 두어야 한다. Ctrl+B는 Claude Code가 쓴다
- tmux와 그 안의 셸에는 새로 만든 환경(`TERM_ENV`)만 넘긴다. Orca나 Claude의 변수(ORCA_*, CLAUDECODE)가 섞이면 세션 판별과 claude 실행이 틀어진다
- 숨겨진 칸에서 xterm 크기를 맞추면 tmux 창이 아주 작아진다. 칸이 보일 때만 맞춘다
- launchd plist의 `AbandonProcessGroup`을 빼면 서버 재시작 때 tmux와 세션까지 같이 죽을 수 있다
- node-pty 미리 빌드된 `spawn-helper`는 실행 권한 없이 깔린다. `postinstall`이 권한을 준다
- 훅 명령은 `CLAUDE_PID=$PPID '<hook.sh>'` 형태여야 한다. `$PPID`가 claude 프로세스여야 세션 파일과 짝이 맞는다. 훅은 stdout에 아무것도 쓰면 안 된다
- launchd는 nvm 경로를 모른다. Node 경로를 `/opt/homebrew/bin/node`로 고정했다
- 접근 판정(`auth.identify`): 이 맥(루프백 주소 + Host가 localhost)이면 로그인 없이 통과, 아니면 로그인 쿠키가 있어야 한다. 사내망 접속(`db.settings.lan`)이 꺼져 있으면 맥 밖 요청은 모두 403. 맥에서 터널(cloudflared 등)로 들어온 요청은 Host가 달라 로그인을 요구받는다
- 모든 쓰기 요청은 `x-hq: 1` 헤더가 있어야 받는다. 다른 사이트가 이 주소로 몰래 요청을 보내는 것을 막는 장치라 빼지 않는다. 쿠키는 HttpOnly·SameSite=Strict
- 기기 이름: 주인이 붙인 이름(`db.deviceNames`, IP별) → `~/.claude/board/ip-names.json`(회사 IP 목록 `04note/work/engsoft/handover/trilium/network/office-lan/attachments/engsoft-ip-list.xlsx`의 '내부' 시트에서 사용 중인 IP·이름·부서를 뽑아 만든 것. 동료 이름이 들어 있어 저장소에 넣지 않는다) → NetBIOS PC 이름 → 기기 종류. 엑셀이 바뀌면 파일을 다시 뽑는다
- 보기 전환은 주소 끝(`#work`·`#task`·`#all`)에 남겨 브라우저·마우스 뒤로가기로 돌아간다. 보기를 바꿀 때는 `ui.ts`의 `setMode()`/`pick()`을 쓴다
- 인증번호·로그인 토큰은 해시로만 `hq.json`에 저장한다. 메일 설정(`~/.claude/board/mail.env`)은 사용자가 직접 만든다(비밀번호가 들어가므로 Claude가 쓰지 않는다)
- 시험할 때는 `HQ_MAIL_FILE`로 메일 설정 파일을 바꾸고, `SMTP_SECURE=0`이면 TLS 없이 붙는다(가짜 SMTP로 시험하려고 둔 것)
- Orca → 웹 옮기기는 Orca 쪽 claude에 `/exit`를 보내고 프로세스가 끝나길 기다린 뒤 이어 띄운다. 일하는 중에는 막는다
- 연결된 Claude in Chrome은 다른 PC(Windows)라 이 Mac의 localhost를 열 수 없다. 화면 확인은 Mac의 headless Chrome(DevTools로 조작)으로 한다

## 확인하지 못한 것
- 실제 사람 손으로 웹 터미널을 오래 써 보지 않았다(스크롤·복사·한글 입력기·붙여넣기)
- 승인 대기(PermissionRequest)와 AskUserQuestion 표시는 실제 상황에서 확인하지 않았다
- 실제 맥 재부팅 뒤 복구는 tmux를 죽여서 흉내 낸 것만 확인했다

## 작업 방식
- 작업자는 한 명이다. main에서 바로 작업하고 기능 단위로 커밋·푸시한다. 계획을 따로 보고하지 않고 끝까지 진행한다
- 공개 저장소다. 업무 내용이 담긴 데이터는 저장소 밖(`~/.claude/board`)에만 둔다
