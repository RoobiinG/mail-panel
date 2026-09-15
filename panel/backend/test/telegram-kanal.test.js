// Warum keine Telegram-Nachricht ankommt — und warum man das bisher nicht sah.
//
// Am 14.09. lief Workflow 02 um 7:30 durch, 43 Sekunden, Status „success". Eine
// Nachricht kam trotzdem nicht an. Der Grund ist eine Eigenart von n8n: Ein
// stillgelegter Knoten wird übersprungen, ohne einen Fehler zu erzeugen. Der
// Lauf ist grün, weil nichts schiefging — es passierte nur nichts.
//
// Das Panel konnte dazu nichts sagen: Es verschickt die Nachricht nicht selbst,
// und der Diagnose-Bericht zeigte Telegram-Knoten gar nicht erst an. Genau
// deshalb gibt es services/telegram.js: einen Weg, der eine echte Nachricht
// verschickt und sagt, woran es liegt, wenn sie nicht ankommt.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
require('./umgebung');

const db = require('../src/db');
const settings = require('../src/services/settings');
const telegram = require('../src/services/telegram');

const TOKEN = '123456:GEHEIM-ABC-XYZ';

// Eine Telegram-Antwort nachstellen. Telegram schickt Fehler als HTTP-Fehler
// MIT JSON-Rumpf ({ok:false, description:"…"}), nicht als leere 400.
const antwortet = (status, rumpf) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => rumpf,
});

let echtesFetch;
let gerufen;

beforeEach(() => {
  echtesFetch = global.fetch;
  gerufen = [];
  db.exec("DELETE FROM settings WHERE key LIKE 'telegram%'");
  settings.setze('telegram_token', TOKEN);
  settings.setze('telegram_chat_id', '987654321');
});

afterEach(() => { global.fetch = echtesFetch; });

describe('Der Platzhalter aus der Workflow-Vorlage', () => {
  // In den Vorlagen steht chatId: "DEINE_CHAT_ID". Wer keine Chat-ID einträgt,
  // behält ihn — und Telegram antwortet auf jede Nachricht mit „chat not found".
  test('wird als „nie eingetragen" erkannt', () => {
    assert.equal(telegram.istPlatzhalter('DEINE_CHAT_ID'), true);
    assert.equal(telegram.istPlatzhalter(''), true);
    assert.equal(telegram.istPlatzhalter(undefined), true);
    assert.equal(telegram.istPlatzhalter('  '), true);
  });

  test('eine echte Chat-ID nicht', () => {
    assert.equal(telegram.istPlatzhalter('987654321'), false);
    assert.equal(telegram.istPlatzhalter('-1001234567890'), false, 'Gruppen-IDs sind negativ');
  });
});

describe('Die drei Fehler, die alle gleich aussehen', () => {
  test('falscher Token: 401 wird zu einem Satz über den Token', async () => {
    global.fetch = antwortet(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    await assert.rejects(() => telegram.testVerbindung(), (err) => {
      assert.match(err.message, /Bot-Token/);
      return true;
    });
  });

  test('falsche Chat-ID: der Weg zur eigenen ID steht in der Meldung', async () => {
    global.fetch = async (url) => {
      if (String(url).endsWith('/getMe')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'bot' } }) };
      }
      return {
        ok: false, status: 400,
        json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      };
    };
    await assert.rejects(() => telegram.testVerbindung(), (err) => {
      assert.match(err.message, /Chat-ID/);
      assert.match(err.message, /getUpdates/, 'sonst weiss niemand, wo er sie herbekommt');
      return true;
    });
  });

  // Der häufigste Fall, und der einzige, der nichts mit den Einstellungen zu
  // tun hat: Ein Bot darf niemanden von sich aus anschreiben.
  test('nie „Start" gedrückt: die Meldung sagt, was zu tun ist', async () => {
    global.fetch = async (url) => {
      if (String(url).endsWith('/getMe')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'bot' } }) };
      }
      return {
        ok: false, status: 403,
        json: async () => ({
          ok: false, error_code: 403,
          description: "Forbidden: bot can't initiate conversation with a user",
        }),
      };
    };
    await assert.rejects(() => telegram.testVerbindung(), (err) => {
      assert.match(err.message, /Start/);
      return true;
    });
  });
});

describe('Was fehlt, wird vor dem ersten Aufruf gesagt', () => {
  test('ohne Token wird gar nicht erst gefragt', async () => {
    db.exec("DELETE FROM settings WHERE key = 'telegram_token'");
    global.fetch = async () => { throw new Error('hätte nicht aufgerufen werden dürfen'); };
    await assert.rejects(() => telegram.testVerbindung(), /Bot-Token/);
  });

  test('ohne Chat-ID ebenso', async () => {
    db.exec("DELETE FROM settings WHERE key = 'telegram_chat_id'");
    global.fetch = async () => { throw new Error('hätte nicht aufgerufen werden dürfen'); };
    await assert.rejects(() => telegram.testVerbindung(), /Chat-ID/);
  });
});

describe('Der Token gehört in keine Meldung', () => {
  // Telegram schreibt den Token in die Adresse — das ist deren API-Entwurf, und
  // damit steckt er in allem, was fetch über die Anfrage sagt. Eine Meldung,
  // die err.message durchreicht, schreibt ihn in die Oberfläche und ins
  // Protokoll. Deshalb ist hier jede Meldung von Hand formuliert.
  test('auch nicht, wenn fetch selbst scheitert', async () => {
    global.fetch = async (url) => { throw new Error(`connect ECONNREFUSED bei ${url}`); };
    await assert.rejects(() => telegram.testVerbindung(), (err) => {
      assert.ok(!err.message.includes('GEHEIM'), `Token in der Meldung: ${err.message}`);
      return true;
    });
  });

  // Der Auffangfall reicht Telegrams eigenen Text durch. Käme der Token darin
  // vor, stünde er in der Oberfläche und im Protokoll.
  test('und nicht im durchgereichten Text einer unbekannten Fehlermeldung', async () => {
    global.fetch = antwortet(400, {
      ok: false, error_code: 400, description: `Bad Request: irgendwas mit ${TOKEN}`,
    });
    await assert.rejects(() => telegram.testVerbindung(), (err) => {
      assert.ok(!err.message.includes('GEHEIM'), `Token in der Meldung: ${err.message}`);
      assert.match(err.message, /Telegram meldet/, 'der Rest der Meldung bleibt lesbar');
      return true;
    });
  });
});

describe('Der glückliche Fall', () => {
  test('eine echte Nachricht geht hinaus, an die hinterlegte Chat-ID', async () => {
    global.fetch = async (url, opt) => {
      gerufen.push({ url: String(url), rumpf: JSON.parse(opt.body) });
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { username: 'mein_bot', first_name: 'Bot' } }),
      };
    };

    const r = await telegram.testVerbindung();
    assert.equal(r.ok, true);
    assert.match(r.hinweis, /mein_bot/);

    assert.equal(gerufen.length, 2, 'erst getMe, dann sendMessage');
    assert.match(gerufen[0].url, /\/getMe$/);
    assert.match(gerufen[1].url, /\/sendMessage$/);
    assert.equal(gerufen[1].rumpf.chat_id, '987654321');
    assert.match(gerufen[1].rumpf.text, /Mail-Panel/);
  });

  test('sendeNachricht kürzt auf das, was Telegram annimmt', async () => {
    global.fetch = async (url, opt) => {
      gerufen.push(JSON.parse(opt.body));
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    await telegram.sendeNachricht('x'.repeat(9000));
    assert.ok(gerufen[0].text.length <= 4000, 'Telegram lehnt ab 4096 Zeichen ab');
  });
});

// Der Rückkanal: Wer den Bot anschreibt, landet im selben Trigger wie der
// Besitzer. Ohne Absenderprüfung genügt die Knopf-Kennung, um eine Aktion im
// Panel auszulösen — die Kennung steht als fester Text in der Vorlage.
describe('Die Absenderprüfung im Telegram-Rückkanal', () => {
  const patcher = require('../src/services/workflowPatcher');

  const knotenMitPruefung = () => ({
    name: 'Aktion und Absender prüfen',
    parameters: {
      conditions: {
        string: [
          { value1: '={{ $json.message.data }}', value2: 'q_deliver_all' },
          { value1: '={{ $json.message.message.chat.id }}', value2: 'DEINE_CHAT_ID' },
        ],
      },
    },
  });

  test('die hinterlegte Chat-ID ersetzt den Platzhalter', () => {
    const knoten = knotenMitPruefung();
    assert.equal(patcher.absenderpruefungFuellen(knoten, '987654321'), true);
    assert.equal(knoten.parameters.conditions.string[1].value2, '987654321');
    assert.equal(knoten.parameters.conditions.string[0].value2, 'q_deliver_all',
      'die Knopf-Kennung bleibt unangetastet');
  });

  test('ohne Chat-ID bleibt der Platzhalter stehen — die Bedingung trifft dann nie zu', () => {
    const knoten = knotenMitPruefung();
    assert.equal(patcher.absenderpruefungFuellen(knoten, ''), false);
    assert.equal(knoten.parameters.conditions.string[1].value2, 'DEINE_CHAT_ID');
    assert.equal(patcher.bedingungBrauchtChatId(knoten), true, 'und das Panel sagt es');
  });

  test('ein bereits gefüllter Wert wird nicht überschrieben', () => {
    const knoten = knotenMitPruefung();
    knoten.parameters.conditions.string[1].value2 = '111';
    assert.equal(patcher.absenderpruefungFuellen(knoten, '987654321'), false);
    assert.equal(knoten.parameters.conditions.string[1].value2, '111');
  });

  test('Knoten ohne solche Bedingung bleiben unberührt', () => {
    const knoten = { name: 'Irgendwas', parameters: { url: 'http://panel:3002/x' } };
    assert.equal(patcher.absenderpruefungFuellen(knoten, '987654321'), false);
    assert.equal(patcher.bedingungBrauchtChatId(knoten), false);
  });
});
