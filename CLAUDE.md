# claude-session-hq

Claude Code 세션 여러 개를 브라우저 한 화면에서 보고, 그 안의 터미널로 직접 일하는 개인용 작업 공간이다. 목표는 사용자가 업무 중에 이 웹사이트만 보는 것이고, 지금 쓰는 Orca를 대신한다.
하지 않는 일: 원격 머신 세션, 여러 사람이 같이 쓰기, Claude 대신 판단하기(브리핑은 화면에서 규칙으로 계산한다).
앞으로 할 일(사용자 요청): 세션별 문서(md·html 리포트)와 웹뷰를 보여 주는 칸. 영상의 Muster처럼 세션 하나에 문서 칸 하나가 짝지어지는 모습.

## 실행·반영
- 서버는 launchd(`dev.gyoomun.claude-session-hq`)가 Homebrew Node로 띄운다. 주소는 http://127.0.0.1:7420
- `server.js`를 고친 뒤: `launchctl kickstart -k gui/$(id -u)/dev.gyoomun.claude-session-hq`. 웹 세션은 tmux에서 돌므로 서버를 재시작해도 끊기지 않는다
- 화면은 `web/`(Vite + React + Mantine, TypeScript)이고 서버는 빌드 결과 `dist/`를 내준다. 화면을 고친 뒤: `PATH=/opt/homebrew/bin:$PATH npm run typecheck && npm run build` 후 브라우저 새로고침(서버 재시작 불필요). 바로바로 보면서 고치려면 `npm run dev`(5173, API는 7420으로 넘김)
- 열려 있는 화면은 데이터만 2초마다 받고 화면 코드는 새로고침해야 바뀐다. 그래서 상태에 `build`(dist/index.html 시각)를 실어 보내고, 화면이 자기보다 새 빌드를 보면 위에 '새 버전이 나왔습니다 [새로고침]'을 띄운다
- 로그인 화면 `public/login.html`은 빌드 없이 그대로 내주는 단독 페이지다
- 의존성: `PATH=/opt/homebrew/bin:$PATH npm install`(launchd와 같은 Node로 깔아야 node-pty가 맞는다). 설치·제거: `node scripts/install.js` / `--uninstall`. 로그: `~/.claude/board/server.log`
- 실험은 `PORT=7499 node server.js`로 따로 띄운다. 데이터 파일과 tmux 소켓은 같이 쓰므로 시험 세션·업무는 지운다

## 구조
- `server.js`: 2초마다 세션 파일·대화 기록·훅 파일·tmux를 읽어 상태를 만들고, 페이지·`/api/*`·터미널 스트림을 제공
- `web/src/`: 화면. `store.ts`(서버 상태 2초 폴링·쓰기 요청), `ui.ts`(보기·선택·창 상태, 주소 #으로 뒤로가기), `App.tsx`(머리·카운터·보기 전환), `Work.tsx`(작업 보기), `Chat.tsx`(대화 화면), `Board.tsx`(세션 전체·내 차례 큐·이벤트), `Office.tsx`(업무별 보기 = 가상 사무실), `Drawers.tsx`, `Modals.tsx`, `Terminal.tsx`(xterm), `Desk.tsx`(픽셀 책상·사람)
- 디자인은 Mantine 컴포넌트를 쓰고, 상태 색은 Mantine 색 이름(`util.tsx`의 `COLOR`)으로 맞춘다. 사용자의 다른 프로젝트(moa)와 같은 조합이라 골랐다
- `tmux.conf`: 웹 세션용 전용 tmux 설정(상태줄·단축키 끔)
- `hooks/hook.sh`: Claude Code 훅. 이벤트를 `~/.claude/board/hooks/<pid>.json`에 덮어쓰기만 한다
- `auth.js`: 사내망 접속 인증(메일 인증번호 → 로그인 쿠키, 로그인 기기 목록·끊기). 외부 라이브러리 없이 SMTP로 메일을 보낸다
- `public/login.html`: 다른 PC가 처음 들어올 때 보는 로그인 화면
- `skills/hq-open`: 웹 안의 Claude가 지난 대화를 기록에서 찾아 `/api/session/resume`으로 다시 여는 스킬. install.js가 `~/.claude/skills`에 링크한다
- `skills/hq-restart`: "웹 재시작"이라고 하면 Claude가 `/api/session/restart`를 불러 웹 세션을 모두 다시 띄운다(Orca의 "오르카 재시작" 대신). 화면 상단 "모두 재시작" 버튼도 같은 API다. 일하는 중이어도 바로 끄는 것은 사용자가 정한 것이다
- `skills/hq-memo`: 사용자가 시킬 때만 Claude가 세션 메모를 적고 읽고 고친다(`/api/memo/*`, `by: claude`)
- `skills/hq-task`: 세션 안의 Claude가 자기 대화 ID(`~/.claude/sessions/$CLAUDE_PID.json`)로 `/api/assign`·`/api/task/*`를 불러 업무를 만들고·바꾸고·지우고, 자기나 다른 세션을 업무에 넣고 뺀다. 업무를 지우면 그 안의 세션은 미배치로 간다
- `scripts/install.js`: settings.json 훅 등록 + 스킬 링크 + launchd plist

## 핵심 개념
- 열린 세션의 기준은 `~/.claude/sessions/<pid>.json` 중 프로세스가 살아 있고 `kind`가 interactive인 것. `status`는 `busy`/`idle`
- 세션이 어디서 도는지(`host`)는 claude 프로세스 환경 변수로 안다(`ps -E`). `HQ_TMUX=hq-…`면 웹, `ORCA_TERMINAL_HANDLE`이면 Orca
- 웹 세션 = 전용 tmux 세션 하나. `$SHELL -lic 'exec claude …'`로 띄워서 claude가 끝나면 tmux 세션도 끝난다. `db.web`에 이름·폴더·옵션·대화 ID·마지막 상태를 남긴다
- **Orca 의존**: Orca에서 띄운 세션은 Claude 프로세스가 Orca 터미널 안에 산다. 웹은 그 세션에 `orca terminal send`로 입력만 넣으므로, Orca를 끄면 그 세션들은 같이 꺼진다(실제로 Orca 강제 종료 때 전부 사라졌다). 웹(tmux)에서 띄운 세션만 Orca와 무관하다. 그래서 화면 위에 'Orca 안에서 도는 세션 N개' 안내와 '모두 웹으로 옮기기'(`session/migrate-all`, 일하는 중인 것은 건너뜀)를 둔다
- 최근 닫힌 세션(`db.closed`, 7일·60개): 세션이 사라지면 대화 ID·폴더·원래 옵션(ps로 미리 읽어 둔 `argsByPid`)·상태를 남긴다. 화면에서 '다시 열기'/'모두 웹에서 다시 열기'(`session/reopen`)로 같은 옵션의 `--resume`으로 웹에 띄운다. 30분 안에 2개 이상 닫히면 위에 경고를 띄운다. 다시 열린 대화는 닫히기 전 상태를 따른다(재시작만으로 '내 차례'가 되지 않게)
- 복구: 서버가 켜질 때 `db.web`에 있는데 tmux에 없는 세션을 `claude <args> --resume <sid>`로 다시 띄운다. 단, 그 대화가 이미 다른 곳(Orca 등)에서 열려 있으면 띄우지 않는다(실제로 같은 대화가 둘로 돈 적이 있다). 스스로 끝난 세션은 scan이 `db.web`에서 빼서 다시 띄우지 않는다
- 상태 판정(`stateOf`): 승인 요청 훅 → 승인 필요, AskUserQuestion → 내 차례, busy → 작업중(PreCompact 훅 직후면 '압축 중' `compact`), idle이면서 `statusUpdatedAt > seen` → 내 차례, 아니면 쉼. 단 마지막 훅이 PreCompact면(Claude Code가 쉬는 동안 스스로 대화를 압축함) 상태 시각만 바뀐 것이라 압축 전 상태로 되돌린다(압축 전 상태는 메모리에만 있어 서버를 그 사이에 재시작하면 내 차례로 보일 수 있다)
- 화면은 가운데(최대 1600px)에 모은다. 이 툴만 모니터 전체 화면으로 띄워 놓고 일하는 것이 목표라, 창이 2240px 이상이면 가운데는 그대로 두고 오른쪽 여백에 핀·메모·곁가지 질문 칸을 놓는다(`App.tsx`가 위(머리·카운터·보기 전환)/아래(내용) 2행 격자를 만들고 오른쪽 칸을 아래 행 셋째 열에 둔다. 그래서 세션 목록과 같은 높이에서 시작한다. 펼침 여부는 `ui.side`). 그보다 좁으면 대화 옆 셋째 칸이 된다. 이 칸은 탭이 아니라 위아래로 늘 펼쳐 둔다(`Memo.tsx`의 SidePanel). 가운데 화면을 펼쳐서 여백을 채우지 않는다(사용자가 원하지 않음)
  - 핀: Claude 핀보드 플러그인의 할 일·결정할 것. 플러그인은 보드를 Claude 프로세스 메모리에만 두므로, 대화 기록에 남는 도구 결과("Pinboard now: …")의 마지막 것을 읽는다. 다시 띄운 세션은 보드가 비므로 그 프로세스가 뜬 뒤(`startedAt` 이후)의 기록만 쓴다. 링크 칸은 기록에 없어 못 보인다. 읽기만 한다
  - 메모: 내 것. 내가 적거나 내가 시킬 때만 Claude가 적는다(핀보드와 역할이 다르다: Claude가 알 수 없는 사정을 적는 곳). `db.memos[대화ID]`에 있어 닫았다 다시 열어도 남는다. 끝나지 않은 메모가 있으면 세션 목록에 핀 표시(개수는 붙이지 않는다). F4는 메모 있는 세션을 모아 본다
  - 곁가지 질문(btw)
- `seen[sessionId]`: 확인함을 누른 시각. 처음 보는 세션이 30분 넘게 쉬던 중이면 쉼으로 시작. 복구한 세션은 꺼지기 전 상태가 내 차례가 아니었으면 쉼으로 시작
- 업무 배치는 sessionId 기준(`db.assign`). 폴더(cwd)로 묶지 않는다. 사용자가 폴더 단위 묶음을 짐으로 느껴서 일부러 뺐다
- 대화(파일)와 세션(돌고 있는 claude 프로그램)은 다르다. Orca든 웹이든 같은 `~/.claude` 기록을 쓰고, 웹에서 키보드를 꽂을 수 있는 건 웹 tmux에서 돈 프로그램뿐이다. 그래서 지난 대화는 옮기지 않고 `--resume`으로 다시 띄운다
- `focus`: 화면 밖(웹 안의 Claude 등)에서 세션을 열면 서버가 `focus`를 내보내고, 열려 있는 화면이 그 세션으로 넘어간다
- 가상 사무실(업무별 보기): 업무 = 방, 미배치 = 로비, 세션 = 책상+사람. 내 차례·승인 필요는 멀리서도 보이게 큰 말풍선을 띄운다. 책상은 끌어서 방 안 자리를 옮기거나 다른 방으로 옮긴다(그러면 업무 배치도 바뀐다). 자리는 `db.layout[sid] = {x, y}`(바닥 기준 0~1 비율)로 저장하고, 자리가 없는 책상은 빈 칸에 차례로 앉힌다. 끌기는 HTML5 드래그가 아니라 포인터 이벤트로 직접 처리한다(자리 좌표가 필요해서). 5px 안 움직이면 클릭으로 보고 작업 보기에서 연다
- 사무실 편집기(방 크기·벽·가구 꾸미기)는 아직 없다. 방은 업무 수만큼 격자로 자동 배치된다
- 대화 화면(작업 보기의 기본): 서버 `/api/transcript`가 대화 기록 jsonl을 메시지(user·assistant·tool·result)로 바꿔 주고, 화면은 1.5초마다 늘어난 만큼만 받아 그린다. 처음엔 끝 3MB만 읽는다. 하위 에이전트(isSidechain)와 시스템 문구(`<`로 시작)는 뺀다
- 대화 화면의 입력은 그 세션이 도는 곳에 그대로 넣는다: 웹 세션은 tmux, Orca 세션은 `orca terminal send`. 그래서 Orca 세션도 옮기지 않고 웹에서 바로 대화한다(Claude가 하나라 꼬이지 않는다). 여러 줄은 붙여넣기로 넣는다(tmux `paste-buffer -p`, Orca는 `ESC[200~…ESC[201~`). 중단은 Esc, 승인 창은 1·2·3 키를 보낸다
- 곁가지 질문(btw): Claude Code의 `/btw` 창은 화면에서 읽어 올 수 없어서 쓰지 않는다. 대신 `claude -p --resume <sid> --fork-session --permission-mode default`로 대화를 복사해 질문 하나에만 답하게 한다. 원래 대화 파일은 바뀌지 않고, 기본 권한 모드라 파일을 고치지 못한다. 답을 받으면 복사본 기록 파일은 지운다. 복사본 프로세스(pid)는 `btwPids`로 세션 목록에서 뺀다. 질문·답은 `db.btw[sid]`(세션당 20개)
- 하위 claude를 띄울 때는 반드시 `TERM_ENV`(새 환경)로 띄운다. Claude 세션 안의 환경 변수(CLAUDECODE 등)를 물려받으면 `claude -p`가 "No messages returned"로 실패한다
- 사내망 주소: 기본 경로(인터넷으로 나가는) 네트워크의 주소를 맨 앞에 두고 머리에 보여 준다. 와이파이·유선이 바뀌면 2초 갱신 때 바뀌고 알림이 뜬다
- 이미지: 대화 입력칸에 붙여넣거나(Ctrl+V) 끌어다 놓으면 `/api/upload`로 `~/.claude/board/uploads/`에 저장하고, 보낼 때 그 파일 경로를 붙여넣기로 넣는다. Claude Code는 붙여넣은 이미지 경로를 `[Image #N]`으로 받는다(웹·Orca 세션 모두 확인). 올린 파일은 지우지 않고 쌓인다
- 다른 터미널에서 직접 띄운 세션은 입력할 길이 없어 읽기만 된다. '웹에서도 열기'는 경고를 보여 준 뒤 같은 대화를 하나 더 띄운다(`session/resume`의 `force`)
- 웹 세션은 대화/터미널 화면을 바꿔 볼 수 있다. Orca → 웹 옮기기(`session/migrate`)는 API만 남기고 화면 버튼은 뺐다
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
- 화면 규칙: 페이지 자체는 스크롤하지 않는다(body overflow hidden, 앱이 100dvh). 머리·카운터·보기 전환은 고정이고, 내용 영역의 각 칸(`.hq-pane`, ScrollArea)이 자기 안에서 스크롤한다. 새 화면을 만들 때도 지킨다
- 같은 대화(sid)가 두 프로세스로 돌 수 있으므로 화면 목록의 key와 사무실 자리 표는 pid 기준이다
- 보기 전환 단축키 F1~F4(작업·업무별·세션 전체·메모). 입력칸·터미널에 커서가 있어도 먹게 `App.tsx`에서 capture 단계로 가로채고 브라우저 기본 동작(도움말·찾기)을 막는다
- 보기 전환은 주소 끝(`#work`·`#task`·`#all`)에 남겨 브라우저·마우스 뒤로가기로 돌아간다. 보기를 바꿀 때는 `ui.ts`의 `setMode()`/`pick()`을 쓴다
- 인증번호·로그인 토큰은 해시로만 `hq.json`에 저장한다. 메일 설정(`~/.claude/board/mail.env`)은 사용자가 직접 만든다(비밀번호가 들어가므로 Claude가 쓰지 않는다)
- 시험할 때는 `HQ_MAIL_FILE`로 메일 설정 파일을 바꾸고, `SMTP_SECURE=0`이면 TLS 없이 붙는다(가짜 SMTP로 시험하려고 둔 것)
- Orca → 웹 옮기기는 Orca 쪽 claude에 `/exit`를 보내고 프로세스가 끝나길 기다린 뒤 이어 띄운다. 일하는 중에는 막는다
- 연결된 Claude in Chrome은 다른 PC(Windows)라 이 Mac의 localhost를 열 수 없다. 화면 확인은 Mac의 headless Chrome(DevTools로 조작)으로 한다

## 확인하지 못한 것
- 실제 사람 손으로 웹 터미널·대화 화면을 오래 써 보지 않았다(스크롤·복사·한글 입력기·붙여넣기)
- 입력칸에 붙인 이미지는 터미널처럼 `[Image #N]`으로 표시하고, 보낼 때 그 자리에 이미지 경로를 붙여넣는다. 번호는 메시지마다 1부터이고 썸네일에는 숫자만 쓴다. Claude Code의 실제 번호는 붙여넣는 순간 정해지고 긴 글 붙여넣기([Pasted text #N])와 번호를 같이 써서 미리 알 수 없다(대화 기록의 `imagePasteIds`에 빈 번호가 그 흔적). 보낸 뒤 말풍선에는 실제 번호가 보인다
- 대화 화면의 쓰던 글은 브라우저 localStorage(`hq-draft:<sid>`)에 남는다. 붙인 이미지는 그 탭이 열려 있는 동안만 남는다
- 대화 화면은 지금 보이는 메시지 줄기만 그린다. 되돌리기(rewind)로 갈라진 대화나 이미지·생각(thinking)은 보이지 않는다
- 승인 대기(PermissionRequest)와 AskUserQuestion 표시는 실제 상황에서 확인하지 않았다
- 실제 맥 재부팅 뒤 복구는 tmux를 죽여서 흉내 낸 것만 확인했다

## 작업 방식
- 작업자는 한 명이다. main에서 바로 작업하고 기능 단위로 커밋·푸시한다. 계획을 따로 보고하지 않고 끝까지 진행한다
- 공개 저장소다. 업무 내용이 담긴 데이터는 저장소 밖(`~/.claude/board`)에만 둔다
