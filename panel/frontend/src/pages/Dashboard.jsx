import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import {
  AlertTriangle, Inbox, Gauge, ShieldCheck, HardDriveDownload, Target,
  CheckCircle2, XCircle, Workflow, ArrowRight, Archive, Check, RefreshCw
} from 'lucide-react';
import api from '../api';

const COLORS = {
  Clean: '#10B981', // emerald-500
  Spam: '#F59E0B',  // amber-500
  Phishing: '#EF4444', // red-500
  Viren: '#8B5CF6',  // violet-500
  Newsletter: '#3B82F6' // blue-500
};

// Etwas Luft unter dem, was Google zuletzt zugelassen hat: Genau auf die Kante
// zu gehen heißt, beim nächsten Lauf wieder mittendrin abzubrechen.
function empfohlenesBudget(beobachtet) {
  const wert = Math.floor((Number(beobachtet) || 0) * 0.95 / 10) * 10;
  return Math.max(50, wert);
}

// "vor 3 Std." statt einer nackten Uhrzeit — beim Blick aufs Dashboard will man
// wissen, wie lange es her ist, nicht wann genau.
function seit(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const std = Math.floor(min / 60);
  if (std < 24) return `vor ${std} Std.`;
  const tage = Math.floor(std / 24);
  return `vor ${tage} ${tage === 1 ? 'Tag' : 'Tagen'}`;
}

// Eine Statuskachel: Farbe und Symbol sagen auf einen Blick, ob es gut steht.
// (Der Startknopf fuer die Bestands-Triage sitzt weiter unten in der Rueckstands-Karte.)
function StatusKachel({ icon: Icon, titel, wert, unter, ton = 'neutral' }) {
  const toene = {
    gut:     'bg-gradient-to-br from-emerald-500/10 to-transparent border-emerald-500/20 shadow-[0_4px_20px_rgba(16,185,129,0.05)]',
    warnung: 'bg-gradient-to-br from-yellow-500/10 to-transparent border-yellow-500/20 shadow-[0_4px_20px_rgba(234,179,8,0.05)]',
    schlecht:'bg-gradient-to-br from-panel-red/15 to-transparent border-panel-red/30 shadow-[0_4px_20px_rgba(248,81,73,0.1)]',
    neutral: 'bg-gradient-to-br from-panel-surface/50 to-transparent border-panel-border shadow-sm',
  };
  const icons = {
    gut: 'text-emerald-500', warnung: 'text-yellow-500',
    schlecht: 'text-panel-red', neutral: 'text-panel-accent',
  };
  return (
    <div className={`card card-hover relative overflow-hidden !p-5 ${toene[ton]}`}>
      {/* Sanfter Glow-Effekt im Hintergrund */}
      <div className={`absolute -right-6 -top-6 w-24 h-24 rounded-full blur-2xl opacity-20 ${icons[ton].replace('text-', 'bg-')}`} />
      
      <div className="relative z-10">
        <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-panel-muted/80 uppercase mb-2">
          <Icon size={16} className={icons[ton]} /> {titel}
        </div>
        <div className="text-3xl font-black tracking-tight text-white/95 leading-tight">{wert}</div>
        {unter && <div className="text-[11px] text-panel-muted/70 mt-1 font-medium">{unter}</div>}
      </div>
    </div>
  );
}

// Ein schmaler Fortschrittsbalken.
function Balken({ anteil, ton = 'accent' }) {
  const farbe = { accent: 'bg-panel-accent', warnung: 'bg-yellow-500', rot: 'bg-panel-red', gruen: 'bg-emerald-500' }[ton];
  return (
    <div className="h-2 rounded-full bg-panel-border/50 overflow-hidden">
      <div className={`h-full rounded-full ${farbe} transition-[width] duration-500`}
        style={{ width: `${Math.max(0, Math.min(100, anteil))}%` }} />
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [n8n, setN8n] = useState(null);
  const [aufsicht, setAufsicht] = useState(null);
  const [uebersicht, setUebersicht] = useState(null);
  const [startet, setStartet] = useState(false);
  const [startMeldung, setStartMeldung] = useState('');
  const [budgetLaeuft, setBudgetLaeuft] = useState(false);
  const [statsKonto, setStatsKonto] = useState('');
  const [loadingStats, setLoadingStats] = useState(true);

  // Bestands-Triage von Hand anstoßen. n8n startet den Lauf und antwortet sofort —
  // die Arbeit selbst dauert je nach Bestand Minuten bis Stunden, deshalb wird hier
  // nichts abgewartet. Der Fortschritt ist auf der Kachel und im Rückstand zu sehen.
  const bestandStarten = async () => {
    setStartet(true);
    setStartMeldung('');
    try {
      await api.post('/workflows/bestand-starten');
      setStartMeldung('Gestartet — läuft im Hintergrund.');
      setTimeout(laden, 4000);
    } catch (err) {
      setStartMeldung(err.response?.data?.error || 'Start fehlgeschlagen.');
    } finally {
      setStartet(false);
    }
  };

  // Das Budget auf das setzen, was Google heute tatsächlich zugelassen hat —
  // ein bisschen darunter, damit das Panel vorher stoppt und der Lauf sauber
  // endet, statt mittendrin abzubrechen.
  const budgetUebernehmen = async (beobachtet) => {
    setBudgetLaeuft(true);
    try {
      await api.put('/einstellungen', { gemini_tagesbudget: String(empfohlenesBudget(beobachtet)) });
      await laden();
    } catch { /* die Anzeige bleibt, wie sie war */ } finally {
      setBudgetLaeuft(false);
    }
  };

  const laden = async () => {
    // N8n-Status, Aufsicht und Übersicht asynchron laden, ohne den Rest zu blockieren
    api.get('/dashboard/n8n-status')
      .then(res => setN8n(res.data))
      .catch(console.error);

    api.get('/aufsicht')
      .then(res => setAufsicht(res.data))
      .catch(() => setAufsicht(null));

    api.get('/dashboard/uebersicht')
      .then(res => setUebersicht(res.data))
      .catch(() => setUebersicht(null));
  };

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const { data } = await api.get(`/dashboard/stats${statsKonto ? `?konto=${encodeURIComponent(statsKonto)}` : ''}`);
      setStats(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => { 
    laden(); 
  }, []);

  useEffect(() => {
    loadStats();
  }, [statsKonto]);

  // Wir blockieren nicht mehr das gesamte Dashboard, wenn nur die Statistiken laden
  const pieData = stats?.summen ? [
    { name: 'Spam', value: stats.summen.spam },
    { name: 'Phishing', value: stats.summen.phishing },
    { name: 'Viren', value: stats.summen.viren },
    { name: 'Newsletter', value: stats.summen.newsletter },
    { name: 'Clean', value: stats.summen.whitelist }
  ].filter(d => d.value > 0) : [];

  // Was die Aufsicht zuletzt gefunden hat. Ein Ausfall soll ins Auge fallen —
  // sechs Tage stille Sortierpause waren genug.
  const befund = aufsicht?.letzterLauf;
  const stoerung = befund && befund.ok === false;

  return (
    <div className="space-y-6">
      {stoerung && (
        <div className="card border-panel-red bg-panel-red/10 flex items-start gap-3">
          <AlertTriangle size={20} className="text-panel-red mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-medium text-panel-red">
              {befund.n8nErreichbar === false
                ? 'n8n ist nicht erreichbar — es läuft gerade gar nichts.'
                : 'Etwas läuft nicht, was laufen sollte.'}
            </div>
            {befund.fehler && <div className="text-panel-muted mt-1">{befund.fehler}</div>}
            {(befund.abweichungen || []).filter(a => !a.behoben).map((a) => (
              <div key={a.id} className="text-panel-muted mt-1">
                • {a.text}{a.grund && <span className="block ml-3 text-xs">Grund von n8n: {a.grund}</span>}
              </div>
            ))}
            <div className="text-xs text-panel-muted mt-2">
              Zuletzt geprüft: {new Date(befund.zeitpunkt).toLocaleString('de-DE')}
            </div>
          </div>
        </div>
      )}

      {befund?.ok && befund.repariert?.length > 0 && (
        <div className="card border-yellow-600/60 flex items-start gap-3 text-sm">
          <AlertTriangle size={18} className="text-yellow-500 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Wieder eingeschaltet:</span>{' '}
            {befund.repariert.join(', ')} — war ausgefallen und läuft jetzt wieder.
          </div>
        </div>
      )}

      <div className="flex justify-between items-end">
        <div>
          <p className="text-sm text-panel-muted mt-1">Überblick der letzten 30 Tage</p>
        </div>
        
        {n8n && (
          <div className={`px-4 py-2 rounded flex items-center gap-3 ${n8n.online ? 'bg-panel-darker border border-emerald-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
            <div className={`w-3 h-3 rounded-full ${n8n.online ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-red-500'}`} />
            <div>
              <div className="text-xs font-semibold text-panel-text">n8n Engine</div>
              <div className="text-[10px] text-panel-muted">{n8n.online ? `${n8n.activeWorkflows} Workflows aktiv` : 'Offline'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Betrieb & Sortierung — der tägliche Blick */}
      {uebersicht && (() => {
        const u = uebersicht;
        const auf = u.aufsicht;
        const aufTon = !auf ? 'neutral' : (auf.ok ? 'gut' : 'schlecht');
        const aufWert = !auf ? '—' : (auf.n8nErreichbar === false ? 'n8n weg'
          : auf.ok ? 'Alles läuft' : `${auf.abweichungen?.filter(a => !a.behoben).length || 0} Störung`);
        const sich = u.sicherung;
        const sichTon = !sich?.eingerichtet ? 'warnung' : (sich.letzter?.ok ? 'gut' : (sich.letzter ? 'schlecht' : 'neutral'));
        const quote = u.lernen.trefferquote;
        const b = u.budget;
        const budgetAnteil = b.grenze ? (b.heute / b.grenze) * 100 : 0;
        const bl = u.belege;
        // Bestands-Triage: laeuft der Zeitplan und ist der letzte Lauf lange her,
        // stimmt etwas nicht — dann faellt die Kachel auf.
        const bes = u.bestand;
        const besAlterStd = bes?.letzterLauf
          ? (Date.now() - new Date(bes.letzterLauf).getTime()) / 3600000 : null;
        const besTon = !bes?.letzterLauf ? 'neutral'
          : (bes.intervallStunden > 0 && besAlterStd > bes.intervallStunden * 2) ? 'warnung' : 'gut';
        const leseAnteil = bl?.leseGrenze ? (bl.gelesenHeute / bl.leseGrenze) * 100 : 0;

        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatusKachel icon={ShieldCheck} titel="Aufsicht" ton={aufTon} wert={aufWert}
                unter={auf ? `zuletzt ${new Date(auf.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'noch nicht geprüft'} />
              <StatusKachel icon={Target} titel="Trefferquote (7 T.)"
                ton={quote == null ? 'neutral' : quote >= 90 ? 'gut' : quote >= 75 ? 'warnung' : 'schlecht'}
                wert={quote == null ? '—' : `${quote.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`}
                unter={`${u.lernen.einordnungen7} einsortiert, ${u.lernen.korrigiert7} korrigiert`} />
              <StatusKachel icon={HardDriveDownload} titel="Sicherung" ton={sichTon}
                wert={!sich?.eingerichtet ? 'offen' : sich.letzter?.ok ? 'aktuell' : sich.letzter ? 'Fehler' : 'bereit'}
                unter={sich?.letzter ? `${sich.letzter.mails} Mails, ${new Date(sich.letzter.zeitpunkt).toLocaleDateString('de-DE')}` : 'kein Lauf'} />
              <StatusKachel icon={Inbox} titel="Wartet auf dich"
                ton={u.posteingang.offeneEntscheidungen > 0 ? 'warnung' : 'gut'}
                wert={u.posteingang.offeneEntscheidungen}
                unter="Mails ohne Zuordnung" />
              <StatusKachel icon={Workflow} titel="Bestand sortiert" ton={besTon}
                wert={bes?.letzterLauf ? seit(bes.letzterLauf) : 'nie'}
                unter={bes?.letzterLauf
                  ? `${bes.verarbeitet} von ${bes.gesamt} bearbeitet · ${new Date(bes.letzterLauf).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                  : (bes?.intervallStunden > 0 ? `Zeitplan: alle ${bes.intervallStunden} h` : 'noch nie gelaufen')} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Sortier-Fortschritt je Postfach */}
              <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Inbox size={16} className="text-panel-accent" /> Sortier-Rückstand
                </h2>
                {u.posteingang.konten.length === 0 ? (
                  <p className="text-sm text-panel-muted">Kein Postfach eingerichtet.</p>
                ) : (
                  <div className="space-y-3">
                    {u.posteingang.konten.map((k) => (
                      <div key={k.konto_id}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium">{k.konto}</span>
                          <span className={k.erreichbar ? 'text-panel-muted' : 'text-panel-red'}>
                            {k.erreichbar ? `${k.wartend} im Posteingang` : 'nicht erreichbar'}
                          </span>
                        </div>
                        {k.erreichbar && (
                          <Balken anteil={k.wartend === 0 ? 100 : Math.max(4, 100 - Math.min(100, k.wartend))}
                            ton={k.wartend === 0 ? 'gruen' : k.wartend > 50 ? 'warnung' : 'accent'} />
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-panel-muted pt-1">
                      Der Posteingang leert sich, während die Sortierung läuft. Ein voller
                      Balken heißt: nichts liegt mehr ungeordnet.
                    </p>
                    <div className="flex flex-col gap-2 pt-1">
                      <div className="flex items-center gap-3">
                        <button onClick={bestandStarten} disabled={startet}
                          className="btn !py-1.5 !px-3 text-sm flex items-center gap-1 disabled:opacity-50">
                          <Workflow size={14} /> {startet ? 'Wird gestartet …' : 'Bestand jetzt sortieren'}
                        </button>
                        {startMeldung && <span className="text-xs text-panel-muted">{startMeldung}</span>}
                      </div>
                      <div className="flex items-center gap-3 pt-2 mt-2 border-t border-white/5">
                        <button onClick={async () => {
                            if (!confirm('Willst du wirklich das Gedächtnis des Bestands-Scanners löschen? Er wird danach deinen gesamten Posteingang erneut prüfen.')) return;
                            try {
                              await api.post('/workflows/bestand-reset');
                              await bestandStarten();
                            } catch (err) {
                              setStartMeldung('Fehler beim Reset.');
                            }
                          }}
                          className="btn btn-ghost !py-1 !px-3 text-[11px] flex items-center gap-1 text-panel-muted hover:text-white"
                        >
                          <RefreshCw size={12} /> Gesamten Posteingang neu bewerten (Reset)
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* KI-Tagesbudget */}
              {b.kiAnbieter !== 'ollama' && (
                <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Gauge size={16} className="text-panel-accent" /> KI-Tagesbudget
                </h2>
                {b.grenze ? (
                  <div className="space-y-2">
                    <div className="flex justify-between items-end">
                      <span className="text-2xl font-bold">{b.heute}
                        <span className="text-sm text-panel-muted font-normal"> / {b.grenze} Anfragen</span></span>
                      <span className="text-xs text-panel-muted">{b.rest} übrig heute</span>
                    </div>
                    <Balken anteil={budgetAnteil} ton={b.ausgeschoepft ? 'rot' : budgetAnteil > 80 ? 'warnung' : 'accent'} />
                    {/* Anfragen sind die Währung — Googles Limit zählt die.
                        Mails sind das Ergebnis, und seit der Bündelung stecken
                        mehrere davon in einer Anfrage. Beide Zahlen gehören
                        nebeneinander, sonst versteht niemand den Deckel. */}
                    {b.mailsHeute > 0 && (
                      <p className="text-xs text-panel-muted">
                        Dabei eingeordnet: <b className="text-panel-text">{b.mailsHeute}</b> Mails
                        {b.heute > 0 && <> — rund {Math.round(b.mailsHeute / b.heute)} je Anfrage</>}
                      </p>
                    )}
                    <p className="text-xs text-panel-muted pt-1">
                      {b.ausgeschoepft
                        ? 'Heutiges Kontingent aufgebraucht — die Sortierung eines großen Bestands macht morgen weiter.'
                        : `Googles Tageslimit zählt Anfragen, nicht Mails. Das Panel bündelt bis zu ${b.jeAnfrage * 2} Mails in eine.`}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-panel-muted">
                    Kein Tagesbudget gesetzt — die KI ordnet ohne Deckel ein. Unter
                    <span className="font-mono text-panel-accent"> Einstellungen</span> begrenzbar.
                  </p>
                )}

                {/* Was Google heute wirklich zugelassen hat. Einen Rest-Zähler
                    gibt die Gemini-API nicht heraus — das hier ist die Stelle,
                    an der sie abgewiesen hat, und damit die belastbarste Zahl,
                    die zu bekommen ist. */}
                {b.beobachtet && (() => {
                  // Nennt Google in der Absage sein Limit („limit: 500, model: …"),
                  // gilt das. Die eigene Zählung liegt zwangsläufig darunter: Ein
                  // am Gemini-Knoten gestorbener Lauf protokolliert keine seiner
                  // Mails, gekostet haben sie trotzdem. Ohne Zahl in der Meldung
                  // bleibt der eigene Stand die beste Schätzung.
                  const echt = Number(b.beobachtet.limit) > 0;
                  const zahl = echt ? b.beobachtet.limit : b.beobachtet.stand;
                  return (
                    <div className="mt-3 pt-3 border-t border-panel-border text-xs space-y-2">
                      <p className="text-panel-red">
                        {echt ? (
                          <>
                            Google lässt <span className="font-bold">{zahl}</span> Anfragen pro Tag zu
                            {b.beobachtet.modell && <> für <span className="font-mono">{b.beobachtet.modell}</span></>}
                            {' '}— heute ist das Kontingent aufgebraucht.
                          </>
                        ) : (
                          <>
                            Google hat heute bei <span className="font-bold">{zahl}</span> Abfragen
                            abgewiesen.
                          </>
                        )}
                      </p>
                      <p className="text-panel-muted">
                        {echt ? (
                          <>
                            Diese Zahl steht wörtlich in Googles Absage. Selbst gezählt hat das Panel
                            heute {b.beobachtet.stand} — die Lücke sind Mails aus Läufen, die bei
                            Gemini starben und deshalb nie protokolliert wurden. Bis morgen enden
                            weitere Läufe sofort, statt erst nach Minuten abzubrechen.
                          </>
                        ) : (
                          <>
                            Das ist dein tatsächliches Tageskontingent — einen Rest-Zähler gibt die
                            Gemini-API nicht heraus, das Panel zählt selbst mit und merkt sich, wo
                            Google dichtmacht. Setz das Tagesbudget knapp darunter
                            {b.grenze > zahl && <> (steht auf {b.grenze})</>}, dann enden die
                            Läufe sauber, statt mittendrin abzubrechen.
                          </>
                        )}
                      </p>
                      {b.grenze !== empfohlenesBudget(zahl) && (
                        <button onClick={() => budgetUebernehmen(zahl)}
                          disabled={budgetLaeuft}
                          className="btn !py-1 !px-3 text-xs flex items-center gap-1">
                          <Check size={13} />
                          Budget auf {empfohlenesBudget(zahl)} setzen
                        </button>
                      )}
                    </div>
                  );
                })()}

                {/* Welches Modell gerade arbeitet — und ob das Panel gewechselt hat */}
                {b.modell && (
                  <div className="mt-3 pt-3 border-t border-panel-border text-[11px] text-panel-muted">
                    Modell: <span className="font-mono text-panel-text">{b.modell.aktiv}</span>
                    {b.modell.aufErsatz ? (
                      <> — Ersatzmodell, weil das Kontingent von
                        {' '}<span className="font-mono">{b.modell.primaer}</span> heute leer war.
                        Morgen geht es wieder mit dem ersten weiter.</>
                    ) : b.modell.ersatz ? (
                      <> — bei erschöpftem Kontingent schaltet das Panel auf
                        {' '}<span className="font-mono">{b.modell.ersatz}</span> um.</>
                    ) : (
                      <> — ohne Ersatzmodell. Eines unter <span className="text-panel-text">Einstellungen
                        → KI</span> einzutragen verschafft dir bei vollem Kontingent einen zweiten Topf.</>
                    )}
                  </div>
                )}
              </div>
              )}
            </div>

            {/* Belege in Nextcloud */}
            {bl && (
              <div className="card">
                <h2 className="font-medium flex items-center gap-2 mb-3">
                  <Archive size={16} className="text-panel-accent" /> Belege in Nextcloud
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <div className="text-2xl font-bold text-emerald-500">{bl.heute}</div>
                    <div className="text-[11px] text-panel-muted">heute abgelegt</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-panel-muted">{bl.uebersprungenHeute}</div>
                    <div className="text-[11px] text-panel-muted">übersprungen (kein Beleg)</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-panel-text">{bl.woche}</div>
                    <div className="text-[11px] text-panel-muted">letzte 7 Tage</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-panel-text">
                      {bl.leseGrenze ? `${bl.gelesenHeute}/${bl.leseGrenze}` : bl.gelesenHeute}
                    </div>
                    <div className="text-[11px] text-panel-muted">heute gelesen</div>
                  </div>
                </div>
                {bl.leseGrenze ? (
                  <div className="mt-3">
                    <Balken anteil={leseAnteil} ton={leseAnteil >= 100 ? 'rot' : leseAnteil > 80 ? 'warnung' : 'accent'} />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })()}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Gescannte E-Mails', val: stats?.summen?.total ?? 0, color: 'text-blue-400' },
          { label: 'Spam geblockt', val: stats?.summen?.spam ?? 0, color: 'text-amber-500' },
          { label: 'Phishing erkannt', val: stats?.summen?.phishing ?? 0, color: 'text-red-500' },
          { label: 'Viren isoliert', val: stats?.summen?.viren ?? 0, color: 'text-violet-500' },
        ].map((kpi, i) => (
          <div key={i} className="card card-hover relative overflow-hidden group">
            <div className={`absolute -right-8 -bottom-8 w-32 h-32 rounded-full blur-3xl opacity-10 transition-opacity duration-500 group-hover:opacity-20 ${kpi.color.replace('text-', 'bg-')}`} />
            
            <div className="relative z-10">
              <div className="text-xs font-semibold tracking-wide text-panel-muted/80 uppercase mb-2">{kpi.label}</div>
              <div className={`text-4xl font-black tracking-tighter ${kpi.color} drop-shadow-sm`}>
                {loadingStats ? <span className="animate-pulse opacity-50">...</span> : kpi.val}
              </div>
            </div>
            <div className="absolute right-2 bottom-0 opacity-0 group-hover:opacity-5 transition-all duration-500 transform translate-y-4 group-hover:translate-y-0 text-7xl font-black pointer-events-none">#</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bar Chart */}
        <div className="lg:col-span-2 card">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-3">
            <h2 className="text-lg font-semibold">Tagesverlauf (30 Tage)</h2>
            {stats?.konten && stats.konten.length > 0 && (
              <select
                value={statsKonto}
                onChange={(e) => setStatsKonto(e.target.value)}
                className="input-field !py-1.5 !text-sm max-w-[240px]"
              >
                <option value="">Alle Postfächer</option>
                {stats.konten.map(k => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            )}
          </div>
          <div className="h-72 w-full">
            {loadingStats ? (
              <div className="w-full h-full flex items-center justify-center text-panel-muted">Lade Verlauf...</div>
            ) : !stats?.history ? (
              <div className="w-full h-full flex items-center justify-center text-panel-red">Fehler beim Laden</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.history} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorClean" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Clean} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.Clean} stopOpacity={0.2}/>
                    </linearGradient>
                    <linearGradient id="colorNewsletter" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Newsletter} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.Newsletter} stopOpacity={0.2}/>
                    </linearGradient>
                    <linearGradient id="colorSpam" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Spam} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.Spam} stopOpacity={0.2}/>
                    </linearGradient>
                    <linearGradient id="colorPhishing" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Phishing} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.Phishing} stopOpacity={0.2}/>
                    </linearGradient>
                    <linearGradient id="colorViren" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.Viren} stopOpacity={0.8}/>
                      <stop offset="95%" stopColor={COLORS.Viren} stopOpacity={0.2}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="tag" tick={{fill: '#8b949e', fontSize: 11, fontWeight: 500}} tickFormatter={(v) => v.split('-').slice(1).join('.')} axisLine={false} tickLine={false} dy={5} />
                  <YAxis tick={{fill: '#8b949e', fontSize: 11, fontWeight: 500}} axisLine={false} tickLine={false} dx={-5} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#374151', borderRadius: '8px', color: '#f3f4f6' }}
                    itemStyle={{ fontSize: '13px' }}
                  />
                  <Bar dataKey="Clean" stackId="a" fill="url(#colorClean)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="Newsletter" stackId="a" fill="url(#colorNewsletter)" />
                  <Bar dataKey="Spam" stackId="a" fill="url(#colorSpam)" />
                  <Bar dataKey="Phishing" stackId="a" fill="url(#colorPhishing)" />
                  <Bar dataKey="Viren" stackId="a" fill="url(#colorViren)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Pie Chart */}
        <div className="card flex flex-col">
          <h2 className="text-lg font-semibold mb-2">Verteilung</h2>
          <div className="flex-1 min-h-[250px]">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%" cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[entry.name]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1b1e', borderColor: '#374151', borderRadius: '8px', color: '#f3f4f6' }}
                    itemStyle={{ fontSize: '14px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-panel-muted text-sm">
                Keine Daten
              </div>
            )}
          </div>
          
          <div className="flex flex-wrap justify-center gap-4 mt-2">
            {pieData.map(d => (
              <div key={d.name} className="flex items-center gap-2 text-xs text-panel-muted">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[d.name] }} />
                {d.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
