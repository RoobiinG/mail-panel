// Was ein Sprachmodell als Ordner vorschlägt, ist Text von einem kleinen Modell —
// kein vertrauenswürdiger Wert. Der Name steht auf einem Knopf, geht in ein
// IMAP-CREATE und wird womöglich zu einer Regel.
//
// Zwei Prüfungen, und beide VERWERFEN:
//   * Name: 2–40 Zeichen, ausschließlich Buchstaben, Ziffern, Leerzeichen, "-", "_".
//   * Konfidenz: unter der eingestellten Schwelle gilt der Vorschlag als
//     „Kein Thema erkannt".
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const {
  ordnerNamePruefen, konfidenzWert, vorschlagPruefen, schluessel, KEIN_THEMA,
} = require('../src/services/kiVorschlag');

const KONTO = { folder_spam: 'Quarantaene', folder_invoices: 'Rechnungen', folder_orders: 'Bestellungen' };
const pruefe = (name, extra = {}) => ordnerNamePruefen(name, { konto: KONTO, ...extra });

// Mehrere Gründe können zutreffen: `{{ $json.von }}` enthält auch einen Punkt, ein
// einzelnes Zeichen ist auch zu kurz. Geprüft wird: abgelehnt ist es immer, und der
// Grund stammt aus dieser Kategorie oder einer, die vorher geprüft wird.
const ERLAUBTE_GRUENDE = {
  pfadtrenner: ['pfadtrenner', 'laenge'],
  steuerzeichen: ['steuerzeichen'],
  zeichen: ['zeichen', 'pfadtrenner', 'laenge'],
  schriften: ['schriften'],
};

// Nichts davon darf je ein Ordnername werden.
const ANGRIFFE = {
  pfadtrenner: [
    '../../etc/passwd', '..', '.', '...', 'a/b', '/a', 'a/', '..\\..\\Windows', 'a\\b', 'Themen/Games',
    'INBOX.Rechnungen', 'a.b', 'Mar. Rechnung',
    'a∕b', 'a⁄b', 'a／b', 'a＼b', 'a⧸b', '．．', 'a．b',
  ],
  steuerzeichen: [
    'Ordner\r\nA001 DELETE INBOX', 'a\nb', 'a\tb', 'a\u0000b', 'a​b', 'a‮b', 'a﻿b',
    'Rechn­ungen',
  ],
  zeichen: [
    '{{ $json.von }}', '${process.env.X}', '=cmd|calc', "x'; DROP TABLE users;--", '<script>x</script>',
    'a"b', "a'b", 'a`b', 'a&b', 'a+b', 'a(b)', 'a:b', 'a*b', 'a?b', 'a%2e%2eb', 'a#b', 'a@b', 'a|b',
    'NEU:Games', '---', '___', '- -', 'ａｂｃ', 'ﬁnanzen', '²³', 'ⅧⅧ',
  ],
  schriften: ['Rеchnungen', 'Рechnungen', 'Αpple', 'Привет Games'],
};

describe('ordnerNamePruefen: was durchgeht', () => {
  test('gewöhnliche Namen bleiben erhalten', () => {
    for (const n of ['Games', 'Reisen', 'Online Banking', 'Haus-Garten', 'Haus_Garten', 'Kunden 2026', 'Äpfel und Öl', 'Straße']) {
      assert.deepEqual(pruefe(n), { ok: true, name: n }, n);
    }
  });

  test('Buchstaben anderer Schriften gehen durch, solange es nur EINE Schrift ist', () => {
    assert.equal(pruefe('Игры').ok, true);
    assert.equal(pruefe('Παιχνίδια').ok, true);
    assert.equal(pruefe('ゲーム').ok, true);
  });

  test('Ränder werden getrimmt, doppelte Leerzeichen zusammengefasst', () => {
    assert.equal(pruefe('  Games  ').name, 'Games');
    assert.equal(pruefe('Online    Banking').name, 'Online Banking');
  });

  test('Umlaute in zerlegter Form werden normalisiert (NFC)', () => {
    assert.equal(pruefe('Äpfel').name, 'Äpfel');
  });
});

describe('ordnerNamePruefen: Länge 2 bis 40', () => {
  test('die Grenzen: 1 Zeichen nein, 2 ja, 40 ja, 41 nein', () => {
    assert.equal(pruefe('a').ok, false);
    assert.equal(pruefe('ab').ok, true);
    assert.equal(pruefe('a'.repeat(40)).ok, true);
    const zu = pruefe('a'.repeat(41));
    assert.equal(zu.ok, false);
    assert.equal(zu.code, 'laenge');
  });

  test('gezählt werden Zeichen, nicht Bytes: 40 Umlaute gehen durch', () => {
    assert.equal(pruefe('ä'.repeat(40)).ok, true);
    assert.equal(pruefe('ä'.repeat(41)).ok, false);
  });

  test('leer und nur Leerzeichen', () => {
    assert.equal(pruefe('').code, 'laenge');
    assert.equal(pruefe('     ').code, 'laenge');
  });
});

describe('ordnerNamePruefen: Angriffe werden VERWORFEN, nicht repariert', () => {
  for (const [code, liste] of Object.entries(ANGRIFFE)) {
    for (const roh of liste) {
      test(`${code}: ${JSON.stringify(roh)}`, () => {
        const r = pruefe(roh);
        assert.equal(r.ok, false, `durchgegangen: ${JSON.stringify(r)}`);
        assert.ok(ERLAUBTE_GRUENDE[code].includes(r.code), `Grund ${r.code} passt nicht zu ${code}`);
        assert.equal(r.grund, KEIN_THEMA, 'nach außen heißt jeder verworfene Vorschlag gleich');
      });
    }
  }

  test('Typen, die kein Text sind', () => {
    for (const roh of [null, undefined, 42, true, {}, [], ['Games'], { toString: () => 'Games' }, Symbol.iterator]) {
      const r = pruefe(roh);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'kein_text');
    }
  });

  // Aus "Ordner\r\nA001 DELETE INBOX" durch Streichen des Umbruchs einen harmlosen
  // Namen zu machen wäre genau die Lücke, die Reparieren aufmachte.
  test('ein Name mit eingeschleustem Befehl wird nicht bereinigt, sondern abgelehnt', () => {
    const r = pruefe('Ordner\r\nA001 DELETE INBOX');
    assert.equal(r.ok, false);
    assert.equal(r.name, undefined);
  });

  test('das Ergebnis eines gültigen Namens enthält nie etwas, das nicht in der Zeichenliste steht', () => {
    for (const liste of Object.values(ANGRIFFE)) {
      for (const roh of liste) {
        const r = pruefe(roh);
        if (r.ok) assert.match(r.name, /^[\p{L}\p{Nd} _-]+$/u, JSON.stringify(roh));
      }
    }
  });
});

describe('ordnerNamePruefen: gesperrte System- und Kategorieordner', () => {
  const GESPERRT = [
    'INBOX', 'inbox', 'Posteingang', 'Papierkorb', 'Gesendet', 'Gesendete Objekte', 'Sent Items', 'Entwürfe',
    'Drafts', 'Trash', 'Spam', 'Junk', 'Junk-E-Mail', 'Gelöschte Objekte', 'Postausgang', 'Vorlagen', 'Notizen',
    // Kategorieordner des Kontos
    'Quarantaene', 'Rechnungen', 'Bestellungen', 'Newsletter', 'Archiv',
  ];
  for (const n of GESPERRT) {
    test(`„${n}"`, () => {
      const r = pruefe(n);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'gesperrt');
    });
  }

  test('auch in anderer Schreibweise: Groß/Klein, Leerzeichen, Bindestrich, Unterstrich', () => {
    for (const n of ['PAPIERKORB', 'Papier korb', 'Papier_korb', 'papier-korb', 'Posteingang ', 'in_box', 'JUNK EMAIL']) {
      assert.equal(pruefe(n).ok, false, n);
    }
  });

  test('der Name kommt vom SERVER: ein Papierkorb „Gelöschte Elemente" ist keine feste Liste', () => {
    assert.equal(pruefe('Gelöschte Elemente').ok, true, 'ohne Wissen über das Postfach ein gewöhnlicher Name');
    const r = pruefe('Gelöschte Elemente', { gesperrt: ['Gelöschte Elemente', 'INBOX.Gesendet'] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'gesperrt');
  });

  test('der eigene Spam-Ordner des Kontos ist gesperrt, auch mit selbst gewähltem Namen', () => {
    const konto = { folder_spam: 'Verdacht', folder_invoices: 'Belege' };
    assert.equal(ordnerNamePruefen('Verdacht', { konto }).ok, false);
    assert.equal(ordnerNamePruefen('Belege', { konto }).ok, false);
  });

  test('ähnliche, aber andere Namen sind frei', () => {
    for (const n of ['Rechnungsarchiv', 'Papier', 'Posteingänge alt', 'Spam-Analyse', 'Neue Rechnungen']) {
      assert.equal(pruefe(n).ok, true, n);
    }
  });
});

describe('konfidenzWert: nur 0 bis 1 ist eine Konfidenz', () => {
  test('gültige Werte', () => {
    assert.equal(konfidenzWert(0), 0);
    assert.equal(konfidenzWert(1), 1);
    assert.equal(konfidenzWert(0.7), 0.7);
    assert.equal(konfidenzWert('0.85'), 0.85);
  });

  test('alles andere ist keine Konfidenz — es wird nicht schöngerechnet', () => {
    for (const roh of [null, undefined, '', ' ', 'hoch', NaN, Infinity, -Infinity, -0.1, 1.01, 85, '85', {}, [], true, [0.9]]) {
      assert.equal(konfidenzWert(roh), null, JSON.stringify(roh));
    }
  });
});

describe('vorschlagPruefen: die Schwelle', () => {
  const opt = { konto: KONTO, schwelle: 0.7, bekannt: ['Einkauf', 'INBOX.Reisen'] };

  test('genau auf der Schwelle gilt (≥), knapp darunter nicht', () => {
    assert.equal(vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.7 }, opt).ok, true);
    const r = vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.69 }, opt);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'konfidenz');
    assert.equal(r.grund, KEIN_THEMA);
    assert.match(r.detail, /0\.69 < 0\.7/);
  });

  test('die Schwelle ist die EINGESTELLTE, nicht eine feste', () => {
    assert.equal(vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.8 }, { ...opt, schwelle: 0.9 }).ok, false);
    assert.equal(vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.8 }, { ...opt, schwelle: 0.5 }).ok, true);
  });

  test('fehlt die Konfidenz oder ist sie unbrauchbar: verworfen', () => {
    for (const k of [undefined, null, '', 'hoch', NaN, 85, -1]) {
      const r = vorschlagPruefen({ ordner: 'Einkauf', konfidenz: k }, opt);
      assert.equal(r.ok, false, JSON.stringify(k));
      assert.equal(r.code, 'ohne_konfidenz');
    }
  });

  test('eine unbrauchbare Schwelle macht streng, nicht offen', () => {
    for (const s of [undefined, null, NaN, 'x']) {
      assert.equal(vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.99 }, { ...opt, schwelle: s }).ok, false, String(s));
    }
  });

  test('ein schlechter Name ist auch bei Konfidenz 1.0 verworfen', () => {
    const r = vorschlagPruefen({ ordner: '../../etc', konfidenz: 1 }, opt);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'pfadtrenner');
  });
});

describe('vorschlagPruefen: vorhandene und neue Ordner', () => {
  const opt = { konto: KONTO, schwelle: 0.7, bekannt: ['Einkauf', 'INBOX.Reisen', 'Archiv/2024'] };

  test('ein vorhandener Ordner gilt mit SEINEM Pfad, nicht mit dem Text des Modells', () => {
    assert.deepEqual(vorschlagPruefen({ ordner: 'einkauf', konfidenz: 0.9 }, opt),
      { ok: true, ordner: 'Einkauf', neu: false, konfidenz: 0.9 });
    // „Reisen" trifft „INBOX.Reisen": zurück geht der volle Pfad des Servers.
    assert.equal(vorschlagPruefen({ ordner: 'Reisen', konfidenz: 0.9 }, opt).ordner, 'INBOX.Reisen');
    assert.equal(vorschlagPruefen({ ordner: 'REISEN', konfidenz: 0.9 }, opt).neu, false);
  });

  test('ein Ordner, der als Pfad Trennzeichen trägt, ist über sein Endstück erreichbar — der Text selbst darf keines haben', () => {
    assert.equal(vorschlagPruefen({ ordner: '2024', konfidenz: 0.9 }, opt).ordner, 'Archiv/2024');
    assert.equal(vorschlagPruefen({ ordner: 'Archiv/2024', konfidenz: 0.9 }, opt).code, 'pfadtrenner');
  });

  test('ein unbekannter Name ist ein NEUER Ordner, mit dem Namen aus der Prüfung', () => {
    assert.deepEqual(vorschlagPruefen({ ordner: '  Kunden   2026 ', konfidenz: 0.8 }, opt),
      { ok: true, ordner: 'Kunden 2026', neu: true, konfidenz: 0.8 });
  });

  test('sind neue Ordner abgeschaltet, wird ein neuer Name verworfen — ein vorhandener nicht', () => {
    const aus = { ...opt, neueErlaubt: false };
    assert.equal(vorschlagPruefen({ ordner: 'Kunden 2026', konfidenz: 0.9 }, aus).code, 'neue_ordner_aus');
    assert.equal(vorschlagPruefen({ ordner: 'Einkauf', konfidenz: 0.9 }, aus).ok, true);
  });

  test('ein Name, der einem gesperrten Ordner gleicht, trifft nie einen „bekannten"', () => {
    // Selbst wenn jemand „Papierkorb" in die Liste der bekannten Ordner schmuggelte.
    const r = vorschlagPruefen({ ordner: 'Papierkorb', konfidenz: 1 }, { ...opt, bekannt: ['Papierkorb'] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'gesperrt');
  });
});

describe('schluessel', () => {
  test('vergleicht ohne Groß/Klein, Leerzeichen, Bindestrich und Unterstrich', () => {
    assert.equal(schluessel('Papier_Korb'), schluessel('papier korb'));
    assert.equal(schluessel('Junk-E-Mail'), 'junkemail');
    assert.equal(schluessel(null), '');
  });
});
