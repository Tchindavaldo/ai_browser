#!/usr/bin/env bash
# PostToolUse (Edit|Write) : un fichier de code modifie qui depasse 500 lignes
# renvoie un message BLOQUANT a Claude (exit 2) : il le decoupe AUTOMATIQUEMENT,
# dans la meme tache, sans demander l'accord de l'utilisateur.
# Repris du modele yaammoo (enforce-file-size.sh).
source "$(dirname "$0")/lib-payload.sh"

payload="$(cat)"
file="$(payload_get "$payload" '.tool_input.file_path')" || payload_die
[ -z "$file" ] && exit 0
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.html) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/*|*/.claude/*) exit 0 ;;
esac
[ -f "$file" ] || exit 0

lines=$(wc -l < "$file" | tr -d ' ')
if [ "$lines" -gt 500 ]; then
  echo "$file fait $lines lignes (plafond 500, voir CLAUDE.md). Decoupe-le MAINTENANT par responsabilite, sans changer le comportement et sans demander l'accord, avant de clore la tache." >&2
  exit 2
fi
exit 0
