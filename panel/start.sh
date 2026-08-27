#!/bin/sh
# Startet das Panel als Benutzer "node" statt als root.
#
# Warum nicht einfach USER node im Dockerfile? Weil das Datenverzeichnis ein
# Volume ist. Docker legt es beim ersten Start an und gibt es root — ein
# Container, der schon als "node" startet, koennte darin nichts schreiben. Und
# bei bestehenden Installationen gehoert das Volume ohnehin root, weil das Panel
# bisher als root lief.
#
# Deshalb: kurz als root das Verzeichnis herrichten, dann die Rechte abgeben.
set -e

DATEN="${DATA_DIR:-/app/data}"
mkdir -p "$DATEN"

# Nur anfassen, was noetig ist — ein chown ueber ein grosses Volume bei jedem
# Start waere unnoetig teuer.
if [ "$(stat -c %u "$DATEN")" != "$(id -u node)" ]; then
  echo "Datenverzeichnis $DATEN wird an den Benutzer node uebergeben ..."
  chown -R node:node "$DATEN"
fi

exec su-exec node node src/index.js
