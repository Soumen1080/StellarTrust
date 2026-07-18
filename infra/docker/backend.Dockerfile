# StellarTrust backend image. Build context = repo root (needs shared/ + backend/).
#   docker build -f infra/docker/backend.Dockerfile -t stellartrust-backend .
FROM node:20-alpine AS base
WORKDIR /app

# --- Build shared (contracts of record) then backend ---
FROM base AS build
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared && npm install --no-audit --no-fund && npm run build

COPY backend/package.json ./backend/
RUN cd backend && npm install --no-audit --no-fund
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
RUN cd backend && npm run build

# --- Runtime ---
FROM base AS runtime
ENV NODE_ENV=production
# Copy built shared + backend and production deps.
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
WORKDIR /app/backend
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
