---
name: hq-memo
description: Claude Session HQ(웹 관제판, http://127.0.0.1:7420)의 세션 메모를 적거나 읽고 고친다. 사용자가 "이거 메모해 둬", "메모에 남겨", "메모 확인해", "그 메모 지워"처럼 메모를 시킬 때만 사용한다. 스스로 판단해서 메모하지 않는다(할 일·결정할 것은 핀보드가 맡는다).
---

# 세션 메모

메모는 사용자의 것이다. Claude가 알 수 없는 사정("부장님이 3시간 뒤 복귀, 물어보고 진행")을 사용자가 적어 두는 곳이고, Claude는 사용자가 시킬 때만 적는다. 메모는 세션마다 **글 하나**다(줄 목록이 아니다). 사용자는 웹의 대화 옆 메모 탭(btw와 같은 칸)과 F4 메모 보기에서 큰 칸 하나로 그냥 고친다. 메모는 대화 ID에 붙어 있어 세션을 닫았다 다시 열어도 남는다.

## 1. 내 대화 ID

```bash
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")
```

## 2. 읽기

```bash
curl -s http://127.0.0.1:7420/api/state | python3 -c "
import json,sys;d=json.loads(sys.stdin.read(),strict=False)
print((d['memos'].get('$SID') or {}).get('text', '(메모 없음)'))"
```

다른 세션의 메모는 `d['memos']`에서 그 세션의 대화 ID로 찾는다(세션 목록은 `d['sessions']`의 `sid`·`title`).

## 3. 적기·고치기

```bash
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d.get('error') or d.get('result') or '완료')"; }
hq memo/add "{\"sid\":\"$SID\",\"text\":\"<한 줄>\"}"     # 끝에 한 줄 덧붙이기
hq memo/set "{\"sid\":\"$SID\",\"text\":\"<메모 전체>\"}"   # 통째로 바꾸기(고치기·지우기). 빈 글이면 메모가 없어진다
```

- 적을 때는 `memo/add`로 덧붙인다. 사용자가 적어 둔 글을 지우거나 바꾸지 않는다. 고치라고 할 때만 2로 읽은 글을 고쳐 `memo/set`으로 통째로 넣는다
- 사용자가 한 말을 그대로, 짧게 적는다. 시각이 들어간 말("3시간 뒤")은 지금 시각으로 바꿔 적는다(예: "15:30쯤 부장님 복귀 → 물어보고 진행")
- JSON 안에 큰따옴표·줄바꿈이 들어가면 깨지므로 python3 `json.dumps`로 만든 본문을 넘긴다

## 4. 알리기

무엇을 적었는지 한 줄로 알린다.
