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
# openssl bleibt dauerhaft: Damit erzeugt das Panel beim ersten Start sein
# eigenes TLS-Zertifikat, wenn keines hinterlegt ist (siehe services/tls.js).
# poppler-utils und tesseract-ocr bleiben ebenfalls: Damit liest das Panel
# EINGESCANNTE Belege (services/ocr.js). Ein digitales PDF braucht sie nicht —
# dort holt services/pdfText.js die Textebene in reinem JavaScript heraus. Ein
# Scan hat aber keine, und ohne Texterkennung war das die letzte Faehigkeit,
# fuer die es noch Gemini brauchte.
#
# Rund 100 MB im Abbild. Wer sie nicht will, laesst die drei Pakete weg: Das
# Panel merkt beim ersten Versuch, dass sie fehlen, sagt es einmal im Log und
# entscheidet Scans wie bisher per Heuristik.
RUN apk add --no-cache su-exec openssl poppler-utils tesseract-ocr tesseract-ocr-data-deu \
 && apk add --no-cache --virtual .bauwerkzeug python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund \
 && apk del .bauwerkzeug
COPY panel/backend/ ./
COPY workflows/ /app/workflows/
# Die Versionsdatei gehoert auch ins Backend-Abbild: Der Diagnose-Bericht soll
# sagen koennen, welcher Stand hier eigentlich laeuft. Ohne sie stand dort
# "unbekannt" -- ausgerechnet in dem Bericht, der beim Fehlersuchen hilft.
COPY version.json /app/version.json
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
