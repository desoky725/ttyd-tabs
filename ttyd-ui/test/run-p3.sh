#!/bin/sh
# Phase 2+3 verification on a throwaway container (port 127.0.0.1:7683; never touches the real ttyd service).
# Needs: docker, node >= 18, and playwright-core with chromium (see TESTING.md).
#   sh test/run-p3.sh
set -e
cd "$(dirname "$0")/../.."          # -> the directory holding ttyd-ui/ and the Dockerfile
HERE=$(pwd)
NAME=ttyd-p3-test
HF=$(mktemp)
cp ttyd-ui/test/test-hosts.conf "$HF"
docker build -q -t ttyd-ui-p3-test . >/dev/null
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME \
  -v "$HERE/ttyd-ui/test/test-login.sh:/login.sh:ro" \
  -v "$HERE/ttyd-ui/dist:/ui:ro" \
  -v "$HF:/etc/ttyd-hosts:ro" \
  -p 127.0.0.1:7683:7683 ttyd-ui-p3-test \
  ttyd -W -a -p 7683 -I /ui/index.html /usr/local/bin/ttyd-session >/dev/null
trap 'docker rm -f $NAME >/dev/null 2>&1; rm -f "$HF"' EXIT
sleep 2
echo "== wrapper whitelist"
docker cp ttyd-ui/test/wrapper-whitelist.sh $NAME:/tmp/wl.sh
docker exec $NAME sh /tmp/wl.sh
for t in e2e e2e-p2 e2e-p3 e2e-p3b e2e-p3c e2e-p4 e2e-p4b e2e-p5; do
  echo "== browser test $t"
  BASE=http://127.0.0.1:7683/ URL=http://127.0.0.1:7683/ SHOT_DIR=${TMPDIR:-/tmp} CONTAINER=$NAME HOSTS_FILE=$HF TRZSZ_DIR=${TRZSZ_DIR:-} node ttyd-ui/test/$t.mjs
done
