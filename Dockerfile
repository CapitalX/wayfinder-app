# Wayfinder in a container. The in-app build sandbox (bubblewrap) is off here: the container protects the host, but
# generated app code runs as the same user as Wayfinder and can read /config. See SECURITY.md, Known limits.
# Claude: pass ANTHROPIC_API_KEY. Data and secrets live in volumes.
# The full Node image already has git (Build mode versions each app) and CA certificates, so no package installs.
FROM node:25-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
ENV WAYFINDER_HOST=0.0.0.0 WAYFINDER_PORT=8797 WAYFINDER_DATA_DIR=/data WAYFINDER_CONFIG_DIR=/config WAYFINDER_SANDBOX=off NODE_ENV=production
# The app runs as the unprivileged node user; give it its data and config folders.
RUN mkdir -p /data /config && chown node:node /data /config
VOLUME ["/data", "/config"]
EXPOSE 8797
USER node
CMD ["npx", "tsx", "src/server/main.ts"]
