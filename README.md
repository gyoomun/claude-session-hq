# Claude Session HQ

Claude Code 세션을 터미널 탭 여러 개에 띄워 두고 일하다 보면, 어느 세션이 내 답을 기다리는지 놓치기 쉽습니다. Claude Session HQ는 이 Mac에서 열려 있는 Claude Code 세션을 브라우저 한 화면에 모아 보여 줍니다. 세션은 업무 단위로 묶을 수 있습니다.

- 열린 세션 수와 세션별 상태(작업중 / 내 차례 / 승인 필요 / 쉼)를 보여 줍니다
- 나를 기다리는 세션을 오래된 순서로 모아 보여 줍니다
- 업무를 만들고 세션을 끌어다 놓아 묶습니다. 새로 연 세션은 미배치 칸에 먼저 나타납니다
- 업무마다 "박과장 답 기다림" 같은 사람 대기를 적어 둘 수 있고, 4시간이 지나면 재촉하라고 표시합니다
- Orca 터미널에서 띄운 세션은 화면에서 바로 그 탭으로 옮기거나 답을 보낼 수 있습니다

외부 라이브러리 없이 Node 기본 모듈만 씁니다. 서버는 `127.0.0.1`에서만 열립니다.

## 설치

macOS와 Node 18 이상이 필요합니다.

```bash
git clone https://github.com/gyoomun/claude-session-hq.git
cd claude-session-hq
node scripts/install.js
```

설치하면 두 가지가 바뀝니다.

1. `~/.claude/settings.json`에 훅 5개(UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop)를 추가합니다. 다른 도구의 훅은 건드리지 않고, 바꾸기 전 파일을 `settings.json.bak-claude-session-hq`로 남깁니다.
2. 로그인하면 서버가 자동으로 뜨도록 launchd에 등록합니다(`~/Library/LaunchAgents/dev.gyoomun.claude-session-hq.plist`).

그다음 http://127.0.0.1:7420 을 엽니다. 포트를 바꾸려면 `PORT=8000 node scripts/install.js`로 설치합니다.

제거는 `node scripts/install.js --uninstall`입니다. 업무와 배치 기록(`~/.claude/board`)은 남깁니다.

## 동작 방식

| 정보 | 어디서 읽나 |
| --- | --- |
| 열린 세션, 작업중인지 쉬는지 | Claude Code가 프로세스마다 쓰는 `~/.claude/sessions/<pid>.json` |
| 세션 제목, 마지막 지시, 마지막 답 | 대화 기록 `~/.claude/projects/*/<sessionId>.jsonl`, Orca 탭 제목 |
| 지금 실행 중인 명령, 승인 대기 | 훅이 남기는 `~/.claude/board/hooks/<pid>.json` |
| 업무, 배치, 사람 대기 | `~/.claude/board/hq.json` |

훅은 받은 이벤트를 파일에 덮어쓰기만 하고 아무것도 해석하지 않습니다. 해석은 서버가 2초마다 합니다. 훅이 없어도 세션 목록과 작업중·쉼 상태는 보이고, 실행 중인 명령과 승인 대기만 빠집니다.

**내 차례와 쉼**: 세션이 일을 마치면 내 차례가 됩니다. 확인함을 누르거나 그 세션에 다시 지시를 보내기 전까지 내 차례로 남습니다. 서버가 처음 보는 세션이 이미 30분 넘게 쉬고 있었다면 쉼으로 시작합니다.

## 한계

- macOS 전용입니다(`ps -E`로 Orca 터미널을 찾습니다).
- 터미널 열기와 답 보내기는 Orca 터미널에서 띄운 세션만 됩니다.
- 이벤트 목록은 서버 메모리에만 있어서, 서버를 다시 켜면 비어 있습니다.
