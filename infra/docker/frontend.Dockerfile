# StellarTrust frontend image. Build context = repo root (needs shared/ + frontend/).
#   docker build -f infra/docker/frontend.Dockerfile -t stellartrust-frontend .
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS build
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
RUN cd shared && npm install --no-audit --no-fund && npm run build

COPY frontend/package.json ./frontend/
RUN cd frontend && npm install --no-audit --no-fund
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/frontend ./frontend
COPY --from=build /app/shared ./shared
WORKDIR /app/frontend
EXPOSE 3000
USER node
CMD ["npm", "run", "start"]
