# Mail-Panel — Multi-Stage-Build (Muster: Überwachungs-Panel)

# ─── Stufe 1: Frontend bauen ─────────────────────────────────────────────────
FROM node:24-alpine AS frontend
WORKDIR /build
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ─── Stufe 2: Backend + fertiges Frontend ────────────────────────────────────
FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY --from=frontend /build/dist /app/frontend/dist

# SQLite-Datenbank liegt im Volume
VOLUME /app/data
EXPOSE 3002
CMD ["node", "src/index.js"]
