# --- stage 1: build the single-file web UI (pinned vendored libs are checksum-verified by build.mjs)
FROM node:20-alpine AS ui
WORKDIR /build
COPY ttyd-ui/build.mjs ./build.mjs
COPY ttyd-ui/src ./src
COPY ttyd-ui/vendor ./vendor
RUN node build.mjs

# --- stage 2: stock ttyd (binary untouched) + tmux + ssh client + our wrapper and UI
FROM tsl0922/ttyd:1.7.7

LABEL org.opencontainers.image.title="ttyd-tabs" \
      org.opencontainers.image.description="Multi-tab, persistent web terminal on top of ttyd" \
      org.opencontainers.image.licenses="MIT"

# openssh-client for /login.sh; tmux (Ubuntu 20.04 package, 3.0a) for session persistence.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client tmux \
    && rm -rf /var/lib/apt/lists/*

COPY login.sh /login.sh
COPY ttyd-session /usr/local/bin/ttyd-session
COPY ttyd-tmux.conf /etc/ttyd-tmux.conf
COPY --from=ui /build/dist/index.html /ui/index.html
COPY LICENSE NOTICE /licenses/
COPY ttyd-ui/vendor/LICENSE.xterm ttyd-ui/vendor/LICENSE.trzsz /licenses/
RUN chmod +x /login.sh /usr/local/bin/ttyd-session

# ssh target of the default login (login.sh); override for your own host
ENV SSH_HOST=host.docker.internal
EXPOSE 7681

# -a: ttyd appends ?arg= values to argv; ttyd-session whitelists them. -W: writable terminal.
CMD ["ttyd", "-W", "-p", "7681", "-a", "-I", "/ui/index.html", "/usr/local/bin/ttyd-session"]
