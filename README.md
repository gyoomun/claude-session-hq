# Claude Session HQ

Claude Code 세션 여러 개를 동시에 굴리면서, 터미널 탭을 오가지 않고 브라우저 한 화면에서 일하기 위한 로컬 도구입니다.

- **작업 보기**: 왼쪽 세션 목록에서 고르면 오른쪽에 그 세션의 터미널이 열리고, 브라우저 안에서 Claude와 바로 대화합니다
- **새 세션**: 폴더, 업무, 첫 지시를 골라 브라우저에서 바로 시작합니다
- **세션 유지**: 웹에서 연 세션은 전용 tmux 안에서 돕니다. 브라우저를 닫거나 서버가 재시작돼도 살아 있고, 맥을 재부팅하면 같은 명령(`claude <원래 옵션> --resume <대화 ID>`)으로 자동 복구됩니다
- **한눈에 보기**: 열린 세션 수, 세션별 상태(작업중 / 내 차례 / 승인 필요 / 쉼), 나를 기다리는 세션을 모아 보여 줍니다
- **업무 단위**: 업무를 만들고 세션을 끌어다 놓아 묶습니다. 업무마다 "박과장 답 기다림" 같은 사람 대기를 적어 둡니다
- **Orca에서 옮기기**: Orca에서 띄운 세션은 버튼 하나로 웹으로 옮깁니다. Orca 쪽 Claude를 끝내고 같은 대화를 원래 옵션 그대로 이어 띄웁니다

서버는 `127.0.0.1`에서만 열립니다.

## 설치

macOS, Node 18 이상, tmux가 필요합니다(`brew install tmux`).

```bash
git clone https://github.com/gyoomun/claude-session-hq.git
cd claude-session-hq
npm install
node scripts/install.js
```

`npm install`과 `install.js`는 같은 Node로 실행하세요. 서버를 자동 실행하는 launchd는 Homebrew Node(`/opt/homebrew/bin/node`)가 있으면 그것을 씁니다.

설치하면 두 가지가 바뀝니다.

1. `~/.claude/settings.json`에 훅 5개(UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop)를 추가합니다. 다른 도구의 훅은 건드리지 않고, 바꾸기 전 파일을 `settings.json.bak-claude-session-hq`로 남깁니다.
2. 로그인하면 서버가 자동으로 뜨도록 launchd에 등록합니다(`~/Library/LaunchAgents/dev.gyoomun.claude-session-hq.plist`).

그다음 http://127.0.0.1:7420 을 엽니다. 포트를 바꾸려면 `PORT=8000 node scripts/install.js`로 설치합니다.

제거는 `node scripts/install.js --uninstall`입니다. 업무와 배치 기록(`~/.claude/board`)은 남깁니다.

## 동작 방식

| 정보 | 어디서 읽나 |
| --- | --- |
| 열린 세션, 작업중인지 쉬는지 | Claude Code가 프로세스마다 쓰는 `~/.claude/sessions/<pid>.json` |
| 세션 제목, 마지막 지시, 마지막 답 | 대화 기록 `~/.claude/projects/*/<sessionId>.jsonl`, 탭 제목 |
| 지금 실행 중인 명령, 승인 대기 | 훅이 남기는 `~/.claude/board/hooks/<pid>.json` |
| 업무, 배치, 사람 대기, 웹 세션 목록 | `~/.claude/board/hq.json` |

- 웹 세션은 전용 소켓(`tmux -L claude-hq`)과 이 저장소의 `tmux.conf`로 돕니다. 상태줄과 tmux 단축키는 꺼져 있어 화면에 드러나지 않습니다.
- 브라우저 터미널은 xterm.js입니다. 출력은 서버가 보내는 이벤트 스트림으로 받고, 키 입력은 POST로 보냅니다.
- 새 세션의 기본 옵션은 `--dangerously-skip-permissions`입니다(`hq.json`의 `claudeArgs`로 바꿀 수 있습니다).

**내 차례와 쉼**: 세션이 일을 마치면 내 차례가 됩니다. 확인함을 누르거나 다시 지시를 보내기 전까지 내 차례로 남습니다. 서버가 처음 보는 세션이 이미 30분 넘게 쉬고 있었다면 쉼으로 시작합니다.

## 한계

- macOS 전용입니다.
- 웹 터미널에서 마우스 휠은 tmux 스크롤로 동작하고, 글자를 고르려면 Option을 누른 채 드래그합니다.
- 다른 터미널에서 직접 띄운 세션은 상태만 보이고, 웹에서 열 수는 없습니다. Orca 세션만 옮길 수 있습니다.
- 이벤트 목록은 서버 메모리에만 있어서, 서버를 다시 켜면 비어 있습니다.
