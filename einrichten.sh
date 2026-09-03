#!/bin/sh
# Einrichtung des Mail-Panel-Stacks.
#
# Der Stack bringt ClamAV und unbound mit. Beide sind aber auf vielen Servern
# schon vorhanden — Mailcow zum Beispiel liefert beide mit. Sie ein zweites Mal
# zu starten kostet gut anderthalb Gigabyte Arbeitsspeicher für nichts, und zwar
# ausgerechnet auf der Maschine, die die Post ausliefert.
#
# Dieses Skript sieht deshalb vorher nach, was schon läuft, und schreibt das
# Ergebnis in die .env. Danach genügt in jedem Fall ein schlichtes
#
#   docker compose up -d
#
# Es ist wiederholbar: Ein zweiter Lauf ändert nichts, wenn sich nichts geändert
# hat. Nichts wird ohne Rückfrage überschrieben.
set -e

ENV_DATEI="$(dirname "$0")/.env"
GEFUNDEN_CLAMAV=""
GEFUNDEN_UNBOUND=""
PROFILE=""

sage() { printf '%s\n' "$*"; }
frage() {
  # $1 = Frage. Rückgabe 0 = ja.
  #
  # Ohne Terminal gilt "ja" — damit läuft die Einrichtung auch unbeaufsichtigt
  # durch. Das ist für die Erkennungsfragen richtig, denn dort ist "vorhandenes
  # benutzen" die vernünftige Vorgabe.
  [ -t 0 ] || return 0
  printf '%s [J/n] ' "$1"
  read -r antwort
  case "$antwort" in n|N|nein|no) return 1 ;; *) return 0 ;; esac
}

frage_handlung() {
  # Wie frage(), aber für Dinge, die etwas TUN. Ohne Terminal lautet die
  # Antwort hier "nein": Ein Skript, das unbeaufsichtigt läuft, soll Dienste
  # nicht von sich aus starten — es soll sagen, was zu tun ist.
  [ -t 0 ] || { sage '  (kein Terminal — bitte die Befehle oben von Hand ausführen)'; return 1; }
  frage "$1"
}

# ── Vorhandene Dienste suchen ───────────────────────────────────────────────
#
# Drei Wege, in dieser Reihenfolge: ein laufender Container, ein Dienst auf dem
# Host, ein bereits eingetragener Wert in der .env.

docker_da() { command -v docker >/dev/null 2>&1; }

container_suchen() {
  # $1 = Suchmuster im Namen, $2 = Port, der antworten muss
  docker_da || return 1
  for name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -i "$1" || true); do
    # Den eigenen Stack nicht als "schon vorhanden" zählen.
    case "$name" in mail-panel|n8n|unbound|clamav) continue ;; esac
    echo "$name"
    return 0
  done
  return 1
}

port_offen() {
  # $1 = Host, $2 = Port. Ohne nc: über /dev/tcp der Shell, falls vorhanden.
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$1" "$2" >/dev/null 2>&1 && return 0
    return 1
  fi
  (exec 3<>"/dev/tcp/$1/$2") >/dev/null 2>&1 && return 0
  return 1
}

sage ''
sage '=== ClamAV ==='
if treffer=$(container_suchen 'clam' 3310); then
  sage "  Gefunden: Container \"$treffer\" läuft bereits."
  if frage "  Diesen benutzen, statt einen zweiten zu starten?"; then
    GEFUNDEN_CLAMAV="$treffer"
  fi
elif port_offen 127.0.0.1 3310; then
  sage '  Gefunden: Auf diesem Rechner antwortet bereits etwas auf Port 3310.'
  if frage '  Diesen benutzen, statt einen zweiten zu starten?'; then
    # Aus einem Container heraus ist der Host über das Docker-Gateway erreichbar.
    GEFUNDEN_CLAMAV='172.17.0.1'
  fi
else
  sage '  Keines gefunden — der Stack bringt sein eigenes mit.'
fi
[ -n "$GEFUNDEN_CLAMAV" ] || PROFILE="clamav"

sage ''
sage '=== unbound (DNS-Resolver für die Spam-Listen) ==='
if treffer=$(container_suchen 'unbound' 53); then
  sage "  Gefunden: Container \"$treffer\" läuft bereits."
  if frage '  Diesen benutzen?'; then GEFUNDEN_UNBOUND="$treffer"; fi
else
  sage '  Keinen gefunden — der Stack bringt seinen eigenen mit.'
fi
if [ -z "$GEFUNDEN_UNBOUND" ]; then
  PROFILE="${PROFILE:+$PROFILE,}unbound"
fi

# ── Netz verbinden ──────────────────────────────────────────────────────────
#
# Ein fremder Container ist nur über sein eigenes Docker-Netz erreichbar. Der
# Panel-Container muss also mit hinein. Das passiert nach dem Start, weil es den
# Container vorher noch nicht gibt.
NETZE=''
for fremd in "$GEFUNDEN_CLAMAV" "$GEFUNDEN_UNBOUND"; do
  case "$fremd" in ''|172.17.0.1) continue ;; esac
  docker_da || continue
  netz=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$fremd" 2>/dev/null | awk '{print $1}')
  [ -n "$netz" ] || continue
  case " $NETZE " in *" $netz "*) ;; *) NETZE="${NETZE:+$NETZE }$netz" ;; esac
done

# ── .env schreiben ──────────────────────────────────────────────────────────
setze() {
  # $1 = Schlüssel, $2 = Wert. Vorhandene Zeile ersetzen, sonst anhängen.
  schluessel="$1"; wert="$2"
  touch "$ENV_DATEI"
  if grep -q "^${schluessel}=" "$ENV_DATEI" 2>/dev/null; then
    alt=$(grep "^${schluessel}=" "$ENV_DATEI" | head -1 | cut -d= -f2-)
    [ "$alt" = "$wert" ] && return 0
    sed -i.bak "s|^${schluessel}=.*|${schluessel}=${wert}|" "$ENV_DATEI" && rm -f "$ENV_DATEI.bak"
    sage "  geändert: ${schluessel}=${wert}  (war: ${alt})"
  else
    printf '%s=%s\n' "$schluessel" "$wert" >> "$ENV_DATEI"
    sage "  gesetzt:  ${schluessel}=${wert}"
  fi
}

sage ''
sage '=== .env ==='
[ -f "$ENV_DATEI" ] || sage '  (wird neu angelegt)'
setze COMPOSE_PROFILES "$PROFILE"
[ -n "$GEFUNDEN_CLAMAV" ] && setze CLAMD_HOST "$GEFUNDEN_CLAMAV"
[ -n "$GEFUNDEN_UNBOUND" ] && setze UNBOUND_HOST "$GEFUNDEN_UNBOUND"

# Liegt ein fremder Dienst in einem eigenen Docker-Netz, hängt sich das Panel
# über PANEL_EXTERN_NETZ dort mit ein — die Compose erledigt das von selbst, kein
# "docker network connect" mehr nötig. Ein Netz genügt: Die Dienste eines Stacks
# (z.B. Mailcow) liegen im selben Netz.
if [ -n "$NETZE" ]; then
  erstes=${NETZE%% *}
  setze PANEL_EXTERN_NETZ "$erstes"
  case "$NETZE" in
    *" "*) sage "  Hinweis: mehrere Netze gefunden ($NETZE) — PANEL_EXTERN_NETZ fasst eines; bei Bedarf von Hand ergänzen." ;;
  esac
fi

sage ''
sage '=== So geht es weiter ==='
sage '  docker compose up -d'
[ -n "$NETZE" ] && sage '  (Dank PANEL_EXTERN_NETZ hängt sich das Panel selbst ins richtige Netz — nichts weiter nötig.)'
