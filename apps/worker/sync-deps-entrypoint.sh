#!/bin/sh
# Keep the node_modules named volumes in sync with the lockfile, then run the command.
set -e
cd /app
CI=true pnpm install --frozen-lockfile --reporter=silent
exec "$@"
