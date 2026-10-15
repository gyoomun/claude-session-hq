#!/bin/sh
# Claude Code 훅. 받은 이벤트를 세션(claude 프로세스)별 파일 하나에 덮어쓴다. 해석은 서버가 한다.
# 도구를 쓸 때마다 불리므로 아무것도 해석하지 않고, 실패해도 Claude를 막지 않는다. stdout에는 아무것도 쓰지 않는다.
dir="$HOME/.claude/board/hooks"
mkdir -p "$dir" 2>/dev/null
pid="${CLAUDE_PID:-$PPID}"
# 큰 입력(Write 내용 등)은 앞부분만 남긴다. 나머지는 읽어서 버려 Claude 쪽 파이프가 막히지 않게 한다.
{ head -c 16384 > "$dir/$pid.json.tmp" && mv -f "$dir/$pid.json.tmp" "$dir/$pid.json"; cat > /dev/null; } 2>/dev/null
exit 0
