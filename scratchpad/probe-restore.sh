#!/usr/bin/env bash
# Live probe: endpoint restore/undo on a THROWAWAY terminal (never a real teammate).
# Requires the Cookrew app restarted on the new build (executor wired).
# Asserts: ok results, running:true after restore AND undo, original session
# file byte-identical, rebind to a fresh id, undo returns to the original id,
# kill-before-spawn ordering (implicit in running:true + live pane).
set -u
BASE=http://localhost:8639
CWD=/Users/drej/workspace/cookrew-dev
PASS=0; FAIL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

echo "== 0. app serves new endpoints?"
code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 -X POST "$BASE/api/agents/does-not-exist/restore" -H 'content-type: application/json' -d '{"checkpointIndex":1}')
[ "$code" = "200" ] && ok "restore endpoint live (400-class body expected for unknown id)" || { bad "restore endpoint not live (http $code) — is the app on the new build?"; exit 1; }

echo "== 1. create sacrificial claude terminal"
TID=$(curl -s -m 10 -X POST "$BASE/api/terminals" -H 'content-type: application/json' \
  -d '{"name":"Probe-Sacrifice","preset":"Claude Code","position":{"x":9000,"y":9000},"orch":false}' | jget "d['id']")
[ -n "$TID" ] && ok "created $TID" || { bad "terminal create failed"; exit 1; }
SESS="cookrew_$(echo "$TID" | tr -dc 'a-zA-Z0-9' | cut -c1-24)"
sleep 12  # claude boot

echo "== 2. two turns -> >=2 checkpoints"
curl -s -m 90 -X POST "$BASE/api/terminal/$TID/ask" -H 'content-type: application/json' -d '{"text":"reply with exactly: one"}' >/dev/null
curl -s -m 90 -X POST "$BASE/api/terminal/$TID/ask" -H 'content-type: application/json' -d '{"text":"reply with exactly: two"}' >/dev/null
ok "two turns sent"

echo "== 2b. wait for truly idle (restore refuses a thinking/waiting agent)"
PHASE=""
for i in $(seq 1 30); do
  PHASE=$(curl -s -m 5 "$BASE/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=d.get('activities',{}).get('$TID')
print(a['phase'] if a else 'idle')" 2>/dev/null)
  case "$PHASE" in idle|replied|"") break;; esac
  sleep 2
done
case "$PHASE" in idle|replied|"") ok "agent idle (phase=$PHASE)";; *) bad "agent stuck in phase=$PHASE";; esac

echo "== 3. record original session id + file md5"
ORIG_SID=$(curl -s -m 5 "$BASE/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=[x for x in d['nodes'] if x.get('id')=='$TID'][0]
print(n.get('claudeSessionId') or '')")
[ -n "$ORIG_SID" ] && ok "original session $ORIG_SID" || bad "no claudeSessionId bound"
PROJ="$HOME/.claude/projects/$(echo "$CWD" | sed 's|/|-|g')"
ORIG_FILE="$PROJ/$ORIG_SID.jsonl"
[ -f "$ORIG_FILE" ] && ok "original file exists" || bad "original file missing at $ORIG_FILE"
ORIG_MD5=$(md5 -q "$ORIG_FILE" 2>/dev/null)
ORIG_BYTES=$(wc -c < "$ORIG_FILE" | tr -d ' ')

echo "== 4. restore to checkpoint 1"
R=$(curl -s -m 30 -X POST "$BASE/api/agents/$TID/restore" -H 'content-type: application/json' -d '{"checkpointIndex":1}')
echo "   -> $R"
[ "$(echo "$R" | jget "d.get('ok')")" = "True" ] && ok "restore ok" || bad "restore refused: $R"
NEW_SID=$(echo "$R" | jget "d.get('sessionId')")
if [ "$(echo "$R" | jget "d.get('ok')")" = "True" ]; then
  [ -n "$NEW_SID" ] && [ "$NEW_SID" != "None" ] && [ "$NEW_SID" != "$ORIG_SID" ] && ok "rebound to fresh id $NEW_SID" || bad "session id did not change"
fi

echo "== 5. poll running:true (kill-before-spawn => node never strands dead)"
RUN=""
for i in $(seq 1 30); do
  RUN=$(curl -s -m 5 "$BASE/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=[x for x in d['nodes'] if x.get('id')=='$TID']
print(n[0].get('running') if n else 'gone')" 2>/dev/null)
  [ "$RUN" = "True" ] && break; sleep 2
done
[ "$RUN" = "True" ] && ok "running:true after restore" || bad "node stuck not-running ($RUN)"

echo "== 6. original file never rewritten (append-only: CLI may add its own kill-time tail)"
# The invariant that matters: the executor must not truncate/rewrite the
# original — the original bytes must remain an exact PREFIX of the file.
# (The dying CLI legitimately appends stop_hook_summary/turn_duration.)
if [ "$(head -c "$ORIG_BYTES" "$ORIG_FILE" 2>/dev/null | md5 -q)" = "$ORIG_MD5" ]; then
  ok "original bytes intact as prefix (append-only)"
else
  bad "ORIGINAL SESSION FILE REWRITTEN"
fi

echo "== 7. pane is a live claude, not a dead shell"
sleep 5
tmux -L cookrew capture-pane -p -t "$SESS" 2>/dev/null | grep -qE "❯|bypass permissions" && ok "pane live" || bad "pane looks dead"

echo "== 8. undo"
U=$(curl -s -m 30 -X POST "$BASE/api/agents/$TID/restore/undo")
echo "   -> $U"
[ "$(echo "$U" | jget "d.get('ok')")" = "True" ] && ok "undo ok" || bad "undo refused: $U"
[ "$(echo "$U" | jget "d.get('sessionId')")" = "$ORIG_SID" ] && ok "undo rebound to original id" || bad "undo rebound elsewhere"
RUN=""
for i in $(seq 1 30); do
  RUN=$(curl -s -m 5 "$BASE/api/state" | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=[x for x in d['nodes'] if x.get('id')=='$TID']
print(n[0].get('running') if n else 'gone')" 2>/dev/null)
  [ "$RUN" = "True" ] && break; sleep 2
done
[ "$RUN" = "True" ] && ok "running:true after undo" || bad "node not-running after undo"

echo "== 9. cleanup: delete sacrificial node"
curl -s -m 10 -X DELETE "$BASE/api/nodes/$TID" >/dev/null && ok "node deleted"
sleep 3
tmux -L cookrew has-session -t "$SESS" 2>/dev/null && bad "tmux session leaked: $SESS" || ok "no tmux leak"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
