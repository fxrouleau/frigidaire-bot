#!/bin/sh
# Runs as root only to make the (host-mounted) data directory writable by the `node` user, then
# hands the process over to `node`. If the container is already started as a non-root user
# (e.g. `user:` in compose), there is nothing to fix and the command runs directly.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  chown -R node:node /app/data
  exec su-exec node "$@"
fi

exec "$@"
