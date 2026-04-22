# ─── Build stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npx vite build

# ─── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy built assets and server code
COPY --from=build /app/dist ./dist
COPY server ./server

EXPOSE 8080
USER node
CMD ["node", "server/index.js"]
