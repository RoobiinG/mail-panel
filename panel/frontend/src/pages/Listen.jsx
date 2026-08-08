import { useEffect, useState } from 'react';
import { Plus, Trash2, ShieldCheck, ShieldX } from 'lucide-react';
import api from '../api';

// Eine Liste (Whitelist oder Blacklist) mit Eingabefeld und Tabelle
function Liste({ typ, titel, beschreibung, Icon, farbe, daten, aufAenderung }) {
  const [muster, setMuster] = useState('');
  const [kommentar, setKommentar] = useState('');
  const [fehler, setFehler] = useState('');

  const hinzufuegen = async (e) => {
    e.preventDefault();
    setFehler('');
    try {
      await api.post('/listen', { typ, muster, kommentar });
      setMuster('');
      setKommentar('');
      aufAenderung();
    } catch (err) {
      setFehler(err.response?.data?.error || 'Hinzufügen fehlgeschlagen.');
    }
  };

  const entfernen = async (id) => {
    await api.delete(`/listen/${id}`);
    aufAenderung();
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className={`font-medium flex items-center gap-2 ${farbe}`}>
          <Icon size={18} /> {titel}
        </h2>
        <p className="text-sm text-panel-muted mt-1">{beschreibung}</p>
      </div>

      <form onSubmit={hinzufuegen} className="flex gap-2">
        <input
          value={muster}
          onChange={(e) => setMuster(e.target.value)}
          placeholder="absender@example.org oder example.org"
          className="flex-1"
        />
        <input
          value={kommentar}
          onChange={(e) => setKommentar(e.target.value)}
          placeholder="Notiz (optional)"
          className="w-40"
        />
        <button type="submit" className="btn-primary flex items-center gap-1 whitespace-nowrap">
          <Plus size={16} /> Hinzufügen
        </button>
      </form>
      {fehler && <p className="text-sm text-panel-red">{fehler}</p>}

      {daten.length === 0 ? (
        <p className="text-sm text-panel-muted">Noch keine Einträge.</p>
      ) : (
        <ul className="divide-y divide-panel-border">
          {daten.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-mono">{e.muster}</span>
              <span className="flex items-center gap-3">
                {e.kommentar && <span className="text-panel-muted text-xs">{e.kommentar}</span>}
                <button
                  onClick={() => entfernen(e.id)}
                  className="text-panel-muted hover:text-panel-red"
                  title="Entfernen"
                >
                  <Trash2 size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Listen() {
  const [daten, setDaten] = useState(null);
  const laden = () => api.get('/listen').then((res) => setDaten(res.data));
  useEffect(() => { laden(); }, []);

  if (!daten) return <p className="text-panel-muted">Lade…</p>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">White- / Blacklist</h1>
        <p className="text-sm text-panel-muted mt-1">
          Eigene Absenderlisten für alle Konten. Eine Domain ohne <code>@</code> gilt
          auch für alle Unterdomains. Die Whitelist wird zuerst geprüft.
        </p>
      </div>

      <Liste
        typ="whitelist"
        titel="Whitelist"
        beschreibung="Diese Absender landen nie in der Quarantäne — sie übersteuert alle anderen Prüfungen inklusive DNSBL und KI-Bewertung."
        Icon={ShieldCheck}
        farbe="text-panel-green"
        daten={daten.whitelist}
        aufAenderung={laden}
      />

      <Liste
        typ="blacklist"
        titel="Blacklist"
        beschreibung="Diese Absender gehen direkt in die Quarantäne — ohne KI-Abfrage. Gelöscht wird auch hier nichts."
        Icon={ShieldX}
        farbe="text-panel-red"
        daten={daten.blacklist}
        aufAenderung={laden}
      />
    </div>
  );
}
