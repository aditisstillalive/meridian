#!/usr/bin/env bash
# Replace Helius API key in .env and user-config.json
# Usage: ./scripts/replace-helius-key.sh <NEW_API_KEY>

set -euo pipefail

NEW_KEY="${1:-}"
if [[ -z "$NEW_KEY" ]]; then
  echo "Usage: $0 <NEW_API_KEY>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_SCRIPT="$ROOT_DIR/scripts/replace-helius-key.js"

if [[ ! -f "$NODE_SCRIPT" ]]; then
  echo "Error: Node script not found at $NODE_SCRIPT" >&2
  exit 1
fi

node "$NODE_SCRIPT" "$NEW_KEY"