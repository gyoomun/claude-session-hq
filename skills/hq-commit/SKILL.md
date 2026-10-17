---
name: hq-commit
description: Claude Session HQ(웹 관제판, http://127.0.0.1:7420) 안에서 git 커밋할 때 항상 사용한다. 같은 작업 폴더를 여러 Claude 세션이 같이 쓰므로, HQ 장부로 내가 고친 파일·부분만 골라 올리고 저장소 잠금을 잡고 커밋한다. "커밋해", "커밋하고 푸시해", 기능을 끝내 스스로 커밋할 때 모두 해당한다. 다른 세션이 같은 파일을 고치고 있어서 커밋·수정을 미루고 싶을 때도 이 스킬을 따른다.
---

# 여러 세션이 같이 쓰는 저장소에서 커밋하기

같은 폴더를 다른 Claude 세션도 고치고 있다. git은 어느 줄을 누가 고쳤는지 모르므로, HQ가 대화 기록에서 세션마다 Edit·Write로 고친 파일을 모아 둔 장부를 보고 **내 것만** 커밋한다.

## 지킬 것

- **기다리지 않는다.** 다른 세션이 같은 파일을 고치는 중이어도 내 수정과 커밋은 지금 한다. 커밋은 내 부분만 올리면 섞이지 않는다. Edit이 "파일이 바뀌었다"로 실패하면 다시 읽고 고친다
- `git add -A`, `git add .`, `git commit -a`를 쓰지 않는다. 파일을 하나하나 지정한다
- 남의 커밋 안 한 변경을 건드리지 않는다. `git checkout -- 파일`, `git restore`, `git stash`, `git reset --hard`는 남의 작업을 지운다
- 잠금은 커밋이 끝나면(실패해도) 반드시 푼다

## 1. 준비

```bash
SID=$(python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$CLAUDE_PID.json'))['sessionId'])" 2>/dev/null || echo "$CLAUDE_CODE_SESSION_ID")
CWD=$(git rev-parse --show-toplevel)
hq(){ curl -s -H 'content-type: application/json' -H 'x-hq: 1' "http://127.0.0.1:7420/api/$1" -d "$2" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(json.dumps(d.get('error') or d.get('result'),ensure_ascii=False))"; }
```

## 2. 잠금 잡기

```bash
python3 - "$CWD" "$SID" <<'EOF'
import json,sys,time,urllib.request
for i in range(60):
    r=urllib.request.Request('http://127.0.0.1:7420/api/commit/lock',json.dumps({'cwd':sys.argv[1],'sid':sys.argv[2]}).encode(),{'content-type':'application/json','x-hq':'1'})
    d=json.loads(urllib.request.urlopen(r).read(),strict=False)
    if d.get('error'): sys.exit(d['error'])
    if d['result']['ok']: print('잠금 잡음'); break
    if i==0: print('기다림:',d['result']['holder'],'세션이 커밋 중')
    time.sleep(2)
else: sys.exit('2분 기다려도 안 풀림')
EOF
```

다른 세션이 커밋하는 몇 초 동안만 기다린다. 잡은 세션이 죽어도 2분 지나면 풀린다.

## 3. 장부 보기

```bash
curl -s "http://127.0.0.1:7420/api/edits?cwd=$CWD" | python3 -c "
import json,sys;d=json.loads(sys.stdin.read(),strict=False)
for f in d['files']: print(f['status'], f['path'], '←', ', '.join(s['name']+('(나)' if s['sid']=='$SID' else '') for s in f['sessions']) or '(모름)')"
git diff --cached --name-only   # 이미 올라가 있는 것
```

- **이미 올라가 있는 것(staged)이 있으면** 내가 올린 게 아니면 손대지 않고 멈춰서 사용자에게 알린다(사용자나 다른 도구가 올린 것이다)
- **나만 고친 파일** → 4-1
- **나와 다른 세션이 같이 고친 파일**(`(나)` 말고 이름이 더 있음) → 4-2
- **`(모름)`**: Bash(sed·빌드 결과물·`git mv`)로 바뀌었거나 닫힌 세션이 고친 것이다. 내가 이번 작업에서 만든 게 확실할 때만 넣는다
- 장부에 없는데 내가 고친 기억이 있으면, 다른 세션이 이미 커밋에 넣은 것이다. `git log -3 --stat`으로 확인해 사용자에게 알린다

## 4. 올리기

**4-1. 파일 통째로**

장부는 Bash(python·sed)로 고친 것을 모른다. 그래서 장부에 나만 보여도 올리기 전에 `git diff -- <파일>`을 보고, 내가 만들지 않은 덩어리가 있으면 4-2로 내 덩어리만 올린다.

```bash
git add -- <파일> <파일>
```

**4-2. 같이 고친 파일은 내 부분만**

`git add -p`는 쓸 수 없다(대화형). 대신 패치를 만들어 내 덩어리만 남겨 올린다.

```bash
git diff -- <파일> > "$TMPDIR/mine.patch"
# mine.patch에서 내가 Edit으로 고치지 않은 덩어리(@@ 단위)를 지운다.
# 한 덩어리에 남의 줄이 섞였으면: 남의 '+' 줄은 지우고, 남의 '-' 줄은 앞의 '-'를 ' '(공백)으로 바꾼다. @@ 머리의 줄 수는 맞춰 고친다
git apply --cached --recount "$TMPDIR/mine.patch"
git diff --cached -- <파일>   # 내 것만 올라갔는지 확인
```

내 덩어리는 이 대화에서 내가 한 Edit의 `new_string`으로 알아본다. 같은 줄을 둘이 고쳐 나눌 수 없으면, `SendMessage`로 그 세션에 알리고 그 파일은 이번 커밋에서 빼고 사용자에게 알린다.

## 5. 커밋·잠금 풀기

```bash
git commit -m "type(scope): subject"
hq commit/unlock "{\"cwd\":\"$CWD\",\"sid\":\"$SID\"}"
git show --stat HEAD   # 내 파일만 들어갔는지
```

커밋이 실패해도 `commit/unlock`은 부른다. 푸시는 그 저장소에서 원래 하던 대로 한다. 커밋 메시지 형식은 전역 CLAUDE.md의 Git 가이드를 따른다.

보고할 때 남의 변경 때문에 뺀 파일이 있으면 한 줄로 알린다.
