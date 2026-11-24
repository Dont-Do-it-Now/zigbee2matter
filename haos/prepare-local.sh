#!/bin/sh
# 애드온 로컬 빌드용: 빌드에 필요한 소스만 haos/zigbee2matter/app/ 로 복사한다.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/haos/zigbee2matter/app"
rm -rf "$DEST"
mkdir -p "$DEST/data"
cd "$ROOT"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json index.js cli.js LICENSE "$DEST/"
[ -f tsconfig.types.json ] && cp tsconfig.types.json "$DEST/"
[ -f .npmrc ] && cp .npmrc "$DEST/"
cp -R lib "$DEST/lib"
cp data/configuration.example.yaml "$DEST/data/"
echo "Prepared $DEST. Copy haos/zigbee2matter to /addons/zigbee2matter on HAOS."
