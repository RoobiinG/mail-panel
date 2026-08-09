# Mail-Panel — Multi-Stage-Build (Muster: Überwachungs-Panel)

# ─── Stufe 1: Frontend bauen ─────────────────────────────────────────────────
FROM node:24-alpine AS frontend
WORKDIR /build
COPY panel/frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY panel/frontend/ ./
COPY version.json ./
RUN npm run build

# ─── Stufe 2: Backend + fertiges Frontend ────────────────────────────────────
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app/backend
COPY panel/backend/package.json ./
RUN apk add --no-cache python3 make g++ && npm install --omit=dev --no-audit --no-fund
COPY panel/backend/ ./
COPY --from=frontend /build/dist /app/frontend/dist

# SQLite-Datenbank liegt im Volume
VOLUME /app/data
EXPOSE 3002
CMD ["node", "src/index.js"]
