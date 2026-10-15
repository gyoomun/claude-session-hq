---
name: hq-task
description: Claude Session HQ(웹 관제판, http://127.0.0.1:7420)의 업무(가상 사무실의 방)를 관리한다. 이 세션이나 다른 세션을 업무에 넣고 빼기, 업무 만들기·이름 바꾸기·지우기. "너 ○○ 업무로 가", "어울리는 이름으로 업무 만들어서 거기 들어가 있어", "로비(미배치)로 나와", "○○ 업무 지워", "△△ 세션을 ○○ 업무로 옮겨"처럼 사용자가 업무와 배치를 바꿔 달라고 할 때 사용.
---

# 업무(방)와 배치 관리

업무 하나가 가상 사무실의 방 하나다. 세션을 업무에 넣으면(배치) 웹의 작업·업무별 보기에서 그 업무 아래, 사무실에서는 그 방의 책상에 앉는다. 미배치 세션은 로비에 있다.

## 1. 내 대화 ID

```bash
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")
```

## 2. 업무와 세션 목록

```bash
curl -s http://127.0.0.1:7420/api/state | python3 -c "
import json,sys;d=json.loads(sys.stdin.read(),strict=False)
names={t['id']:t['name'] for t in d['tasks']}
print('업무:'); [print(' ', t['id'], t['name']) for t in d['tasks']]
print('세션:'); [print(' ', s['sid'], '|', s['title'], '|', names.get(s['task'],'미배치'), '(나)' if s['sid']=='$SID' else '') for s in d['sessions']]"
```

## 3. 바꾸기

```bash
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d.get('error') or d.get('result') or '완료')"; }
hq assign '{"sid":"<세션ID>","task":"<업무ID>"}'      # 세션을 업무로(나는 $SID)
hq assign '{"sid":"<세션ID>","task":""}'              # 미배치(로비)로
hq task/add '{"name":"<업무 이름>"}'                  # 새 업무: 출력이 새 업무 ID다. 이어서 assign으로 넣는다
hq task/update '{"id":"<업무ID>","name":"<새 이름>"}' # 이름 바꾸기
hq task/delete '{"id":"<업무ID>"}'                    # 지우기: 그 안의 세션은 모두 미배치로 간다
```

- 사용자가 말한 업무·세션을 목록에서 찾는다. 비슷한 이름이 여럿이라 애매하면 후보를 보여 주고 묻는다
- "어울리는 이름으로 만들어"면 그 대화에서 하는 일을 짧은 한국어 명사구로 이름 짓는다(예: "안드로이드 통화 녹음"). 같은 이름의 업무가 이미 있으면 새로 만들지 않고 그리로 간다
- 업무를 지울 때 그 안에 세션이 있었으면 미배치로 간 세션 이름을 함께 알린다

## 4. 알리기

무엇을 바꿨는지 한 줄로 알린다.
