#!/usr/bin/env bash
# Hook UserPromptSubmit : injecte CLAUDE.md EN ENTIER au tout premier prompt de
# chaque session. Execute par le harness : la lecture ne peut pas etre oubliee.
# Un marqueur par session_id garantit une seule injection par session.
# Repris du modele yaammoo (session-start-read.sh).

set -euo pipefail

payload=$(cat)

session_id=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
project_dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"

marker_dir="${TMPDIR:-/tmp}/claude-session-start"
marker="$marker_dir/${session_id:-unknown}"
mkdir -p "$marker_dir"

[ -f "$marker" ] && exit 0
touch "$marker"

claude_md="$project_dir/CLAUDE.md"
[ -f "$claude_md" ] || exit 0

echo "=== CLAUDE.md (hook session-start, injection automatique) ==="
echo "Fichier fourni en entier. Applique ses regles des cette premiere reponse."
echo
cat "$claude_md"
echo
echo "=== FIN CLAUDE.md ==="
