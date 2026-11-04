#!/bin/sh
# Copies the built community package into the n8n data volume on every start.
# A volume mounted at /home/node/.n8n hides files baked into the image, so the
# package has to be installed after that mount exists. n8n scans
# ~/.n8n/nodes/node_modules/n8n-nodes-* and uses the package.json name, which
# keeps the node type n8n-nodes-decision-matrix.decisionMatrix.
set -eu

SRC=/opt/decision-matrix
DEST=/home/node/.n8n/nodes/node_modules/n8n-nodes-decision-matrix
NODE_JS="$SRC/dist/nodes/DecisionMatrix/DecisionMatrix.node.js"

if [ ! -f "$NODE_JS" ]; then
  echo "Decision Matrix dist is missing. From the repo, run npm run build, then start this stack again." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/package.json" "$DEST/package.json"
cp -R "$SRC/dist" "$DEST/dist"
echo "Installed n8n-nodes-decision-matrix into ${DEST}"

exec /docker-entrypoint.sh "$@"
