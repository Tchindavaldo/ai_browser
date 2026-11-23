#!/usr/bin/env bash
# PreToolUse (Bash) : refuse un `git commit` qui embarque un fichier de secrets
# (.env*, llm-settings.json, cles .p8 / .json de compte de service).
# Les fichiers d'exemple (.env.example) restent autorises.

set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib-payload.sh"

payload=$(cat)
tool=$(payload_get "$payload" '.tool_name') || payload_die
[ "$tool" = "Bash" ] || exit 0
cmd=$(payload_get "$payload" '.tool_input.command') || payload_die

printf '%s' "$cmd" | grep -qE 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit' || exit 0

dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
files=$(git -C "$dir" diff --cached --name-only 2>/dev/null)
if printf '%s' "$cmd" | grep -qE '[[:space:]](-a|--all|-[a-zA-Z]*a[a-zA-Z]*)([[:space:]]|$)'; then
  files="$files
$(git -C "$dir" diff --name-only 2>/dev/null)"
fi

bad=$(printf '%s\n' "$files" | grep -E '(^|/)(\.env(\..+)?|llm-settings\.json|.*\.p8|.*firebase-adminsdk.*\.json)$' | grep -vE '\.example$' | sort -u)
if [ -n "$bad" ]; then
  echo "REFUSE : ce commit embarque des secrets :" >&2
  printf '%s\n' "$bad" >&2
  echo "Retirer ces fichiers du commit (git restore --staged <fichier>). Ne jamais commiter de cle." >&2
  exit 2
fi
exit 0
