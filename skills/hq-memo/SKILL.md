---
name: hq-memo
description: Claude Session HQ(웹 관제판, http://127.0.0.1:7420)의 세션 메모를 적거나 읽고 고친다. 사용자가 "이거 메모해 둬", "메모에 남겨", "메모 확인해", "그 메모 끝났어로 표시해"처럼 메모를 시킬 때만 사용한다. 스스로 판단해서 메모하지 않는다(할 일·결정할 것은 핀보드가 맡는다).
---

# 세션 메모

메모는 사용자의 것이다. Claude가 알 수 없는 사정("부장님이 3시간 뒤 복귀, 물어보고 진행")을 사용자가 적어 두는 곳이고, Claude는 사용자가 시킬 때만 적는다. 웹에서는 대화 옆 패널의 메모 탭과 F4 메모 보기에 보인다. 메모는 대화 ID에 붙어 있어 세션을 닫았다 다시 열어도 남는다.

## 1. 내 대화 ID

```bash
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")
```

## 2. 읽기

```bash
curl -s http://127.0.0.1:7420/api/state | python3 -c "
import json,sys,datetime;d=json.loads(sys.stdin.read(),strict=False)
for m in (d['memos'].get('$SID') or {}).get('items', []):
  print(m['id'], '[x]' if m['done'] else '[ ]', datetime.datetime.fromtimestamp(m['at']/1000).strftime('%m-%d %H:%M'), m['by'], m['text'])"
```

다른 세션의 메모는 `d['memos']`에서 그 세션의 대화 ID로 찾는다(세션 목록은 `d['sessions']`의 `sid`·`title`).

## 3. 적기·고치기

```bash
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d.get('error') or d.get('result') or '완료')"; }
hq memo/add "{\"sid\":\"$SID\",\"by\":\"claude\",\"text\":\"<메모>\"}"     # 적기(출력이 메모 ID)
hq memo/update "{\"sid\":\"$SID\",\"id\":\"<메모ID>\",\"done\":true}"      # 끝남 표시
hq memo/update "{\"sid\":\"$SID\",\"id\":\"<메모ID>\",\"text\":\"<새 내용>\"}"
hq memo/delete "{\"sid\":\"$SID\",\"id\":\"<메모ID>\"}"
```

- 사용자가 한 말을 그대로, 짧게 적는다. 시각이 들어간 말("3시간 뒤")은 지금 시각으로 바꿔 적는다(예: "15:30쯤 부장님 복귀 → 물어보고 진행")
- JSON 안에 큰따옴표·줄바꿈이 들어가면 깨지므로 python3 `json.dumps`로 만든 본문을 넘긴다

## 4. 알리기

무엇을 적었는지 한 줄로 알린다.
