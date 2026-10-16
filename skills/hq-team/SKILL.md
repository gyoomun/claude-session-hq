---
name: hq-team
description: Claude Session HQ(웹 관제판, http://127.0.0.1:7420) 안에서 다른 Claude 세션과 같이 일한다. 세션을 새로 띄우기, 지금 대화를 복제(fork)해 하나 더 만들기, 세션 이름 바꾸기(나 자신 포함), 다른 세션에 말 걸기·일 시키기·물어보기, 다른 세션이 지금 뭘 하는지·뭐라고 했는지 보기. "너를 복제해서 하나 더 만들어", "세션 하나 더 띄워서 ○○ 시켜", "세션명을 ○○로 해", "○○ 세션한테 물어봐/전해", "△△ 세션 지금 뭐 해?"처럼 말할 때 사용.
---

# HQ에서 다른 Claude와 일하기

사용자는 이 맥의 Claude 세션을 모두 **HQ 웹 화면 하나**로 본다. 세션은 HQ가 tmux(소켓 `claude-hq`) 안에 띄운 것이다. 사용자는 Orca나 터미널 탭을 쓰지 않는다.

**반드시 지킬 것**
- 새 세션·복제는 **HQ API로만** 띄운다(아래 4). Agent 도구의 백그라운드 실행, `claude --bg`, `claude attach`, "새 터미널에서 `claude --resume …` 하세요" 같은 안내는 하지 않는다. 그렇게 뜬 세션은 HQ 화면에 나오지 않아 사용자가 볼 수도, 말을 걸 수도 없다
- 세션 이름은 사용자에게 `/rename`을 치라고 하지 않고 직접 바꾼다(아래 5). 나 자신도, 일하는 중에도 된다
- 사용자가 시킨 범위에서만 다른 세션에 말을 건다. 다른 세션의 파일·작업을 함부로 건드리지 않는다

```bash
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d.get('error') or d.get('result') or '완료')"; }
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")   # 내 대화 ID
```

## 1. 세션 목록

- 말을 걸 상대(이름): `ListAgents` 도구. 첫 줄이 내 이름, 아래가 다른 세션 이름이다. 도구가 안 보이면 `ToolSearch`로 `select:ListAgents,SendMessage`를 불러온다
- HQ가 아는 것(대화 ID·제목·상태·마지막 지시와 답):

```bash
curl -s http://127.0.0.1:7420/api/state | python3 -c "
import json,sys;d=json.loads(sys.stdin.read(),strict=False)
for s in d['sessions']: print(s['sid'], '|', s['name'], '|', s['title'], '|', s['state'], '(나)' if s['sid']=='$SID' else '')"
```

상태: `working` 일하는 중, `myturn` 답을 마치고 사용자를 기다림, `idle` 쉼, `approval` 실행 허락 대기. 사용자가 부르는 이름은 보통 화면에 보이는 **제목**(`title`)이고, 메시지를 보낼 때 쓰는 이름은 `name`이다.

## 2. 다른 세션이 뭘 하는지

- 마지막 지시·답 앞부분: 위 `/api/state`의 `prompt`·`msg`
- 대화 전체: `curl -s "http://127.0.0.1:7420/api/transcript?sid=<대화ID>"` → `items`(`t`: user·assistant·tool·result, `text`). 길면 끝부분만 본다

## 3. 말 걸기·일 시키기

`SendMessage({to: "<name>", message: "..."})`. 받는 세션은 다음 차례에 메시지를 받는다.
- 누가 보냈는지, 무엇을 원하는지, 답이 필요하면 "답은 SendMessage로 `<내 이름>`에게"를 적는다
- 상대가 `working`이면 지금 일을 끝낸 뒤에 읽는다. 급하지 않으면 기다린다

## 4. 새 세션 띄우기·복제

```bash
hq session/new '{"cwd":"~/01dev/<폴더>","name":"<세션 이름>","prompt":"<첫 지시(없어도 된다)>"}'   # 새 대화
hq session/new "{\"fork\":\"$SID\",\"name\":\"<복제본 이름>\"}"                                   # 나를 복제
```

- 결과는 tmux 이름(`hq-…`)이고, 약 3초 뒤 HQ 목록에 나타난다. 업무에 바로 넣으려면 `"task":"<업무ID>"`(skills/hq-task)
- **복제**는 이 대화를 그대로 물려받아 새 대화 ID로 갈라진다. 같은 폴더에서 뜬다. `prompt`를 주면 복제본이 그 지시부터 시작한다
- 갈라진 뒤에는 서로의 대화를 모른다. 같은 파일을 둘이 고치면 덮일 수 있으니 맡을 일을 나눠 알려 준다. 서로 알려야 할 것은 3의 SendMessage로 전한다
- 다른 대화를 복제하려면 `fork`에 그 대화 ID를 넣는다

## 5. 이름 바꾸기

```bash
hq session/rename "{\"sid\":\"$SID\",\"name\":\"<새 이름>\"}"     # 나. 다른 세션은 그 대화 ID
```

Claude Code의 `/rename`을 그 세션에 쳐 넣는다. 상태줄·HQ 화면·메시지 받는 이름이 함께 바뀐다. 그 세션의 입력칸에 글이 남아 있으면 거절된다.

## 6. 알리기

무엇을 했는지(띄운 세션 이름, 복제 여부, 보낸 메시지 요지) 한두 줄로 알린다. 사용자에게 명령을 치라고 하지 않는다.
