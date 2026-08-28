#!/usr/bin/env node
// Eine Postfach-Sicherung des Mail-Panels wieder auspacken.
//
//   node wiederherstellen.js postfaecher-2026-08-28.mpsich [Zielordner]
//
// Das Passwort wird abgefragt, damit es nicht in der Kommandozeile und damit
// in der Shell-Geschichte landet. Alternativ per Umgebungsvariable:
//   MPSICH_PASSWORT=... node wiederherstellen.js datei.mpsich
//
// Dieses Skript ist bewusst allein lauffähig: Es braucht nur Node, kein Panel,
// keine Datenbank, keine Pakete aus node_modules. Eine Sicherung, die sich nur
// mit der Software öffnen lässt, die gerade ausgefallen ist, wäre wertlos.
// Deshalb hier auch die Formatbeschreibung, falls einmal gar nichts mehr da ist:
//
//   Datei:  "MPSICH1\n" | Salz (16 Byte) | IV (12 Byte) | Geheimtext | Siegel (16 Byte)
//   Chiffre: AES-256-GCM
//   Schlüssel: scrypt(Passwort, Salz, 32 Byte, N=16384, r=8, p=1)
//   Klartext darunter: gzip-gepacktes tar mit je einer mbox-Datei pro Ordner
//
// Mit diesen Angaben kommt man notfalls auch mit openssl und einem kurzen
// Skript an die Daten.

'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const KOPF = Buffer.from('MPSICH1\n', 'utf8');

function passwortFragen() {
  if (process.env.MPSICH_PASSWORT) return Promise.resolve(process.env.MPSICH_PASSWORT);
  return new Promise((fertig) => {
    const schnittstelle = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Eingabe nicht mitschreiben, damit niemand über die Schulter mitliest.
    const ausgabe = schnittstelle.output;
    schnittstelle._writeToOutput = (text) => {
      if (/Passwort/.test(text)) ausgabe.write(text);
    };
    schnittstelle.question('Archiv-Passwort: ', (antwort) => {
      schnittstelle.close();
      process.stdout.write('\n');
      fertig(antwort);
    });
  });
}

async function entschluesseln(quelle, ziel, passwort) {
  const gesamt = (await fsp.stat(quelle)).size;
  const vorspann = KOPF.length + 16 + 12;
  if (gesamt < vorspann + 16) throw new Error('Die Datei ist zu klein, um eine Sicherung zu sein.');

  const griff = await fsp.open(quelle, 'r');
  try {
    const kopf = Buffer.alloc(vorspann);
    await griff.read(kopf, 0, vorspann, 0);
    if (!kopf.subarray(0, KOPF.length).equals(KOPF)) {
      throw new Error('Kennung fehlt — das ist keine Mail-Panel-Sicherung.');
    }
    const salz = kopf.subarray(KOPF.length, KOPF.length + 16);
    const iv = kopf.subarray(KOPF.length + 16, vorspann);
    const siegel = Buffer.alloc(16);
    await griff.read(siegel, 0, 16, gesamt - 16);

    const schluessel = crypto.scryptSync(Buffer.from(passwort, 'utf8'), salz, 32, { N: 16384, r: 8, p: 1 });
    const dechiffre = crypto.createDecipheriv('aes-256-gcm', schluessel, iv);
    dechiffre.setAuthTag(siegel);
    await pipeline(
      fs.createReadStream(quelle, { start: vorspann, end: gesamt - 17 }),
      dechiffre,
      zlib.createGunzip(),
      fs.createWriteStream(ziel),
    );
  } finally {
    await griff.close();
  }
}

// Minimaler tar-Leser: 512-Byte-Kopf, Inhalt, aufgefüllt auf 512.
async function tarAuspacken(tarDatei, zielOrdner) {
  const daten = await fsp.readFile(tarDatei);
  const dateien = [];
  let pos = 0;
  while (pos + 512 <= daten.length) {
    const kopf = daten.subarray(pos, pos + 512);
    if (kopf.every((b) => b === 0)) break;             // Endblock
    const name = kopf.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const groesse = parseInt(kopf.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    pos += 512;
    const inhalt = daten.subarray(pos, pos + groesse);
    pos += groesse + (groesse % 512 ? 512 - (groesse % 512) : 0);

    // Keine Pfadwechsel zulassen — ein Archiv aus fremder Hand darf nicht
    // ausserhalb des Zielordners schreiben.
    const ziel = path.resolve(zielOrdner, name);
    if (!ziel.startsWith(path.resolve(zielOrdner) + path.sep)) {
      throw new Error(`Verdächtiger Pfad im Archiv: ${name}`);
    }
    await fsp.mkdir(path.dirname(ziel), { recursive: true });
    await fsp.writeFile(ziel, inhalt);
    dateien.push({ name, groesse, mails: (inhalt.toString('binary').match(/^From /gm) || []).length });
  }
  return dateien;
}

(async () => {
  const [datei, zielRoh] = process.argv.slice(2);
  if (!datei) {
    console.error('Aufruf: node wiederherstellen.js <datei.mpsich> [Zielordner]');
    process.exit(2);
  }
  const ziel = path.resolve(zielRoh || datei.replace(/\.mpsich$/, '') + '-entpackt');
  const passwort = await passwortFragen();
  if (!passwort) { console.error('Ohne Passwort geht es nicht.'); process.exit(2); }

  const zwischen = path.join(require('os').tmpdir(), `mpsich-${process.pid}.tar`);
  try {
    process.stdout.write('Entschlüsseln … ');
    await entschluesseln(path.resolve(datei), zwischen, passwort);
    console.log('ok');

    await fsp.mkdir(ziel, { recursive: true });
    const dateien = await tarAuspacken(zwischen, ziel);

    let mails = 0;
    console.log(`\nAusgepackt nach ${ziel}:\n`);
    for (const d of dateien) {
      mails += d.mails;
      console.log(`  ${d.name.padEnd(48)} ${String(d.mails).padStart(5)} Mails  ${(d.groesse / 1024).toFixed(0)} KB`);
    }
    console.log(`\n  ${dateien.length} Ordner, ${mails} Mails insgesamt.`);
    console.log('\nDie .mbox-Dateien lassen sich in Thunderbird über "ImportExportTools NG"');
    console.log('einlesen, oder mit jedem Programm, das mbox versteht.');
  } catch (err) {
    // Ein falsches Passwort fällt beim Prüfsiegel auf, nicht vorher.
    const hinweis = /auth|unable to authenticate/i.test(err.message)
      ? 'Falsches Passwort — oder die Datei wurde verändert.'
      : err.message;
    console.error(`\nFehlgeschlagen: ${hinweis}`);
    process.exit(1);
  } finally {
    await fsp.rm(zwischen, { force: true }).catch(() => {});
  }
})();
