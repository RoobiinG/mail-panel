// „✅ Alle freigeben" unter dem täglichen Digest — drei Fehler hintereinander.
//
//   1. Workflow 02: Die Knopf-Felder waren PowerShell-verstümmelt
//      ("@{callbackData=q_deliver_all}") und standen in additionalFields, wo
//      n8n sie nicht liest — die Nachricht ging ohne Knöpfe hinaus.
//   2. Workflow 05: Die Weiche war ein Switch v1 mit IF-Parametern und las
//      `message.data` statt `callback_query.data`.
//   3. Der Endpunkt /api/internal/quarantaene/deliver-all fehlte (404).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('./umgebung');

process.env.PANEL_SECRET = 'test-geheim-rueckkanal';
const express = require('express');
const settings = require('../src/services/settings');
const mailcow = require('../src/services/mailcow');
const patcher = require('../src/services/workflowPatcher');

const VORLAGEN = path.resolve(__dirname, '../../../workflows');
const vorlage = (name) => JSON.parse(fs.readFileSync(path.join(VORLAGEN, name), 'utf8').replace(/^﻿/, ''));

describe('Die Vorlagen', () => {
  test('keine PowerShell-Reste mehr', () => {
    for (const datei of fs.readdirSync(VORLAGEN).filter((d) => d.endsWith('.json'))) {
      assert.ok(!fs.readFileSync(path.join(VORLAGEN, datei), 'utf8').includes('"@{'), `${datei} enthält "@{…}"`);
    }
  });

  for (const datei of ['02-daily-digest-ollama.json', '02-daily-digest-gemini.json']) {
    test(`${datei}: die Knöpfe stehen dort, wo n8n sie liest`, () => {
      const knoten = vorlage(datei).nodes.find((k) => k.type === 'n8n-nodes-base.telegram');
      assert.equal(knoten.parameters.replyMarkup, 'inlineKeyboard');
      const knoepfe = knoten.parameters.inlineKeyboard.rows[0].row.buttons;
      const freigeben = knoepfe.find((k) => /freigeben/.test(k.text));
      assert.deepEqual(freigeben.additionalFields, { callback_data: 'q_deliver_all' });
      assert.equal(knoten.parameters.additionalFields.replyMarkup, undefined);
    });
  }

  test('05: die Weiche ist ein IF-Knoten auf callback_query', () => {
    const wf = vorlage('05-telegram-callback.json');
    const weiche = wf.nodes.find((k) => k.name === 'Aktion und Absender prüfen');
    assert.equal(weiche.type, 'n8n-nodes-base.if');
    const [aktion, absender] = weiche.parameters.conditions.string;
    assert.match(aktion.value1, /callback_query\.data/);
    assert.equal(aktion.value2, 'q_deliver_all');
    assert.match(absender.value1, /callback_query\.message\.chat\.id/);
    assert.equal(patcher.bedingungBrauchtChatId(weiche), true, 'die Absenderprüfung füllt das Panel weiter');
    const aufruf = wf.nodes.find((k) => k.type === 'n8n-nodes-base.httpRequest');
    assert.equal(aufruf.parameters.url, patcher.RUECKKANAL_URL);
  });
});

describe('Bestehende Workflows werden beim Abgleich repariert', () => {
  test('verstümmelte Knöpfe in additionalFields', () => {
    const wf = {
      nodes: [{
        type: 'n8n-nodes-base.telegram',
        name: 'Telegram senden',
        parameters: {
          chatId: '1',
          text: 'x',
          additionalFields: {
            replyMarkup: 'inlineKeyboard',
            inlineKeyboard: {
              rows: [{
                row: {
                  buttons: [
                    { text: '📬 Panel öffnen', additionalFields: '@{url=https://dein-panel-url/}' },
                    { text: '✅ Alle freigeben', additionalFields: '@{callbackData=q_deliver_all}' },
                  ],
                },
              }],
            },
          },
        },
      }],
    };
    const alt = process.env.ALLOWED_ORIGIN;
    delete process.env.ALLOWED_ORIGIN;
    try {
      assert.equal(patcher.telegramKnoepfeReparieren(wf), true);
    } finally {
      if (alt !== undefined) process.env.ALLOWED_ORIGIN = alt;
    }
    const p = wf.nodes[0].parameters;
    assert.equal(p.replyMarkup, 'inlineKeyboard');
    assert.deepEqual(p.additionalFields, {});
    const knoepfe = p.inlineKeyboard.rows[0].row.buttons;
    assert.equal(knoepfe.length, 1, 'ohne ALLOWED_ORIGIN kein Link auf einen Platzhalter');
    assert.deepEqual(knoepfe[0].additionalFields, { callback_data: 'q_deliver_all' });
    assert.equal(patcher.telegramKnoepfeReparieren(wf), false, 'ein zweiter Abgleich ändert nichts');
  });

  test('mit ALLOWED_ORIGIN zeigt „Panel öffnen" auf das Panel', () => {
    const wf = {
      nodes: [{
        type: 'n8n-nodes-base.telegram',
        parameters: {
          replyMarkup: 'inlineKeyboard',
          inlineKeyboard: { rows: [{ row: { buttons: [{ text: 'Panel', additionalFields: { url: 'https://dein-panel-url/' } }] } }] },
        },
      }],
    };
    const alt = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = 'https://panel.beispiel.de';
    try {
      patcher.telegramKnoepfeReparieren(wf);
    } finally {
      if (alt === undefined) delete process.env.ALLOWED_ORIGIN; else process.env.ALLOWED_ORIGIN = alt;
    }
    assert.equal(wf.nodes[0].parameters.inlineKeyboard.rows[0].row.buttons[0].additionalFields.url, 'https://panel.beispiel.de/');
  });

  test('die alte Weiche und der tote Aufruf', () => {
    const wf = {
      nodes: [
        { type: 'n8n-nodes-base.telegramTrigger', name: 'Telegram Trigger', parameters: {} },
        {
          type: 'n8n-nodes-base.switch',
          typeVersion: 1,
          name: 'Aktion und Absender prüfen',
          parameters: {
            conditions: {
              string: [
                { value1: '={{ $json.message.data }}', value2: 'q_deliver_all' },
                { value1: '={{ $json.message.message.chat.id }}', value2: '987654321' },
              ],
            },
          },
        },
        {
          type: 'n8n-nodes-base.httpRequest',
          name: 'Panel benachrichtigen (Beispiel)',
          parameters: { url: 'http://mail-panel:3002/api/internal/quarantaene/deliver-all' },
        },
        {
          type: 'n8n-nodes-base.telegram',
          name: 'Bestätigung senden',
          parameters: { chatId: '={{ $json.message.message.chat.id }}', text: 'fest' },
        },
      ],
      connections: {
        'Panel benachrichtigen (Beispiel)': { main: [[{ node: 'Bestätigung senden', type: 'main', index: 0 }]] },
      },
    };
    assert.equal(patcher.rueckkanalReparieren(wf), true);
    const [, weiche, aufruf, bestaetigung] = wf.nodes;
    assert.equal(weiche.type, 'n8n-nodes-base.if');
    assert.match(weiche.parameters.conditions.string[0].value1, /callback_query\.data/);
    assert.equal(weiche.parameters.conditions.string[1].value2, '987654321', 'die hinterlegte Chat-ID bleibt');
    assert.equal(aufruf.parameters.url, patcher.RUECKKANAL_URL);
    assert.match(bestaetigung.parameters.text, /\$json\.text/);
    assert.match(bestaetigung.parameters.chatId, /Telegram Trigger.*callback_query/);
    assert.equal(patcher.rueckkanalReparieren(wf), false, 'ein zweiter Abgleich ändert nichts');
  });

  test('die Knopf-Felder lesen', () => {
    assert.deepEqual(patcher.knopfFelderLesen('@{url=https://x.de/; callbackData=q}'),
      { url: 'https://x.de/', callback_data: 'q' });
  });
});

describe('POST /api/internal/quarantaene/deliver-all', () => {
  let server;
  let port;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/internal', require('../src/routes/internal'));
    await new Promise((f) => { server = app.listen(0, () => { port = server.address().port; f(); }); });
  });
  after(() => { try { server.close(); } catch { /* egal */ } });

  const post = () => new Promise((fertig, schief) => {
    const a = http.request({
      host: '127.0.0.1', port, path: '/api/internal/quarantaene/deliver-all', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
    }, (r) => {
      let t = '';
      r.on('data', (d) => { t += d; });
      r.on('end', () => fertig({ status: r.statusCode, json: t ? JSON.parse(t) : null }));
    });
    a.on('error', schief);
    a.end('{}');
  });

  test('ohne Mailcow: eine klare Antwort statt eines Fehlers', async () => {
    settings.setze('mailcow_url', '');
    const r = await post();
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.match(r.json.text, /Mailcow/);
  });

  test('stellt alle Einträge zu und sagt, wie viele', async () => {
    const echt = mailcow.client;
    let zugestellt = null;
    mailcow.client = () => ({
      get: async () => ({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      post: async (_pfad, rumpf) => { zugestellt = rumpf; return { data: [{ type: 'success' }] }; },
    });
    try {
      const r = await post();
      assert.equal(r.status, 200);
      assert.deepEqual(zugestellt, { action: 'deliver', items: ['1', '2', '3'] });
      assert.equal(r.json.zugestellt, 3);
      assert.match(r.json.text, /3 Quarantäne-Einträge/);
    } finally {
      mailcow.client = echt;
    }
  });

  test('eine leere Quarantäne ist kein Fehler', async () => {
    const echt = mailcow.client;
    mailcow.client = () => ({ get: async () => ({ data: [] }), post: async () => { throw new Error('nie'); } });
    try {
      const r = await post();
      assert.equal(r.json.ok, true);
      assert.equal(r.json.zugestellt, 0);
    } finally {
      mailcow.client = echt;
    }
  });
});
