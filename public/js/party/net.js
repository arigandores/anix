// Связь комнаты совместного просмотра — без своего сервера: зашифрованные сообщения через публичные MQTT-брокеры.
// Подключаемся сразу к нескольким (сообщение уходит во все, повторы отбрасываются по id): упал или тормозит один —
// комната работает через остальные. Брокер видит только тему-хеш и шифротекст: ключ AES-GCM и тема выводятся из
// кода комнаты (PBKDF2), код знают только участники.
// Сторож: каждый получает обратно свои же сообщения (сердцебиение раз в 10 с) — брокер, от которого ничего не
// пришло 25 с, переподключаем: так переживаем и обрывы, и провайдеров, которые «замораживают» долгие соединения
// с зарубежными хостингами после ~16 КБ.
//   Каналы: m — сообщения, st — состояние комнаты (retain: опоздавший получает его сразу), p/<peer> — присутствие
//   (retain; «последняя воля» брокера стирает его, если участник пропал без «до свидания»).

export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const TIMING = { watchdog: 25000, connect: 12000 }; // сторож; вход в комнату ждёт хотя бы один брокер
const T = (k) => window.__anixPartyTiming?.[k] ?? TIMING[k]; // тесты подменяют короткими

// Код комнаты: 12 знаков Crockford base32 (60 бит) — XXXX-XXXX-XXXX. Без I, L, O, U: их не перепутать при вводе.
// При вводе O читается как 0, I и L — как 1 (их в коде не бывает). Q — обычная буква кода, её не трогаем.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => ALPHABET[x & 31]).join('');
}
// принимает и код, и ссылку-приглашение целиком (…/watch/#КОД, anixdesktop://watch/КОД)
export function normCode(s) {
  s = String(s || '').trim();
  const link = /(?:#|watch\/)([0-9A-Za-z-]{12,16})\/?\s*$/.exec(s); if (link) s = link[1];
  const c = s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  return c.length === 12 && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}
export const fmtCode = (c) => c.match(/.{4}/g).join('-');
export const randomId = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');

// Ключ и тема из кода: PBKDF2 с солью и 150 тыс. итераций — перебор кодов по подслушанной теме бессмыслен
async function derive(code) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('anix-party-v1'), iterations: 150000 }, base, 384));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const topic = [...bits.slice(32)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { key, topic };
}

let mqttLib = null;
function loadMqtt() {
  mqttLib ||= new Promise((resolve, reject) => {
    if (window.mqtt) { resolve(window.mqtt); return; }
    const s = document.createElement('script');
    s.src = '/vendor/mqtt.min.js';
    s.onload = () => resolve(window.mqtt); s.onerror = () => { mqttLib = null; reject(new Error('mqtt.js не загрузился')); };
    document.head.append(s);
  });
  return mqttLib;
}

// onMessage({ id, from, t, k, d }, { retained }) — расшифрованное сообщение; onGone(peerId, url) — брокер url стёр
// присутствие участника («последняя воля»: его соединение с этим брокером оборвалось)
export async function connectRoom(code, { peerId, onMessage, onGone, onStatus, brokers = window.__anixPartyBrokers || BROKERS }) { // подмена — для тестов
  const mqtt = await loadMqtt();
  const { key, topic } = await derive(code);
  const base = `anixparty/v1/${topic}`;
  const seen = new Map(); // id → время: одно сообщение приходит от каждого брокера
  const enc = async (obj) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return out;
  };
  const dec = async (buf) => {
    const iv = buf.subarray(0, 12);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf.subarray(12))));
  };
  const markSeen = (id) => {
    seen.set(id, Date.now());
    if (seen.size > 3000) for (const [k, t] of seen) { if (Date.now() - t > 120000) seen.delete(k); if (seen.size < 2000) break; }
  };

  // Сохранённое (состояние, присутствие) — последнее по каждому каналу: при подключении и переподключении брокера
  // отправляем его заново; сообщения, отправленные, пока не было связи ни с одним брокером, ждут первого подключения
  const retainedLast = new Map(); let backlog = [];
  let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
  const links = brokers.map((url) => {
    const c = mqtt.connect(url, {
      clientId: `anix_${randomId(6)}`, clean: true, keepalive: 20, reconnectPeriod: 3000, connectTimeout: 10000, protocolVersion: 4,
      will: { topic: `${base}/p/${peerId}`, payload: new Uint8Array(0), retain: true, qos: 0 },
    });
    const link = { url, c, up: false, lastRx: Date.now() };
    c.on('connect', () => {
      link.up = true; link.lastRx = Date.now();
      c.subscribe(`${base}/#`, { qos: 0 });
      for (const [ch, payload] of retainedLast) c.publish(`${base}/${ch}`, payload, { qos: 0, retain: true });
      if (backlog.length) { const b = backlog; backlog = []; for (const [ch, payload] of b) c.publish(`${base}/${ch}`, payload, { qos: 0 }); }
      readyResolve(); onStatus?.();
    });
    c.on('close', () => { if (link.up) { link.up = false; onStatus?.(); } });
    c.on('error', () => {});
    c.on('message', async (tp, payload, packet) => {
      link.lastRx = Date.now();
      if (!payload || !payload.length) { // стёртое присутствие — участник ушёл
        const m = tp.match(/\/p\/([0-9a-f]+)$/); if (m && m[1] !== peerId) onGone?.(m[1], url);
        return;
      }
      let msg; try { msg = await dec(payload); } catch { return; } // чужое или битое
      if (!msg || !msg.id || seen.has(msg.id)) return;
      markSeen(msg.id);
      onMessage(msg, { retained: !!packet.retain });
    });
    return link;
  });
  // сторож: брокер молчит дольше T('watchdog') (а свои сердцебиения мы получаем назад) — пересоздаём соединение
  const watchdog = setInterval(() => {
    for (const l of links) if (l.up && Date.now() - l.lastRx > T('watchdog')) { l.up = false; l.lastRx = Date.now(); l.c.end(true, {}, () => l.c.reconnect()); onStatus?.(); }
  }, 5000);

  async function publish(channel, k, d, retain = false) {
    const msg = { v: 1, id: randomId(), from: peerId, t: Date.now(), k, d };
    markSeen(msg.id); // своё эхо не разбираем, но оно освежает сторожа
    const payload = await enc(msg);
    if (retain) retainedLast.set(channel, payload);
    const up = links.filter((l) => l.up);
    if (!up.length && !retain) { backlog.push([channel, payload]); if (backlog.length > 50) backlog.shift(); }
    for (const l of up) l.c.publish(`${base}/${channel}`, payload, { qos: 0, retain });
    return msg;
  }
  // нет связи ни с одним брокером — комнаты нет: закрываем и сообщаем
  const ok = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), T('connect')))]);
  if (!ok) {
    clearInterval(watchdog);
    for (const l of links) l.c.end(true);
    throw new Error('Нет связи с серверами комнат — проверьте интернет и попробуйте ещё раз');
  }
  return {
    send: (k, d) => publish('m', k, d),
    setState: (d) => publish('st', 'st', d, true),
    setPresence: (d) => publish(`p/${peerId}`, 'hello', d, true),
    up: () => links.filter((l) => l.up).length,
    total: links.length,
    links, // для тестов (test/party-edge.js — «замёрзшее» соединение)
    // оборвать сразу, без DISCONNECT: брокер сочтёт это обрывом и опубликует «последнюю волю» (присутствие стирается)
    drop() { clearInterval(watchdog); for (const l of links) { try { l.c.end(true); } catch { /* уже */ } } },
    async close() {
      clearInterval(watchdog);
      for (const l of links) {
        if (l.up) l.c.publish(`${base}/p/${peerId}`, new Uint8Array(0), { qos: 0, retain: true }); // ушли сами — присутствие стираем
        l.c.end(false);
      }
    },
  };
}
