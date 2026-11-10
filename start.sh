#!/bin/sh
# Démarrage sur Fly : Tailscale (si une clé est fournie) puis le serveur.
# Tailscale relie le serveur aux téléphones et PC qui servent de proxys (vue « Connexion »),
# même derrière une box ou un réseau mobile qui ne laisse rien entrer.
if [ -n "$TAILSCALE_AUTHKEY" ]; then
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled --state=/data/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock >/tmp/tailscaled.log 2>&1 &
  sleep 2
  if tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname=ai-browser --accept-dns=false; then
    echo "Tailscale connecté : $(tailscale ip -4 2>/dev/null)"
  else
    echo "Tailscale : connexion impossible (voir /tmp/tailscaled.log). Le serveur démarre quand même."
  fi
fi
exec node src/server.js
