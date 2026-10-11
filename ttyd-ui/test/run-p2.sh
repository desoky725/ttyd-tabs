#!/bin/sh
# Phase 2 verification on a throwaway container (port 127.0.0.1:7683; never touches the real ttyd service).
# Needs: docker, node >= 18, and playwright-core with chromium (see TESTING.md).
#   sh test/run-p2.sh
set -e
cd "$(dirname "$0")/../.."          # -> the directory holding ttyd-ui/ and the Dockerfile
HERE=$(pwd)
NAME=ttyd-p2-test
docker build -q -t ttyd-ui-p2-test . >/dev/null
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME \
  -v "$HERE/ttyd-ui/test/test-login.sh:/login.sh:ro" \
  -v "$HERE/ttyd-ui/dist:/ui:ro" \
  -p 127.0.0.1:7683:7683 ttyd-ui-p2-test \
  ttyd -W -a -p 7683 -I /ui/index.html /usr/local/bin/ttyd-session >/dev/null
trap 'docker rm -f $NAME >/dev/null 2>&1' EXIT
sleep 2
echo "== wrapper whitelist"
docker cp ttyd-ui/test/wrapper-whitelist.sh $NAME:/tmp/wl.sh
docker exec $NAME sh /tmp/wl.sh
echo "== browser test"
BASE=http://127.0.0.1:7683/ CONTAINER=$NAME node ttyd-ui/test/e2e-p2.mjs
