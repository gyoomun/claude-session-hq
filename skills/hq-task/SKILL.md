---
name: hq-task
description: 지금 이 Claude 세션을 Claude Session HQ(웹 관제판, http://127.0.0.1:7420)의 업무(가상 사무실의 방)에 넣거나 빼고, 필요하면 업무를 새로 만든다. "너 ○○ 업무로 가", "어울리는 이름으로 업무 만들어서 거기 들어가 있어", "로비(미배치)로 나와", "지금 업무 이름 바꿔"처럼 사용자가 이 세션의 자리(업무)를 정해 달라고 할 때 사용.
---

# 이 세션을 업무(방)에 넣기

업무 하나가 가상 사무실의 방 하나다. 세션을 업무에 넣으면(배치) 웹의 작업·업무별 보기에서 그 업무 아래, 사무실에서는 그 방의 책상에 앉는다. 미배치 세션은 로비에 있다.

## 1. 내 대화 ID

```bash
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")
```

## 2. 업무 목록과 지금 자리

```bash
curl -s http://127.0.0.1:7420/api/state | python3 -c "
import json,sys;d=json.loads(sys.stdin.read(),strict=False)
me=[s for s in d['sessions'] if s['sid']=='$SID']
print('지금:', me[0]['task'] or '미배치' if me else '목록에 없음')
for t in d['tasks']: print(t['id'], t['name'])"
```

## 3. 옮기기

```bash
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d.get('error') or d.get('result') or '완료')"; }
hq assign "{\"sid\":\"$SID\",\"task\":\"<업무ID>\"}"   # 있는 업무로
hq task/add '{"name":"<업무 이름>"}'                  # 새 업무: 출력이 새 업무 ID다. 이어서 위 assign으로 들어간다
hq assign "{\"sid\":\"$SID\",\"task\":\"\"}"           # 미배치(로비)로
hq task/update '{"id":"<업무ID>","name":"<새 이름>"}'  # 업무 이름 바꾸기
```

- 사용자가 말한 업무가 목록에 있으면 그리로 간다. 비슷한 이름이 여럿이라 애매하면 후보를 보여 주고 묻는다
- "어울리는 이름으로 만들어"면 이 대화에서 하는 일을 짧은 한국어 명사구로 이름 짓는다(예: "안드로이드 통화 녹음"). 같은 이름의 업무가 이미 있으면 새로 만들지 않고 그리로 간다
- 업무 삭제는 하지 않는다. 다른 세션도 들어 있을 수 있다. 사용자가 웹에서 직접 한다

## 4. 알리기

어느 업무(방)에 들어갔는지, 새로 만들었는지 한 줄로 알린다.
