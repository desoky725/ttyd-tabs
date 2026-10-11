W=/usr/local/bin/ttyd-session
pass=0; fail=0
expect() { # expected_rc desc cmd...
  exp=$1; d=$2; shift 2
  out=$("$@" 2>&1 </dev/null); rc=$?
  if [ "$rc" = "$exp" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL ($d): rc=$rc expected $exp out=[$out]"; fi
  case "$out" in *INJECTED*) fail=$((fail+1)); echo "FAIL ($d): output reflected input"; esac
}
rm -f /tmp/pwned
expect 2 "no args" $W
expect 2 "unknown mode" $W shell
expect 2 "attach no id" $W attach
expect 2 "attach extra arg" $W attach t0123456789 -x
expect 2 "attach short id" $W attach t012345678
expect 2 "attach long id" $W attach t01234567890
expect 2 "attach uppercase" $W attach tABCDEF0123
expect 2 "attach semicolon" $W attach 't0123456;id'
expect 2 "attach cmd subst" $W attach 't$(touch /tmp/pwned)'
expect 2 "attach backtick" $W attach 't`touch /tmp/pwned`'
expect 2 "attach newline" $W attach 't012345678
INJECTED'
expect 2 "attach dotdot" $W attach '../../etc/pa'
expect 2 "attach option-like" $W attach -tINJECTED
expect 2 "attach no t prefix" $W attach 00123456789
expect 2 "attach glob" $W attach 't*'
expect 2 "attach empty" $W attach ''
expect 2 "kill no id" $W kill
expect 2 "kill bad id" $W kill 'x;touch /tmp/pwned'
expect 2 "kill glob" $W kill 't*'
expect 2 "kill extra" $W kill t0123456789 t0123456789
expect 2 "list extra arg" $W list extra
expect 2 "list-sessions mode" $W list-sessions
expect 2 "empty first arg" $W ''
expect 2 "ttyd-prefixed mode" $W ttyd-t0123456789
expect 2 "capture no id" $W capture
expect 2 "capture bad id" $W capture 't0123456;id'
expect 2 "capture cmd subst" $W capture 't$(touch /tmp/pwned)'
expect 2 "capture glob" $W capture 't*'
expect 2 "capture option-like" $W capture -pINJECTED
expect 2 "capture extra arg" $W capture t0123456789 t0123456789
expect 2 "capture uppercase" $W capture tABCDEF0123
expect 2 "attach unknown host" $W attach t0123456789 nosuchhost
expect 2 "attach host uppercase" $W attach t0123456789 SHELLA
expect 2 "attach host semicolon" $W attach t0123456789 'shella;touch /tmp/pwned'
expect 2 "attach host cmd subst" $W attach t0123456789 '$(touch /tmp/pwned)'
expect 2 "attach host space key" $W attach t0123456789 'Bad Key'
expect 2 "attach host listed-but-invalid key" $W attach t0123456789 bad
expect 2 "attach host too long" $W attach t0123456789 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
expect 2 "attach host empty" $W attach t0123456789 ''
expect 2 "attach host glob" $W attach t0123456789 'shell*'
expect 2 "attach host dash option" $W attach t0123456789 -c
expect 2 "attach 2 hosts" $W attach t0123456789 shella piped
expect 2 "hosts extra arg" $W hosts x
[ -e /tmp/pwned ] && { fail=$((fail+1)); echo "FAIL: /tmp/pwned created"; }
# nothing must have created a tmux session
n=$(tmux -L ttyd ls 2>/dev/null | wc -l); [ "$n" = 0 ] || { fail=$((fail+1)); echo "FAIL: rejected input created $n session(s)"; }
echo "whitelist: $pass ok, $fail failed"
