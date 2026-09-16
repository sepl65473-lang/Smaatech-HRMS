# Stage 1: Dependencies
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY server/package*.json ./server/

# --omit=dev replaces the deprecated --only=production (npm 9+ warns and will
# eventually drop it). npm ci needs the lockfile, which is copied above.
RUN npm --prefix server ci --omit=dev

# Stage 2: Production runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server ./server
# public/models holds the face-api TinyFaceDetector / landmark / recognition
# weights that lib/faceEngine.js loads from disk. Without them the engine
# never initialises and every face check-in fails with ENGINE_NOT_READY.
COPY public ./public
COPY package*.json ./

# Writable upload target for the local storage driver, owned by the runtime
# user. Mounted over by a volume in docker-compose so uploads survive
# container replacement.
RUN mkdir -p /app/server/uploads /app/server/logs \
 && chown -R node:node /app/server/uploads /app/server/logs

# Drop root — the previous image ran the whole API as uid 0.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
