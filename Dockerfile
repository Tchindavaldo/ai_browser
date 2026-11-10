# Image officielle Playwright : navigateurs et dépendances système déjà installés.
FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
ENV NODE_ENV=production
# Tailscale : relie le serveur aux téléphones et PC qui servent de proxys (vue « Connexion »).
COPY --from=docker.io/tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
COPY package.json package-lock.json ./
# Les navigateurs sont déjà dans l'image : on saute le postinstall.
RUN npm ci --omit=dev --ignore-scripts
COPY . .
# Sur un serveur il n'y a pas d'écran : sessions sans fenêtre uniquement.
ENV RAUVALIA_HOST=0.0.0.0 \
    RAUVALIA_PORT=8080 \
    RAUVALIA_SETTINGS=/data/llm-settings.json
EXPOSE 8080
CMD ["sh", "start.sh"]
