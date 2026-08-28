# Mail-Panel — Multi-Stage-Build (Muster: Überwachungs-Panel)

# ─── Stufe 1: Frontend bauen ─────────────────────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /build
COPY panel/frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY panel/frontend/ ./
COPY version.json ./
RUN npm run build

# ─── Stufe 2: Backend + fertiges Frontend ────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app/backend
COPY panel/backend/package.json ./
# better-sqlite3 wird beim Installieren uebersetzt und braucht dafuer eine
# Werkzeugkette. Die bleibt NICHT im fertigen Abbild liegen — sonst traegt jeder
# Container dauerhaft einen Compiler mit sich herum, ohne ihn je zu brauchen.
# su-exec bleibt dauerhaft: Damit gibt das Startskript die Rechte ab.
RUN apk add --no-cache su-exec \
 && apk add --no-cache --virtual .bauwerkzeug python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund \
 && apk del .bauwerkzeug
COPY panel/backend/ ./
COPY workflows/ /app/workflows/
# Das Wiederherstellungs-Skript gehoert ins Image: Wer nur den Container hat und
# eine Sicherung zurueckholen will, kommt sonst nicht heran. Es braucht selbst
# nichts ausser Node — kein Panel, keine Datenbank, keine Pakete.
COPY panel/wiederherstellen.js /app/wiederherstellen.js
COPY --from=frontend /build/dist /app/frontend/dist

# SQLite-Datenbank liegt im Volume
VOLUME /app/data
EXPOSE 3002

# Nicht als root laufen. Der Benutzer "node" ist in den offiziellen Abbildern
# bereits angelegt. Das Datenverzeichnis muss ihm gehoeren, sonst kann das Panel
# seine Datenbank nicht schreiben — deshalb legt der Start es an und uebergibt
# es, bevor er die Rechte abgibt.
COPY panel/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh && chown -R node:node /app
CMD ["/usr/local/bin/start.sh"]
