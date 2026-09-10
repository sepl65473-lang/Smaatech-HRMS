# Stage 1: Build & Dependencies
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root and workspace package definitions
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install dependencies for server and client
RUN npm --prefix server ci --only=production

# Stage 2: Production Runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Copy node_modules and application code
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server ./server
COPY public ./public
COPY package*.json ./

EXPOSE 4000
CMD ["npm", "run", "start"]
