// Sicherung ganzer Postfächer: alle Mails aus IMAP holen, in ein Archiv packen,
// verschlüsseln und außer Haus auf einen FTP-Server legen.
//
// Warum verschlüsselt: Auf dem FTP-Server liegt danach der komplette
// Mailbestand. Wer immer dort Zugriff hat — der Anbieter, ein Mitbenutzer, ein
// Angreifer — soll damit nichts anfangen können. Die Verschlüsselung passiert
// deshalb hier, bevor irgendetwas den Server verlässt, nicht erst unterwegs.
//
// Warum ein eigenes Format und keine fertige Bibliothek: Eine Sicherung, die
// sich nur mit genau der Software öffnen lässt, die gerade kaputt ist, ist
// keine. Das Archiv ist deshalb ein gewöhnliches tar.gz mit je einer
// mbox-Datei pro Ordner — mbox lesen alle Mailprogramme. Und das Entschlüsseln
// steckt zusätzlich in `wiederherstellen.js`, das nur Node braucht, kein Panel,
// keine Abhängigkeiten, keine Datenbank.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { ImapFlow } = require('imapflow');

const db = require('../db');
const settings = require('./settings');
const themen = require('./themen');
const { loggen } = require('./panelLog');

const ARBEIT = '/app/data/sicherung-arbeit';

// ─── Einstellungen ──────────────────────────────────────────────────────────

function einstellungen() {
  const zahl = (key, standard) => {
    const n = Number(settings.hole(key));
    return Number.isFinite(n) && n > 0 ? n : standard;
  };
  return {
    aktiv: settings.hole('sicherung_aktiv') === '1',
    passwort: settings.hole('sicherung_passwort') || '',
    host: settings.hole('sicherung_ftp_host') || '',
    port: zahl('sicherung_ftp_port', 21),
    benutzer: settings.hole('sicherung_ftp_user') || '',
    ftpPasswort: settings.hole('sicherung_ftp_passwort') || '',
    pfad: settings.hole('sicherung_ftp_pfad') || '/',
    // Standard ist TLS. Wer das abschaltet, schickt sein FTP-Passwort im
    // Klartext durchs Netz — das Archiv bleibt zwar verschlüsselt, der Zugang
    // zum Server aber nicht.
    tls: settings.hole('sicherung_ftp_tls') !== '0',
    tlsUnsicher: settings.hole('sicherung_ftp_tls_unsicher') === '1',
    behalten: zahl('sicherung_behalten', 8),
    intervallStunden: zahl('sicherung_intervall', 168),
    // Gmail führt jede Mail zusätzlich in "Alle Nachrichten". Ohne diese
    // Bereinigung läge jede Nachricht doppelt im Archiv.
    dubletten: settings.hole('sicherung_dubletten') !== '0',
  };
}

function bereit(e = einstellungen()) {
  const fehlt = [];
  if (!e.passwort) fehlt.push('Archiv-Passwort');
  if (!e.host) fehlt.push('FTP-Server');
  if (!e.benutzer) fehlt.push('FTP-Benutzer');
  if (!e.ftpPasswort) fehlt.push('FTP-Passwort');
  return fehlt;
}

// ─── tar schreiben (ustar, ohne Fremdbibliothek) ─────────────────────────────
//
// tar ist bewusst simpel aufgebaut: je Datei ein 512-Byte-Kopf, dann der
// Inhalt, aufgefüllt auf ein Vielfaches von 512. Zum Schluss zwei leere Blöcke.
// Das sind fünfzig Zeilen — dafür lohnt keine Abhängigkeit, die man dann
// pflegen und auf Sicherheitslücken beobachten muss.

function oktal(zahl, stellen) {
  return zahl.toString(8).padStart(stellen - 1, '0') + '\0';
}

function tarKopf(name, groesse, zeit) {
  const block = Buffer.alloc(512, 0);
  const schreibe = (text, pos, laenge) => block.write(String(text), pos, laenge, 'utf8');

  if (Buffer.byteLength(name) > 100) {
    // Längere Namen bräuchten das prefix-Feld. So weit kommt es hier nicht,
    // aber stillschweigend abschneiden wäre schlimmer als ein klarer Fehler.
    throw new Error(`Pfad im Archiv zu lang (max. 100 Zeichen): ${name}`);
  }
  schreibe(name, 0, 100);
  schreibe('0000644\0', 100, 8);        // Rechte
  schreibe('0000000\0', 108, 8);        // uid
  schreibe('0000000\0', 116, 8);        // gid
  schreibe(oktal(groesse, 12), 124, 12);
  schreibe(oktal(Math.floor(zeit / 1000), 12), 136, 12);
  schreibe('        ', 148, 8);         // Prüfsumme: erst Leerzeichen
  schreibe('0', 156, 1);                // Typ: gewöhnliche Datei
  schreibe('ustar\0', 257, 6);
  schreibe('00', 263, 2);

  let summe = 0;
  for (const b of block) summe += b;
  schreibe(summe.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}

function auffuellen(groesse) {
  const rest = groesse % 512;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rest, 0);
}

// ─── mbox schreiben ─────────────────────────────────────────────────────────
//
// mbox reiht Nachrichten hintereinander, getrennt durch eine "From "-Zeile.
// Steht im Nachrichtentext selbst eine Zeile, die mit "From " beginnt, würde
// sie als Trenner missverstanden — sie bekommt deshalb ein ">" davor
// (mboxrd-Schreibweise, die das beim Zurücklesen wieder rückgängig macht).

function mboxTrenner(absender, datum) {
  const wann = (datum instanceof Date && !Number.isNaN(datum.getTime())) ? datum : new Date();
  return `From ${absender || 'MAILER-DAEMON'} ${wann.toUTCString()}\n`;
}

function mboxEntschaerfen(roh) {
  return roh.toString('binary').replace(/^(>*From )/gm, '>$1');
}

// ─── Verschlüsselung ────────────────────────────────────────────────────────
//
// AES-256-GCM. Der Schlüssel wird aus dem Passwort mit scrypt abgeleitet —
// absichtlich langsam, damit sich ein geratenes Passwort nicht millionenfach
// pro Sekunde durchprobieren lässt. GCM erkennt außerdem jede nachträgliche
// Veränderung der Datei; ein beschädigtes Archiv fällt beim Entschlüsseln auf
// und wird nicht halb ausgepackt.
//
// Dateiaufbau: MPSICH1 | Salz (16) | IV (12) | Geheimtext | Prüfsiegel (16)
const KOPF = Buffer.from('MPSICH1\n', 'utf8');

function schluessel(passwort, salz) {
  return crypto.scryptSync(Buffer.from(passwort, 'utf8'), salz, 32, { N: 16384, r: 8, p: 1 });
}

async function verschluesselnNach(quelle, ziel, passwort) {
  const salz = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const chiffre = crypto.createCipheriv('aes-256-gcm', schluessel(passwort, salz), iv);

  const aus = fs.createWriteStream(ziel);
  aus.write(KOPF);
  aus.write(salz);
  aus.write(iv);
  await pipeline(fs.createReadStream(quelle), chiffre, aus, { end: false });
  await new Promise((fertig, schief) => {
    aus.end(chiffre.getAuthTag(), (err) => (err ? schief(err) : fertig()));
  });
}

// Gegenstück — wird von wiederherstellen.js und vom Selbsttest benutzt.
async function entschluesselnNach(quelle, ziel, passwort) {
  const gesamt = (await fsp.stat(quelle)).size;
  const vorspann = KOPF.length + 16 + 12;
  if (gesamt < vorspann + 16) throw new Error('Datei ist zu klein für eine Sicherung.');

  const griff = await fsp.open(quelle, 'r');
  try {
    const kopf = Buffer.alloc(vorspann);
    await griff.read(kopf, 0, vorspann, 0);
    if (!kopf.subarray(0, KOPF.length).equals(KOPF)) {
      throw new Error('Das ist keine Mail-Panel-Sicherung (Kennung fehlt).');
    }
    const salz = kopf.subarray(KOPF.length, KOPF.length + 16);
    const iv = kopf.subarray(KOPF.length + 16, vorspann);

    const siegel = Buffer.alloc(16);
    await griff.read(siegel, 0, 16, gesamt - 16);

    const dechiffre = crypto.createDecipheriv('aes-256-gcm', schluessel(passwort, salz), iv);
    dechiffre.setAuthTag(siegel);
    await pipeline(
      fs.createReadStream(quelle, { start: vorspann, end: gesamt - 17 }),
      dechiffre,
      fs.createWriteStream(ziel),
    );
  } finally {
    await griff.close();
  }
}

// ─── Postfach auslesen ──────────────────────────────────────────────────────

function verbindung(zugang) {
  return new ImapFlow({
    host: zugang.host,
    port: Number(zugang.port),
    secure: Number(zugang.port) === 993,
    auth: { user: zugang.username, pass: zugang.passwort },
    logger: false,
    tls: { rejectUnauthorized: !zugang.tlsUnsicher },
    socketTimeout: 120000,
  });
}

// Ordnernamen wie "[Gmail]/Alle Nachrichten" müssen einen Dateinamen ergeben,
// der in einem tar nichts kaputt macht — insbesondere keine Pfadwechsel.
function dateiName(roh) {
  return String(roh)
    .replace(/[/\\]/g, '_')
    .replace(/[^\p{L}\p{N} ._&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Ordner';
}

// Schreibt einen IMAP-Ordner als mbox-Datei und meldet, was drin gelandet ist.
async function ordnerNachMbox(client, ordner, zielDatei, gesehen, opt) {
  const schloss = await client.getMailboxLock(ordner).catch(() => null);
  if (!schloss) return { mails: 0, uebersprungen: 0, bytes: 0 };
  const aus = fs.createWriteStream(zielDatei);
  // Ohne diesen Zuhoerer bleibt ein Schreibfehler unbemerkt, und der Lauf
  // scheitert erst weiter unten beim stat() mit "Datei nicht gefunden" — eine
  // Meldung, die auf die falsche Faehrte fuehrt. Genau das ist am 02.09.
  // passiert, als dem Arbeitsverzeichnis die Schreibrechte fehlten.
  let schreibFehler = null;
  aus.on('error', (err) => { schreibFehler = err; });
  let mails = 0; let uebersprungen = 0;
  try {
    if (client.mailbox.exists > 0) {
      for await (const m of client.fetch('1:*', { source: true, envelope: true })) {
        const id = m.envelope?.messageId;
        if (opt.dubletten && id) {
          if (gesehen.has(id)) { uebersprungen++; continue; }
          gesehen.add(id);
        }
        const absender = m.envelope?.from?.[0]?.address || 'MAILER-DAEMON';
        aus.write(mboxTrenner(absender, m.envelope?.date));
        aus.write(Buffer.from(mboxEntschaerfen(m.source), 'binary'));
        aus.write('\n');
        mails++;
      }
    }
  } finally {
    schloss.release();
    await new Promise((f) => aus.end(f));
  }
  if (schreibFehler) throw schreibFehler;
  const bytes = (await fsp.stat(zielDatei)).size;
  return { mails, uebersprungen, bytes };
}

// ─── Archiv bauen ───────────────────────────────────────────────────────────

// Eine Datei an den offenen tar-Strom haengen.
//
// Bewusst nicht ueber pipeline(): Das haengt bei jedem Aufruf Ereignis-Zuhoerer
// an denselben Zielstrom und entfernt sie nicht wieder, weil der Strom offen
// bleiben muss. Bei zwoelf Ordnern warnt Node schon, bei fuenfzig waere es ein
// echtes Leck. Hier wird stattdessen in Stuecken geschrieben und dabei der
// Rueckstau beachtet, damit auch grosse Ordner nicht den Speicher fuellen.
function anhaengen(ziel, quelle) {
  return new Promise((fertig, schief) => {
    const lesen = fs.createReadStream(quelle);
    lesen.on('error', schief);
    lesen.on('data', (stueck) => {
      if (!ziel.write(stueck)) {
        lesen.pause();
        ziel.once('drain', () => lesen.resume());
      }
    });
    lesen.on('end', fertig);
  });
}

async function archivBauen(konten, zielTar, opt) {
  await fsp.mkdir(ARBEIT, { recursive: true });
  const tar = fs.createWriteStream(zielTar);
  const schreibe = (b) => new Promise((f, s) => tar.write(b, (e) => (e ? s(e) : f())));
  const bericht = [];

  try {
    for (const konto of konten) {
      const zugang = themen.zugang(konto);
      const client = verbindung(zugang);
      // Ein Konto, das gerade nicht erreichbar ist, darf die Sicherung der
      // anderen nicht verhindern.
      try {
        await client.connect();
      } catch (err) {
        bericht.push({ konto: konto.name, fehler: err.message, mails: 0 });
        loggen('warn', 'sicherung', `${konto.name} nicht erreichbar: ${err.message}`);
        continue;
      }

      // Innerhalb eines Kontos nur einmal je Nachricht — Gmail zeigt jede Mail
      // zusätzlich in "Alle Nachrichten" an. Zuerst die echten Ordner, damit
      // die Mail dort landet, wo der Nutzer sie einsortiert hat, und nicht im
      // Sammelordner.
      const gesehen = new Set();
      let mailsGesamt = 0; let dublettenGesamt = 0;
      try {
        const ordner = [];
        for await (const box of await client.list()) {
          if ([...(box.flags || [])].includes(`${String.fromCharCode(92)}Noselect`)) continue;
          ordner.push(box);
        }
        const istSammel = (b) => [...(b.flags || [])].includes(`${String.fromCharCode(92)}All`);
        ordner.sort((a, b) => Number(istSammel(a)) - Number(istSammel(b)));

        for (const box of ordner) {
          const temp = path.join(ARBEIT, 'ordner.mbox');
          const erg = await ordnerNachMbox(client, box.path, temp, gesehen, opt);
          mailsGesamt += erg.mails;
          dublettenGesamt += erg.uebersprungen;
          if (erg.mails === 0) { await fsp.rm(temp, { force: true }); continue; }

          const pfad = `${dateiName(konto.name)}/${dateiName(box.path)}.mbox`;
          await schreibe(tarKopf(pfad, erg.bytes, Date.now()));
          await anhaengen(tar, temp);
          await schreibe(auffuellen(erg.bytes));
          await fsp.rm(temp, { force: true });
        }
      } finally {
        try { await client.logout(); } catch { /* Verbindung war schon zu */ }
      }
      bericht.push({ konto: konto.name, mails: mailsGesamt, dubletten: dublettenGesamt });
    }

    // Ein tar endet mit zwei leeren Blöcken.
    await schreibe(Buffer.alloc(1024, 0));
  } finally {
    await new Promise((f) => tar.end(f));
  }
  return bericht;
}

// ─── Hochladen ──────────────────────────────────────────────────────────────

async function hochladen(datei, name, e) {
  // Verzögert laden: Ohne eingerichtete Sicherung wird die Bibliothek nie
  // gebraucht, und das Panel soll auch ohne sie starten können.
  const { Client } = require('basic-ftp');
  const client = new Client(60000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: e.host,
      port: e.port,
      user: e.benutzer,
      password: e.ftpPasswort,
      secure: e.tls,
      secureOptions: { rejectUnauthorized: !e.tlsUnsicher },
    });
    if (e.pfad && e.pfad !== '/') await client.ensureDir(e.pfad);
    await client.uploadFrom(datei, name);

    // Alte Stände wegräumen, sonst läuft der FTP-Speicher irgendwann voll und
    // die Sicherung scheitert genau dann, wenn man sie braucht.
    let geloescht = 0;
    if (e.behalten > 0) {
      const liste = (await client.list())
        .filter((f) => f.isFile && /^postfaecher-.*\.mpsich$/.test(f.name))
        .map((f) => f.name)
        .sort();
      for (const alt of liste.slice(0, Math.max(0, liste.length - e.behalten))) {
        await client.remove(alt);
        geloescht++;
      }
    }
    return { geloescht };
  } finally {
    client.close();
  }
}

async function verbindungTesten() {
  const e = einstellungen();
  const fehlt = bereit(e);
  if (fehlt.includes('FTP-Server') || fehlt.includes('FTP-Benutzer') || fehlt.includes('FTP-Passwort')) {
    throw new Error(`Noch nicht vollständig: ${fehlt.join(', ')}.`);
  }
  const { Client } = require('basic-ftp');
  const client = new Client(30000);
  try {
    await client.access({
      host: e.host, port: e.port, user: e.benutzer, password: e.ftpPasswort,
      secure: e.tls, secureOptions: { rejectUnauthorized: !e.tlsUnsicher },
    });
    if (e.pfad && e.pfad !== '/') await client.ensureDir(e.pfad);
    const staende = (await client.list()).filter((f) => f.isFile && f.name.endsWith('.mpsich'));
    return {
      ok: true,
      verschluesselt: e.tls,
      pfad: await client.pwd(),
      vorhandeneStaende: staende.length,
    };
  } finally {
    client.close();
  }
}

// ─── Der ganze Lauf ─────────────────────────────────────────────────────────

// trockenlauf: baut, verschlüsselt und liest gegen — lädt aber nichts hoch und
// behält die Datei, damit man sie ansehen kann. Gedacht zum Ausprobieren,
// bevor ein FTP-Zugang eingerichtet ist, und zum Prüfen nach Änderungen.
async function lauf({ nurKonten = null, trockenlauf = false } = {}) {
  const e = einstellungen();
  const fehlt = bereit(e).filter((f) => (trockenlauf ? f === 'Archiv-Passwort' : true));
  if (fehlt.length) throw new Error(`Sicherung ist nicht eingerichtet — es fehlt: ${fehlt.join(', ')}.`);

  const konten = db.prepare('SELECT * FROM accounts').all()
    .filter((k) => !nurKonten || nurKonten.includes(k.id));
  if (konten.length === 0) throw new Error('Kein Konto zum Sichern vorhanden.');

  const stand = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `postfaecher-${stand}.mpsich`;
  const tarDatei = path.join(ARBEIT, 'archiv.tar');
  const packDatei = path.join(ARBEIT, 'archiv.tar.gz');
  const fertig = path.join(ARBEIT, name);
  const begonnen = Date.now();

  try {
    await fsp.mkdir(ARBEIT, { recursive: true });
    // Das Verzeichnis liegt im Datenträger und überlebt Neustarts. Wurde es
    // einmal von einem Wartungsbefehl als root angelegt, kann der Dienst — der
    // als "node" läuft — dort nichts mehr schreiben. Lieber hier klar sagen,
    // was zu tun ist, als mitten im Lauf an einer irreführenden Stelle zu
    // scheitern.
    try {
      await fsp.access(ARBEIT, fs.constants.W_OK);
    } catch {
      throw new Error(
        `Das Arbeitsverzeichnis ${ARBEIT} gehört nicht dem Panel-Benutzer — dort lässt sich nichts `
        + 'schreiben. Auf dem Server einmal ausführen: '
        + 'docker exec -u root mail-panel chown -R node:node /app/data',
      );
    }
    const bericht = await archivBauen(konten, tarDatei, e);
    // Kam von keinem einzigen Konto etwas an, gibt es nichts zu sichern. Ein
    // leeres Archiv hochzuladen wäre schlimmer als ein Fehlschlag: Es würde
    // einen älteren, brauchbaren Stand aus der Aufbewahrung verdrängen.
    if (bericht.every((b) => !b.mails)) {
      const gruende = bericht.filter((b) => b.fehler).map((b) => `${b.konto}: ${b.fehler}`);
      throw new Error(gruende.length
        ? `Kein einziges Konto war erreichbar — ${gruende.join('; ')}`
        : 'In keinem Konto wurde eine Mail gefunden.');
    }
    await pipeline(fs.createReadStream(tarDatei), zlib.createGzip({ level: 9 }), fs.createWriteStream(packDatei));
    await verschluesselnNach(packDatei, fertig, e.passwort);

    // Vor dem Hochladen gegenlesen: Lässt sich das Archiv mit demselben
    // Passwort wieder öffnen? Eine Sicherung, die niemand je aufmacht, ist
    // eine Vermutung. Der Aufwand ist ein Bruchteil des Sicherns.
    const probe = path.join(ARBEIT, 'probe.tar.gz');
    await entschluesselnNach(fertig, probe, e.passwort);
    const urspruenglich = (await fsp.stat(packDatei)).size;
    const zurueck = (await fsp.stat(probe)).size;
    await fsp.rm(probe, { force: true });
    if (urspruenglich !== zurueck) {
      throw new Error('Gegenprobe fehlgeschlagen — das Archiv ließ sich nicht unversehrt zurücklesen.');
    }

    const groesse = (await fsp.stat(fertig)).size;
    const { geloescht } = trockenlauf ? { geloescht: 0 } : await hochladen(fertig, name, e);

    const mails = bericht.reduce((s, b) => s + (b.mails || 0), 0);

    // Ein Konto, das nicht erreichbar war, fehlt vollständig im Archiv. Das
    // darf niemals als sauberer Erfolg durchgehen: Wer sich auf die Sicherung
    // verlässt, merkt es sonst erst, wenn er sie braucht. Genau so ist es am
    // 02.09. passiert — der Dovecot-Container war seit Tagen aus, die Sicherung
    // meldete trotzdem "fertig".
    const gescheitert = bericht.filter((b) => b.fehler);
    const ergebnis = {
      ok: true,
      unvollstaendig: gescheitert.length > 0,
      fehlendeKonten: gescheitert.map((b) => `${b.konto}: ${b.fehler}`),
      datei: name,
      groesse,
      mails,
      konten: bericht,
      geloescht,
      dauer: Math.round((Date.now() - begonnen) / 1000),
      zeitpunkt: new Date().toISOString(),
      trockenlauf,
    };
    // Ein Trockenlauf ist kein Sicherungsstand — er darf den Zeitplan nicht
    // zurücksetzen, sonst faellt die naechste echte Sicherung aus.
    if (!trockenlauf) settings.setze('sicherung_letzter_lauf', JSON.stringify(ergebnis));
    loggen(gescheitert.length ? 'warn' : 'info', 'sicherung',
      `Postfach-Sicherung${trockenlauf ? ' (Trockenlauf)' : ''} ${name}: ${mails} Mails, `
      + `${(groesse / 1048576).toFixed(1)} MB, `
      + `${ergebnis.dauer}s${geloescht ? `, ${geloescht} alte Stände entfernt` : ''}`
      + (gescheitert.length
        ? `. UNVOLLSTÄNDIG — nicht gesichert: ${ergebnis.fehlendeKonten.join('; ')}`
        : '.'));
    return ergebnis;
  } catch (err) {
    const ergebnis = { ok: false, fehler: err.message, zeitpunkt: new Date().toISOString() };
    settings.setze('sicherung_letzter_lauf', JSON.stringify(ergebnis));
    loggen('error', 'sicherung', `Postfach-Sicherung fehlgeschlagen: ${err.message}`);
    throw err;
  } finally {
    // Aufräumen in jedem Fall: Die Zwischenstände sind unverschlüsselt.
    // Beim Trockenlauf bleibt allein die fertige, verschlüsselte Datei liegen.
    const reste = [tarDatei, packDatei, path.join(ARBEIT, 'ordner.mbox'), path.join(ARBEIT, 'probe.tar.gz')];
    if (!trockenlauf) reste.push(fertig);
    for (const d of reste) {
      await fsp.rm(d, { force: true }).catch(() => {});
    }
  }
}

function letzterLauf() {
  try { return JSON.parse(settings.hole('sicherung_letzter_lauf') || 'null'); } catch { return null; }
}

// ─── Zeitplan ───────────────────────────────────────────────────────────────
//
// Das Panel hat keinen eigenen Zeitplaner. Statt einen einzuführen, wird
// stündlich nachgesehen, ob der letzte Lauf lange genug her ist. Das übersteht
// auch einen Neustart, weil der Zeitpunkt in den Einstellungen steht und nicht
// im Arbeitsspeicher.
let uhr = null;

function faellig() {
  const e = einstellungen();
  if (!e.aktiv || bereit(e).length) return false;
  const letzter = letzterLauf();
  if (!letzter?.zeitpunkt) return true;
  const her = Date.now() - new Date(letzter.zeitpunkt).getTime();
  return her >= e.intervallStunden * 3600 * 1000;
}

function zeitplanStarten(intervallMs = 3600 * 1000) {
  if (uhr) clearInterval(uhr);
  uhr = setInterval(() => {
    if (!faellig()) return;
    lauf().catch((err) => loggen('error', 'sicherung', `Geplanter Lauf fehlgeschlagen: ${err.message}`));
  }, intervallMs);
  if (uhr.unref) uhr.unref();
  return uhr;
}

module.exports = {
  einstellungen, bereit, lauf, letzterLauf, verbindungTesten,
  zeitplanStarten, faellig,
  // für Tests und wiederherstellen.js
  verschluesselnNach, entschluesselnNach, tarKopf, mboxEntschaerfen, dateiName,
};
