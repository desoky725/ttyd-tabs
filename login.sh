#!/bin/sh
printf "login as: "
read -r user
exec ssh "${user}@${SSH_HOST:-host.docker.internal}"
