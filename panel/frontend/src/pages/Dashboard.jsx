// Etappe 1: schlanker Platzhalter — Kennzahlen und Charts kommen in Etappe 7,
// sobald der Triage-Log Daten liefert.
export default function Dashboard() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <div className="card">
        <p className="text-panel-muted text-sm">
          Hier entstehen in Etappe 7 die Kennzahlen: Mails pro Tag je Konto, Spam-Quote,
          Quarantäne-Zähler und Workflow-Status. Voraussetzung ist der Triage-Log aus den
          n8n-Workflows — richte zuerst unter <span className="text-panel-text">Einstellungen</span>{' '}
          die Verbindungen ein.
        </p>
      </div>
    </div>
  );
}
