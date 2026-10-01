// Path-Traversal: Was aus einem Betreff, Absender, Firmennamen oder Aktenzeichen
// in einen Nextcloud-Pfad gelangt, ist nicht vertrauenswürdig.
//
// Der Fehler, den diese Datei festhält: Workflow 07 setzte Platzhalter wie
// {{betreff}} ungefiltert in den Pfad ein. Ein Betreff "../../" machte daraus einen
// Pfad, den `fetch` beim Bilden der Adresse stillschweigend nach oben auflöste.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const {
  segmentSaeubern, dateiSaeubern, pfadSaeubern, vorlageSaeubern, ebenen, quelltextFuerKnoten,
} = require('../src/services/pfadSicherheit');

// Nichts davon darf je ein Pfadbestandteil werden, der nach oben führt.
const ANGRIFFE = [
  '..', '.', '...', ' .. ', '. .', '../', '..\\', '../../etc/passwd', '..\\..\\windows',
  'a/../b', 'a/..', '/etc/passwd', '\\\\server\\share',
  '%2e%2e', '%2e%2e%2f', '..%2f', '%2e%2e%5c', '%252e%252e',
  '‥', '．．', '․․',               // Punktfolgen, die NFKC zu ".." macht
  '∕', '..∕', '⁄..⁄', '／..／', '..＼',  // Trenner-Doppelgänger
  'a\u0000b', '..\u0000/', 'ok​/​..',          // NUL, Zero-Width
  '‮', 'abc‮fdp.exe', '⁦..⁩',        // Bidi-Steuerzeichen
  'CON', 'nul.txt', 'COM1', 'lpt9.pdf',                   // Windows-Gerätenamen
  '', null, undefined, '   ', '\t\n', '<script>alert(1)</script>', '${process.env.X}',
  '{{ $json.von }}', "'; DROP TABLE users;--", 'a'.repeat(5000),
];

describe('segmentSaeubern: ein Ordnername aus fremden Daten', () => {
  for (const roh of ANGRIFFE) {
    test(`harmlos: ${JSON.stringify(String(roh).slice(0, 30))}`, () => {
      const s = segmentSaeubern(roh);
      assert.ok(s.length > 0, 'nie leer');
      assert.ok(s.length <= 60, 'nie länger als erlaubt');
      assert.notEqual(s, '.');
      assert.notEqual(s, '..');
      assert.ok(!/[\\/]/.test(s), `kein Trenner: ${s}`);
      assert.ok(!/^[ .]/.test(s) && !/[ .]$/.test(s), `keine Punkte/Leerzeichen am Rand: "${s}"`);
      assert.ok(!/[\p{Cc}\p{Cf}]/u.test(s), 'keine Steuer- oder Bidi-Zeichen');
      assert.ok(!/%/.test(s), 'kein Prozentzeichen — nichts wird nachträglich dekodiert');
      assert.ok(!/[<>"'`$;{}\[\]|*?:!@#^=~]/.test(s), `nur erlaubte Zeichen: ${s}`);
    });
  }

  test('gewöhnliche Namen bleiben erhalten', () => {
    assert.equal(segmentSaeubern('Amazon'), 'Amazon');
    assert.equal(segmentSaeubern('Müller & Söhne GmbH'), 'Müller & Söhne GmbH');
    assert.equal(segmentSaeubern('RE-2026-0017'), 'RE-2026-0017');
    assert.equal(segmentSaeubern('Rechnung (2)'), 'Rechnung (2)');
    assert.equal(segmentSaeubern('株式会社テスト'), '株式会社テスト');
  });

  test('ein Schrägstrich macht keinen neuen Ordner auf', () => {
    assert.equal(segmentSaeubern('AZ 12/2026'), 'AZ 12-2026');
    assert.equal(segmentSaeubern('a\\b'), 'a-b');
  });

  test('".." und Verwandte werden zu "unbekannt"', () => {
    for (const w of ['..', '.', ' .. ', '...', '．．', '‥']) {
      assert.equal(segmentSaeubern(w), 'unbekannt', JSON.stringify(w));
    }
  });

  test('Windows-Gerätenamen bekommen einen Vorsatz', () => {
    assert.equal(segmentSaeubern('CON'), '_CON');
    assert.equal(segmentSaeubern('nul.txt'), '_nul.txt');
    assert.equal(segmentSaeubern('Konto'), 'Konto', 'nur die echten Namen');
  });

  test('die Länge ist gedeckelt, auch mit Zeichen außerhalb der Grundebene', () => {
    assert.equal(Array.from(segmentSaeubern('x'.repeat(500))).length, 60);
    assert.ok(Array.from(segmentSaeubern('\u{20BB7}'.repeat(200))).length <= 60);
    assert.equal(segmentSaeubern('abcdef', 3), 'abc');
  });

  // Das Ergebnis geht später noch einmal durch die Säuberung (Panel nach n8n, n8n
  // nach Panel). Es darf sich dabei nicht ändern, sonst driftet der Pfad.
  test('Säubern ist stabil: ein zweites Mal ändert nichts', () => {
    for (const roh of ANGRIFFE) {
      const einmal = segmentSaeubern(roh);
      assert.equal(segmentSaeubern(einmal), einmal, JSON.stringify(String(roh).slice(0, 30)));
    }
    for (const roh of ['é', 'e$́', 'Å', 'Ａ１', 'ﬁle', 'x‍́']) {
      const einmal = segmentSaeubern(roh);
      assert.equal(segmentSaeubern(einmal), einmal, JSON.stringify(roh));
    }
  });
});

describe('dateiSaeubern: ein Dateiname', () => {
  test('gewöhnliche Namen bleiben, auch mit Sonderzeichen', () => {
    assert.equal(dateiSaeubern('Rechnung.pdf'), 'Rechnung.pdf');
    assert.equal(dateiSaeubern('Rechnung #5 [final].pdf'), 'Rechnung #5 [final].pdf');
    assert.equal(dateiSaeubern('Rechnung – März.pdf'), 'Rechnung – März.pdf');
    assert.equal(dateiSaeubern('Rechnung (2).pdf'), 'Rechnung (2).pdf');
  });

  test('Pfadanteile werden zu Leerzeichen, nicht zu Ordnern', () => {
    // Ohne Trenner ist das ein einziger, wenn auch hässlicher Name — kein Weg nach oben.
    const s = dateiSaeubern('../../../etc/passwd');
    assert.ok(!/[\\/]/.test(s), s);
    assert.notEqual(s, '..');
  });

  test('".." und "." allein sind keine Dateinamen', () => {
    // Das war die Lücke: sauberDatei('..') gab '..' zurück, und der Upload ging an
    // "<Ordner>/..".
    for (const w of ['..', '.', '...', ' .. ', '‥', '/..', '\\..\\']) {
      assert.equal(dateiSaeubern(w), 'beleg', JSON.stringify(w));
    }
  });

  test('NUL, Zero-Width und Bidi fliegen raus', () => {
    assert.equal(dateiSaeubern('a\u0000b​c‮d.pdf'), 'abcd.pdf');
  });

  test('nie leer, nie länger als 120', () => {
    assert.equal(dateiSaeubern(''), 'beleg');
    assert.equal(dateiSaeubern(null), 'beleg');
    assert.ok(Array.from(dateiSaeubern('x'.repeat(999))).length <= 120);
  });
});

describe('pfadSaeubern: ein fertiger Pfad', () => {
  test('unveränderte Pfade bleiben, wie sie sind', () => {
    assert.equal(pfadSaeubern('Belege/2026/Amazon'), 'Belege/2026/Amazon');
    assert.equal(pfadSaeubern('Belege/Müller & Söhne/RE-17'), 'Belege/Müller & Söhne/RE-17');
  });

  test('Sprünge nach oben fallen weg', () => {
    assert.equal(pfadSaeubern('../../etc/Belege'), 'etc/Belege');
    assert.equal(pfadSaeubern('Belege/../../x'), 'Belege/x');
    assert.equal(pfadSaeubern('..\\..\\Belege'), 'Belege');
    assert.equal(pfadSaeubern('/Belege//2026/'), 'Belege/2026');
  });

  test('Trenner-Doppelgänger zählen als Trenner', () => {
    assert.equal(pfadSaeubern('Belege∕..∕x'), 'Belege/x');
    assert.equal(pfadSaeubern('Belege／．．／x'), 'Belege/x');
  });

  test('kein Segment ist ".." oder enthält Steuerzeichen', () => {
    for (const roh of ANGRIFFE) {
      const p = pfadSaeubern(roh);
      for (const teil of p.split('/').filter(Boolean)) {
        assert.notEqual(teil, '..');
        assert.notEqual(teil, '.');
        assert.ok(!/[\p{Cc}\p{Cf}]/u.test(teil));
      }
    }
  });

  test('höchstens zehn Ebenen', () => {
    assert.equal(pfadSaeubern(Array.from({ length: 40 }, (_, i) => `d${i}`).join('/')).split('/').length, 10);
  });

  test('leer bleibt leer', () => {
    assert.equal(pfadSaeubern(''), '');
    assert.equal(pfadSaeubern('../..'), '');
    assert.equal(pfadSaeubern(null), '');
  });
});

describe('vorlageSaeubern: eine Vorlage mit Platzhaltern', () => {
  test('Platzhalter bleiben stehen', () => {
    assert.equal(vorlageSaeubern('Belege/{{firma}}/{{aktenzeichen}}'), 'Belege/{{firma}}/{{aktenzeichen}}');
    assert.equal(vorlageSaeubern('{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}'), '{{beleg_t1}}/{{beleg_t2}}/{{beleg_t3}}');
    assert.equal(vorlageSaeubern('Belege/{{jahr}}-{{monat}}'), 'Belege/{{jahr}}-{{monat}}');
  });

  test('Sprünge nach oben im Literaltext fallen weg', () => {
    assert.equal(vorlageSaeubern('../../etc/{{firma}}'), 'etc/{{firma}}');
    assert.equal(vorlageSaeubern('Belege/../{{firma}}'), 'Belege/{{firma}}');
  });

  test('der Punkt vor einer Endung hinter einem Platzhalter bleibt', () => {
    assert.equal(vorlageSaeubern('{{firma}}.alt'), '{{firma}}.alt');
  });

  test('Code-Einschübe verlieren ihre Klammern', () => {
    const s = vorlageSaeubern('Belege/${process.env.PANEL_SECRET}');
    assert.ok(!s.includes('${') && !s.includes('{'), s);
  });

  test('Literal und Platzhalter in einem Segment', () => {
    assert.equal(vorlageSaeubern('Beleg {{firma}} (neu)'), 'Beleg {{firma}} (neu)');
  });

  test('ein rein literales ".." wird entfernt, auch zwischen Platzhaltern', () => {
    assert.equal(vorlageSaeubern('{{firma}}/../{{datum}}'), '{{firma}}/{{datum}}');
  });
});

describe('ebenen', () => {
  test('zählt die Ordnerebenen', () => {
    assert.equal(ebenen('Belege/2026/Amazon'), 3);
    assert.equal(ebenen('Belege'), 1);
    assert.equal(ebenen(''), 0);
  });
});

// Der Beleg-Knoten in n8n führt denselben Quelltext aus. Weicht er ab, säubert n8n
// anders als das Panel — und genau dort sitzt der Angriffsweg.
describe('Der in n8n eingebettete Quelltext verhält sich wie das Original', () => {
  const imKnoten = new Function(
    `${quelltextFuerKnoten(segmentSaeubern, '__s')}\n${quelltextFuerKnoten(dateiSaeubern, '__d')}\nreturn { s: __s, d: __d };`,
  )();

  test('segmentSaeubern: gleiche Ergebnisse für den ganzen Angriffskorpus', () => {
    for (const roh of ANGRIFFE) {
      assert.equal(imKnoten.s(roh), segmentSaeubern(roh), JSON.stringify(String(roh).slice(0, 30)));
    }
  });

  test('dateiSaeubern: gleiche Ergebnisse für den ganzen Angriffskorpus', () => {
    for (const roh of ANGRIFFE) {
      assert.equal(imKnoten.d(roh), dateiSaeubern(roh), JSON.stringify(String(roh).slice(0, 30)));
    }
  });

  test('der Quelltext ist in sich geschlossen (keine Verweise nach außen)', () => {
    const quelle = quelltextFuerKnoten(segmentSaeubern, '__s') + quelltextFuerKnoten(dateiSaeubern, '__d');
    assert.doesNotMatch(quelle, /\bMAX_EBENEN\b|\bTRENNER\b|\bPLATZHALTER\b|require\(/);
  });
});
