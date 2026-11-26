# Inventory Management API (Node.js + Express). Database: Supabase PostgreSQL.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first so Docker can cache this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code (see .dockerignore for what is left out).
COPY src ./src
COPY sql ./sql
COPY scripts ./scripts

# Folder for uploaded product photos. Mount a volume here to keep them across restarts.
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

# The app reads PORT (hosts like Render set it). 5000 is the default.
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
