// Der Widget-Baukasten: Rahmen, Raster, gespeicherte Anordnung.
//
// Dashboard und Statistik brauchen dasselbe — verschieben am Kopf, Größe an den
// Kanten, einzeln ausblenden, Anordnung je Benutzer gespeichert. Das stand nach
// dem Dashboard-Umbau vollständig in Dashboard.jsx; die Statistik hätte es
// kopieren müssen, und ab der zweiten Kopie läuft so etwas auseinander.
//
// Eine Seite braucht von hier nur dreierlei:
//   1. einen Katalog: welche Widgets gibt es, wie heißen sie, wo liegen sie ab Werk,
//   2. `useAnordnung(katalog, 'seite')`,
//   3. `<WidgetRaster anordnung={…} inhalt={(id) => …} />`.
import React, { useState, useEffect, useMemo, useRef } from 'react';
import RasterBasis, { WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { EyeOff, Plus, RotateCcw, GripVertical } from 'lucide-react';
import api from '../../api';
import { useIsMobile } from '../../hooks/useIsMobile';

const Raster = WidthProvider(RasterBasis);
export const SPALTEN = 12;
// 30 px je Rasterzeile plus 14 px Abstand — eine Zeile ist also 44 px.
const ZEILENHOEHE = 30;
const ABSTAND = [14, 14];

// ─── Der Rahmen ──────────────────────────────────────────────────────────────
//
// Kopf mit Griff, Titel und Ausblenden-Knopf, darunter der Inhalt. Nur der linke
// Teil des Kopfes trägt `.wdrag` — sonst würde jeder Klick im Widget das
// Verschieben auslösen und Knöpfe wären nicht mehr zu treffen.
export function Widget({ titel, icon: Icon, aktion, flach, onAusblenden, children }) {
  return (
    <div className="card !p-0 h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-panel-border/60 bg-panel-surface/40 shrink-0">
        <div className="wdrag flex items-center gap-2 min-w-0 flex-1 cursor-move select-none" title="Zum Verschieben ziehen">
          <GripVertical size={14} className="text-panel-muted/40 shrink-0" />
          {Icon && <Icon size={15} className="text-panel-accent shrink-0" />}
          <h2 className="text-sm font-medium truncate">{titel}</h2>
        </div>
        {aktion}
        {onAusblenden && (
          <button type="button" onClick={onAusblenden} title="Widget ausblenden" aria-label="Widget ausblenden"
            className="p-1 rounded text-panel-muted hover:text-panel-text hover:bg-panel-card transition-colors shrink-0">
            <EyeOff size={14} />
          </button>
        )}
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto ${flach ? '' : 'p-4'}`}>{children}</div>
    </div>
  );
}

// ─── Anordnung ───────────────────────────────────────────────────────────────

// Gespeicherte Anordnung mit dem Katalog abgleichen.
//
// Zwei Fälle, die sonst weh tun: Ein Widget kommt neu dazu (dann taucht es unten
// auf und fehlt nicht einfach), und ein Widget fällt weg (dann darf seine alte
// Zeile das Raster nicht durcheinanderbringen). Ausgeblendete Widgets bleiben
// mit ihrer Position in der Liste stehen — nur so weiß das Panel, wohin sie
// gehören, wenn man sie zurückholt.
function abgleichen(liste, katalog, ids) {
  const nach = new Map();
  for (const eintrag of liste || []) {
    const id = eintrag?.i;
    if (!katalog[id] || nach.has(id)) continue;
    nach.set(id, { ...katalog[id].standard, ...eintrag });
  }
  let unten = [...nach.values()].reduce((m, it) => Math.max(m, (it.y || 0) + (it.h || 1)), 0);
  for (const id of ids) {
    if (nach.has(id)) continue;
    nach.set(id, { i: id, ...katalog[id].standard, y: unten });
    unten += katalog[id].standard.h;
  }
  return ids.map((id) => nach.get(id));
}

// Anordnung als Zeichenkette — zum Vergleich, ob sich wirklich etwas geändert
// hat. react-grid-layout meldet auch Umsortierungen, die es selbst ausgelöst
// hat; ohne diesen Vergleich schriebe jede davon die gespeicherte Anordnung um.
const signatur = (liste) => (liste || [])
  .map((it) => `${it.i}:${it.x},${it.y},${it.w},${it.h}${it.versteckt ? ':aus' : ''}`)
  .sort().join('|');

export function useAnordnung(katalog, seite) {
  const ids = useMemo(() => Object.keys(katalog), [katalog]);
  const standard = useMemo(() => ids.map((i) => ({ i, ...katalog[i].standard })), [ids, katalog]);

  const [gespeichert, setGespeichert] = useState(null);
  const bereit = useRef(false);        // gespeicherte Anordnung geladen?
  const speicherUhr = useRef(null);

  const alle = useMemo(
    () => abgleichen(gespeichert ?? standard, katalog, ids),
    [gespeichert, standard, katalog, ids],
  );
  const sichtbar = useMemo(() => alle.filter((it) => !it.versteckt), [alle]);
  const ausgeblendet = useMemo(() => alle.filter((it) => it.versteckt), [alle]);

  useEffect(() => {
    api.get(`/anordnung?seite=${encodeURIComponent(seite)}`)
      .then((r) => {
        const l = r.data?.layout;
        if (Array.isArray(l) && l.length) setGespeichert(l);
      })
      .catch(() => { /* dann eben die Standard-Anordnung */ })
      // Auch im Fehlerfall als "geladen" merken — sonst bliebe das Raster
      // dauerhaft gesperrt und jedes Verschieben ginge beim Neuladen verloren.
      .finally(() => { bereit.current = true; });
    return () => clearTimeout(speicherUhr.current);
  }, [seite]);

  // Nicht bei jedem Pixel schreiben: Beim Ziehen meldet react-grid-layout
  // laufend, und jede Meldung wäre ein eigener Aufruf.
  const sichern = (liste) => {
    clearTimeout(speicherUhr.current);
    speicherUhr.current = setTimeout(() => {
      api.put('/anordnung', { seite, layout: liste }).catch(() => { /* still */ });
    }, 700);
  };

  const uebernehmen = (liste) => { setGespeichert(liste); sichern(liste); };

  const beimVerschieben = (neu) => {
    if (!bereit.current) return;
    const nachId = new Map((neu || []).map((it) => [it.i, it]));
    const zusammen = alle.map((it) => {
      const n = nachId.get(it.i);
      return n ? { ...it, x: n.x, y: n.y, w: n.w, h: n.h } : it;
    });
    if (signatur(zusammen) === signatur(alle)) return;
    uebernehmen(zusammen);
  };

  const ausblenden = (id) =>
    uebernehmen(alle.map((it) => (it.i === id ? { ...it, versteckt: true } : it)));

  const einblenden = (id) =>
    uebernehmen(alle.map((it) => {
      if (it.i !== id) return it;
      const { versteckt, ...rest } = it;
      return rest;
    }));

  const zuruecksetzen = () => {
    setGespeichert(null);
    clearTimeout(speicherUhr.current);
    api.put('/anordnung', { seite, layout: [] }).catch(() => { /* still */ });
  };

  return {
    katalog, sichtbar, ausgeblendet, angepasst: gespeichert !== null,
    beimVerschieben, ausblenden, einblenden, zuruecksetzen,
  };
}

// ─── Werkzeugleiste ──────────────────────────────────────────────────────────
//
// Zeigt, was ausgeblendet ist (und holt es zurück) und setzt die Anordnung auf
// den Auslieferungszustand. Der Hinweis links entfällt am Handy, wo es nichts
// zu ziehen gibt.
export function WidgetLeiste({ anordnung, kinder }) {
  const istHandy = useIsMobile();
  const { katalog, ausgeblendet, angepasst, einblenden, zuruecksetzen } = anordnung;
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-panel-muted">
      {!istHandy && <span>Widgets am Kopf verschieben, an den Kanten größer ziehen.</span>}
      <div className="ml-auto flex items-center gap-2 flex-wrap">
        {kinder}
        {ausgeblendet.map((it) => (
          <button key={it.i} type="button" onClick={() => einblenden(it.i)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-panel-accent/40 bg-panel-accent/10 text-panel-accent hover:bg-panel-accent hover:text-white transition-colors">
            <Plus size={12} />{katalog[it.i].titel}
          </button>
        ))}
        {angepasst && (
          <button type="button" onClick={zuruecksetzen} title="Auf Standard-Anordnung zurücksetzen"
            className="flex items-center gap-1 hover:text-panel-text transition-colors">
            <RotateCcw size={12} />Anordnung zurücksetzen
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Das Raster ──────────────────────────────────────────────────────────────
//
// Am Handy einspaltig gestapelt, ohne Ziehen und ohne Größenänderung: Dafür ist
// auf 375 px kein Platz, und ein Raster, das man nicht bedienen kann, wäre nur
// im Weg. Die Reihenfolge ist die der Anordnung (oben nach unten, links vor
// rechts).
export function WidgetRaster({ anordnung, inhalt }) {
  const istHandy = useIsMobile();
  const { sichtbar, beimVerschieben } = anordnung;

  if (istHandy) {
    const folge = [...sichtbar].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return (
      <div className="space-y-4">
        {folge.map((it) => <div key={it.i}>{inhalt(it.i)}</div>)}
      </div>
    );
  }

  return (
    <Raster
      className="layout"
      layout={sichtbar}
      cols={SPALTEN}
      rowHeight={ZEILENHOEHE}
      margin={ABSTAND}
      containerPadding={[0, 0]}
      isDraggable
      isResizable
      draggableHandle=".wdrag"
      resizeHandles={['se', 'e', 's', 'sw']}
      compactType="vertical"
      onLayoutChange={beimVerschieben}
      useCSSTransforms
    >
      {sichtbar.map((it) => (
        <div key={it.i}>{inhalt(it.i)}</div>
      ))}
    </Raster>
  );
}
