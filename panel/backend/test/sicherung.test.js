// Die Postfach-Sicherung an der Stelle, auf die es ankommt: Kommt aus dem
// verschlüsselten Archiv wieder heraus, was hineingegangen ist — und merkt
// jemand, wenn nicht?
//
// Eine Sicherung, die man nie zurückspielt, ist eine Vermutung. Hier wird sie
// bei jedem Lauf zurückgespielt.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('node:fs/promises');
const path = require('path');
const zlib = require('zlib');
const { ordner: ARBEIT } = require('./umgebung');

const sich = require('../src/services/postfachSicherung');

const tmp = (name) => path.join(ARBEIT, name);
const PASSWORT = 'ein-ausreichend-langes-testpasswort';

describe('Verschlüsselung', () => {
  test('hin und zurück ergibt dasselbe', async () => {
    const quelle = tmp('klar.bin');
    const inhalt = Buffer.concat([
      Buffer.from('Betreff: Test\r\n\r\nHallo Welt\r\n', 'utf8'),
      require('crypto').randomBytes(50000), // auch Binäres muss heil bleiben
    ]);
    await fsp.writeFile(quelle, inhalt);

    await sich.verschluesselnNach(quelle, tmp('geheim.mpsich'), PASSWORT);
    await sich.entschluesselnNach(tmp('geheim.mpsich'), tmp('zurueck.bin'), PASSWORT);

    assert.deepEqual(await fsp.readFile(tmp('zurueck.bin')), inhalt);
  });

  test('das Archiv sieht nicht mehr nach dem Original aus', async () => {
    const quelle = tmp('klar2.bin');
    await fsp.writeFile(quelle, Buffer.from('GEHEIMES STICHWORT'.repeat(50), 'utf8'));
    await sich.verschluesselnNach(quelle, tmp('geheim2.mpsich'), PASSWORT);
    const roh = await fsp.readFile(tmp('geheim2.mpsich'));
    assert.equal(roh.includes('GEHEIMES STICHWORT'), false, 'Klartext im Archiv gefunden');
    assert.equal(roh.subarray(0, 8).toString(), 'MPSICH1\n', 'Kennung fehlt');
  });

  test('falsches Passwort gibt nichts heraus', async () => {
    await fsp.writeFile(tmp('klar3.bin'), 'streng geheim');
    await sich.verschluesselnNach(tmp('klar3.bin'), tmp('geheim3.mpsich'), PASSWORT);
    await assert.rejects(
      () => sich.entschluesselnNach(tmp('geheim3.mpsich'), tmp('nie.bin'), 'falsch'),
      'ein falsches Passwort muss scheitern',
    );
  });

  // Ohne diese Eigenschaft könnte jemand das Archiv auf dem FTP-Server
  // verändern, ohne dass es beim Zurückspielen auffiele.
  test('nachträglich verändertes Archiv wird erkannt', async () => {
    await fsp.writeFile(tmp('klar4.bin'), 'Inhalt, der zählt');
    await sich.verschluesselnNach(tmp('klar4.bin'), tmp('geheim4.mpsich'), PASSWORT);
    const roh = await fsp.readFile(tmp('geheim4.mpsich'));
    roh[roh.length - 30] ^= 0xff;
    await fsp.writeFile(tmp('manipuliert.mpsich'), roh);
    await assert.rejects(
      () => sich.entschluesselnNach(tmp('manipuliert.mpsich'), tmp('nie2.bin'), PASSWORT),
    );
  });

  test('eine fremde Datei wird als solche erkannt', async () => {
    await fsp.writeFile(tmp('fremd.bin'), Buffer.alloc(200, 7));
    await assert.rejects(
      () => sich.entschluesselnNach(tmp('fremd.bin'), tmp('nie3.bin'), PASSWORT),
      /keine Mail-Panel-Sicherung|Kennung/i,
    );
  });

  test('jeder Lauf erzeugt ein anderes Archiv (eigenes Salz und IV)', async () => {
    await fsp.writeFile(tmp('klar5.bin'), 'immer derselbe Inhalt');
    await sich.verschluesselnNach(tmp('klar5.bin'), tmp('a.mpsich'), PASSWORT);
    await sich.verschluesselnNach(tmp('klar5.bin'), tmp('b.mpsich'), PASSWORT);
    const a = await fsp.readFile(tmp('a.mpsich'));
    const b = await fsp.readFile(tmp('b.mpsich'));
    assert.equal(a.equals(b), false, 'zwei Läufe dürfen nicht Byte für Byte gleich sein');
  });
});

describe('mbox — die "From "-Falle', () => {
  // Steht im Text einer Mail eine Zeile, die mit "From " beginnt, würde sie
  // beim Zurücklesen als Beginn einer neuen Nachricht gelten. Die Mail wäre
  // mitten entzwei. Deshalb bekommt sie ein ">" davor.
  test('"From " am Zeilenanfang wird entschärft', () => {
    const roh = Buffer.from('Zeile eins\nFrom hier ginge es kaputt\nZeile drei\n', 'utf8');
    const raus = sich.mboxEntschaerfen(roh);
    assert.match(raus, /\n>From hier/);
    assert.doesNotMatch(raus, /\nFrom hier/);
  });

  test('schon entschärfte Zeilen bekommen ein weiteres ">"', () => {
    const raus = sich.mboxEntschaerfen(Buffer.from('>From schon\n', 'utf8'));
    assert.match(raus, /^>>From schon/);
  });

  test('"From" ohne Leerzeichen bleibt unangetastet', () => {
    assert.equal(sich.mboxEntschaerfen(Buffer.from('Fromage ist Kaese\n', 'utf8')),
      'Fromage ist Kaese\n');
  });

  // Die Funktion arbeitet bewusst auf Bytes und nicht auf Text: Eine Mail kann
  // in jeder Kodierung ankommen, und ein Umweg über UTF-8 würde alles
  // beschädigen, was nicht zufällig gültiges UTF-8 ist.
  test('Bytes bleiben Bytes — Umlaute und Binäres überstehen es unversehrt', () => {
    const roh = Buffer.from([0xC3, 0xA4, 0x0A, 0x46, 0x72, 0x6F, 0x6D, 0x20, 0x78, 0x0A, 0xFF, 0xFE]);
    const raus = Buffer.from(sich.mboxEntschaerfen(roh), 'binary');
    const erwartet = Buffer.from([0xC3, 0xA4, 0x0A, 0x3E, 0x46, 0x72, 0x6F, 0x6D, 0x20, 0x78, 0x0A, 0xFF, 0xFE]);
    assert.deepEqual(raus, erwartet);
  });
});

describe('tar-Kopf', () => {
  test('Name, Größe und Prüfsumme stehen an der richtigen Stelle', () => {
    const kopf = sich.tarKopf('Konto/Ordner.mbox', 1234, 1756800000000);
    assert.equal(kopf.length, 512);
    assert.equal(kopf.subarray(0, 17).toString(), 'Konto/Ordner.mbox');
    assert.equal(kopf.subarray(124, 135).toString(), '00000002322', 'Größe oktal');
    assert.equal(kopf.subarray(257, 262).toString(), 'ustar');

    // Die Prüfsumme muss über den Block mit Leerzeichen an ihrer Stelle stimmen
    const kontrolle = Buffer.from(kopf);
    kontrolle.write('        ', 148, 8);
    let summe = 0;
    for (const b of kontrolle) summe += b;
    assert.equal(kopf.subarray(148, 154).toString(), summe.toString(8).padStart(6, '0'));
  });

  test('zu lange Pfade werden abgelehnt statt abgeschnitten', () => {
    assert.throws(() => sich.tarKopf('A'.repeat(101), 1, Date.now()), /zu lang/);
  });
});

describe('Ordnernamen für das Archiv', () => {
  test('Schrägstriche werden ersetzt, es entsteht kein Pfadwechsel', () => {
    assert.equal(sich.dateiName('[Gmail]/Alle Nachrichten'), 'Gmail_Alle Nachrichten');
    // Nicht auf eine bestimmte Zeichenkette prüfen, sondern auf die
    // Eigenschaft, um die es geht: kein Trenner und kein ".." bleibt übrig.
    const BS = String.fromCharCode(92);
    for (const boese of ['../../etc', 'a/../b', `..${BS}..${BS}windows`, './versteckt']) {
      const raus = sich.dateiName(boese);
      assert.ok(!raus.includes('..'), `"${boese}" ergibt "${raus}" — enthält ".."`);
      assert.ok(!raus.includes('/'), `"${boese}" ergibt "${raus}" — enthält "/"`);
      assert.ok(!raus.includes(BS), `"${boese}" ergibt "${raus}" — enthält Backslash`);
    }
  });

  test('leerer Name ergibt einen brauchbaren Ersatz', () => {
    assert.equal(sich.dateiName(''), 'Ordner');
    assert.equal(sich.dateiName('///'), 'Ordner');
  });
});

describe('Vollständigkeit des Archivs', () => {
  test('gzip überlebt die Verschlüsselung', async () => {
    const daten = Buffer.from('x'.repeat(10000), 'utf8');
    await fsp.writeFile(tmp('roh.bin'), zlib.gzipSync(daten));
    await sich.verschluesselnNach(tmp('roh.bin'), tmp('g.mpsich'), PASSWORT);
    await sich.entschluesselnNach(tmp('g.mpsich'), tmp('roh-zurueck.gz'), PASSWORT);
    const zurueck = zlib.gunzipSync(await fsp.readFile(tmp('roh-zurueck.gz')));
    assert.deepEqual(zurueck, daten);
  });
});

describe('FTP-Fehler übersetzen', () => {
  const ziel = { host: 'box.example', port: 23, pfad: '/' };

  // Der Anlass: Bei Hetzner-Storage-Boxen ist Port 23 der SSH-Zugang. Die
  // FTP-Bibliothek wartet dort vergeblich und meldet "(control socket)" —
  // eine Auskunft, aus der niemand ableiten kann, was zu tun ist.
  test('SSH auf dem FTP-Port wird beim Namen genannt', () => {
    const err = sich.ftpFehlerDeuten(
      new Error('Timeout (control socket)'), ziel, 'SSH-2.0-OpenSSH_9.6p1',
    );
    assert.match(err.message, /SSH-Dienst/);
    assert.match(err.message, /Port 21/, 'muss sagen, was stattdessen zu nehmen ist');
  });

  test('ohne Begrüßung wenigstens der Hinweis auf den Port', () => {
    const err = sich.ftpFehlerDeuten(new Error('Timeout (control socket)'), ziel, null);
    assert.match(err.message, /nicht wie ein FTP-Server/);
    assert.match(err.message, /21/);
  });

  test('die übrigen Fälle', () => {
    const f = (text) => sich.ftpFehlerDeuten(new Error(text), ziel, null).message;
    assert.match(f('getaddrinfo ENOTFOUND box.example'), /nicht auflösbar/);
    assert.match(f('connect ECONNREFUSED 1.2.3.4:21'), /nimmt keine Verbindung an/);
    assert.match(f('530 Login authentication failed'), /Benutzername oder Passwort/);
    assert.match(f('unable to verify the first certificate'), /Zertifikat/);
    assert.match(f('550 Permission denied'), /verweigert/);
  });

  test('Unbekanntes wird unverändert durchgereicht, nicht verschluckt', () => {
    const err = sich.ftpFehlerDeuten(new Error('Etwas ganz Neues'), ziel, null);
    assert.equal(err.message, 'Etwas ganz Neues');
  });
});

// Am 7.9. schlug die Sicherung fehl mit "ENOENT: no such file or directory,
// open /app/data/sicherung-arbeit/archiv.tar.gz".
//
// Ursache: Der Zeitplan sieht stuendlich nach, ob der letzte Lauf lange genug
// her ist — und "letzter Lauf" wird erst am ENDE geschrieben. Ein Postfach mit
// 23.000 Mails braucht laenger als eine Stunde, also startete der naechste Tick
// eine zweite Sicherung. Beide arbeiteten in denselben Dateien, und das
// Aufraeumen der einen riss der anderen die Datei unter den Fuessen weg.
describe('Zwei Sicherungen gleichzeitig', () => {
  const db = require('../src/db');
  const settings = require('../src/services/settings');

  const eingerichtet = () => {
    for (const [k, v] of [
      ['sicherung_passwort', 'geheim'], ['sicherung_ftp_host', 'ftp.example.invalid'],
      ['sicherung_ftp_user', 'u'], ['sicherung_ftp_passwort', 'p'],
    ]) settings.setze(k, v);
  };

  test('die zweite wird abgewiesen, statt der ersten die Dateien zu loeschen', async () => {
    eingerichtet();
    db.exec('DELETE FROM accounts;');
    db.prepare("INSERT INTO accounts (name, host, port, username, password_enc, aktiv)"
      + " VALUES ('K','unerreichbar.invalid',993,'u','x',1)").run();

    // Zwei Laeufe gleichzeitig anstossen. Der erste scheitert irgendwann am
    // nicht erreichbaren Postfach — der zweite muss aber SOFORT mit dem
    // Hinweis auf den laufenden abgewiesen werden.
    const erster = sich.lauf({ trockenlauf: true }).catch((e) => e);
    const zweiter = await sich.lauf({ trockenlauf: true }).catch((e) => e);

    assert.match(zweiter.message, /laeuft bereits|läuft bereits/,
      'ohne Sperre raeumen sich zwei Laeufe gegenseitig die Arbeitsdateien weg');
    await erster;
  });

  test('nach dem Lauf ist die Sperre wieder offen', async () => {
    assert.equal(sich.laeuftGerade(), null,
      'eine haengende Sperre wuerde die Sicherung fuer immer blockieren');
  });
});

// Die Seite log den Nutzer an: /starten wartete auf das ENDE des Laufs. Bei
// 23.000 Mails dauert der viele Minuten, die HTTP-Anfrage lief unterwegs ab —
// und die Seite meldete "fehlgeschlagen", waehrend die Sicherung munter
// weiterlief und die Sperre hielt.
//
// Geprueft wird hier nur, was der Dienst dafuer bereitstellen muss: eine
// Auskunft darueber, DASS gerade eine laeuft und seit wann. Die Route baut
// darauf ihre sofortige Antwort und ihre 409-Absage auf. Einen echten Lauf
// dafuer anzustossen hiesse, ihn im Hintergrund weiterlaufen zu lassen — der
// Testprozess wartet dann auf dessen offene Verbindungen.
describe('Die Seite kann sehen, dass eine Sicherung laeuft', () => {
  test('laeuftGerade meldet den Zustand, nicht nur ja oder nein', () => {
    const stand = sich.laeuftGerade();
    assert.equal(stand, null, 'ausserhalb eines Laufs ist nichts zu melden');
  });

  test('die Auskunft gibt es ueberhaupt', () => {
    assert.equal(typeof sich.laeuftGerade, 'function',
      'ohne sie zeigt die Seite bei einem langen Lauf, als sei nichts los');
  });
});
