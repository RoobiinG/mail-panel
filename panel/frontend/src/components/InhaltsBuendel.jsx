// Ein Bündel der Sortier-Inbox nach Inhalt: alle wartenden Mails mit
// demselben Betreff-Muster, egal von welchem Absender.
//
// Anders als die Domain-Gruppe legt ein Bündel standardmäßig KEINE Regel an.
// Es geht quer über viele Absender — eine Absender- oder Domain-Regel wäre
// hier fast immer falsch, und genau davon sollte die Sortierung weg. Wer
// möchte, dass künftige Mails dieser Sorte von selbst einsortiert werden,
// wählt ausdrücklich „Stichwort im Inhalt".
//
// Verschoben werden genau die Mails dieses Bündels (per ID), nichts sonst.
import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers, Search, Wand2 } from 'lucide-react';
import OrdnerFeld from './ui/OrdnerFeld';
import { KATEGORIEN, stichwortVorschlag } from './ui/sortierHilfen';

export default function InhaltsBuendel({
  buendel, ordnerOptionen, laeuft, gesperrt, onVerschieben, onIgnorieren, onAnsehen,
}) {
  // undefined = noch nicht angefasst, dann gilt der KI-Vorschlag. Mit ?? statt
  // ||, sonst zeigte ein bewusst geleertes Feld sofort wieder den Vorschlag.
  const [ordner, setOrdner] = useState(undefined);
  const [regelWahl, setRegelWahl] = useState('keine');
  const [stichwort, setStichwort] = useState('');
  const [offen, setOffen] = useState(false);

  const anzahl = buendel.mails.length;
  const feldWert = ordner ?? buendel.kiVorschlag ?? '';
  const kategorie = KATEGORIEN.find((k) => k.wert === buendel.kategorie);

  const regelAendern = (wahl) => {
    setRegelWahl(wahl);
    if (wahl === 'inhalt' && !stichwort.trim()) {
      setStichwort(stichwortVorschlag(buendel.mails.map((m) => m.betreff)));
    }
  };

  const verschieben = () => onVerschieben({
    zielordner: feldWert.trim(),
    regel: regelWahl === 'inhalt' ? { typ: 'inhalt', muster: stichwort.trim() } : null,
  });

  return (
    <div>
      {/* Kopfzeile: Muster, Anzahl, woher */}
      <div className="p-3 bg-panel-bg/40 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOffen((o) => !o)}
          className="btn-ghost !px-1 shrink-0"
          title={offen ? 'Einklappen' : 'Mails anzeigen'}
        >
          {offen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <Layers size={14} className="text-panel-accent shrink-0" />
        <span
          className="font-mono text-sm truncate max-w-[260px]"
          title={`Betreff-Muster: ${buendel.muster} — Zahlen stehen als #`}
        >
          {buendel.muster}
        </span>
        <span className="bg-panel-border/60 text-xs px-1.5 py-0.5 rounded whitespace-nowrap">
          {anzahl} Mails
        </span>
        {kategorie && kategorie.wert !== 'unbekannt' && (
          <span className="text-[11px] text-panel-muted whitespace-nowrap">{kategorie.text}</span>
        )}
        <span
          className="text-[11px] text-panel-muted truncate max-w-[260px]"
          title={buendel.domains.top.map((d) => `${d.wert} (${d.anzahl})`).join(', ')}
        >
          {buendel.domains.anzahl === 1
            ? `von ${buendel.domains.top[0].wert}`
            : `von ${buendel.domains.anzahl} Domains: ${buendel.domains.top.map((d) => d.wert).join(', ')}`
              + (buendel.domains.anzahl > 3 ? ' …' : '')}
        </span>
        {buendel.kiVorschlag && ordner === undefined && (
          <span
            className="text-[11px] text-panel-accent flex items-center gap-1 whitespace-nowrap"
            title="Das Ziel unten ist damit schon vorbelegt — einfach tippen, um es zu ändern."
          >
            <Wand2 size={11} className="shrink-0" /> KI schlägt „{buendel.kiVorschlag}" vor
          </span>
        )}
      </div>

      {/* Beispiele — damit man sieht, ob das Muster wirklich eine Sorte Mail ist */}
      {!offen && (
        <ul className="px-3 pb-2 bg-panel-bg/40 text-xs text-panel-muted space-y-0.5">
          {buendel.beispiele.map((b) => (
            <li key={b} className="truncate pl-7" title={b}>„{b}"</li>
          ))}
        </ul>
      )}

      {/* Ein Handgriff für das ganze Bündel */}
      <div className="px-3 pb-3 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center bg-panel-bg/40">
        <OrdnerFeld
          placeholder={`Alle ${anzahl} nach … (z.B. Reisen)`}
          value={feldWert}
          onChange={setOrdner}
          optionen={ordnerOptionen}
          className="flex-1 min-w-0 sm:min-w-[10rem] text-sm"
        />
        <select
          value={regelWahl}
          onChange={(e) => regelAendern(e.target.value)}
          className="text-sm bg-panel-bg w-full sm:!w-auto shrink-0"
          title="Soll sich das Panel für künftige Mails etwas merken?"
        >
          <option value="keine">Nur jetzt, keine Regel</option>
          <option value="inhalt">Regel: Stichwort im Inhalt</option>
        </select>
        {regelWahl === 'inhalt' && (
          <input
            value={stichwort}
            onChange={(e) => setStichwort(e.target.value)}
            placeholder="Stichwort, z. B. Buchung"
            title="Steht dieses Wort im Betreff oder im Text einer künftigen Mail, greift die Regel."
            className="text-sm bg-panel-bg w-full sm:!w-[170px] shrink-0"
          />
        )}
        <button
          onClick={verschieben}
          disabled={gesperrt}
          className="btn !py-1.5 !px-3 text-sm flex items-center justify-center gap-1 whitespace-nowrap disabled:opacity-50"
        >
          <Layers size={14} /> {laeuft ? 'Läuft …' : `${anzahl} verschieben`}
        </button>
        <button
          onClick={onIgnorieren}
          disabled={gesperrt}
          className="btn-ghost !py-1.5 !px-3 text-sm whitespace-nowrap disabled:opacity-50"
          title="Ohne Regel: Die Mails bleiben im Posteingang und verschwinden nur aus dieser Liste."
        >
          Im Posteingang lassen
        </button>
      </div>

      {/* Alle Mails des Bündels erst auf Wunsch */}
      {offen && (
        <ul className="divide-y divide-panel-border/60 bg-panel-bg/20">
          {buendel.mails.map((m) => (
            <li key={m.id} className="px-4 py-2 flex items-center gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate" title={m.betreff}>{m.betreff || '(Kein Betreff)'}</div>
                <div className="text-xs text-panel-muted truncate" title={m.von}>{m.von}</div>
              </div>
              <button
                onClick={() => onAnsehen(m.id)}
                className="btn-ghost !py-1 !px-2 text-xs flex items-center gap-1 shrink-0"
              >
                <Search size={14} /> Ansehen
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
