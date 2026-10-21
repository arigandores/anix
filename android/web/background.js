// Фоновая проверка уведомлений Anixart (NotifyJob.kt запускает скрытый WebView раз в ~30 мин, пока приложение закрыто):
// новые уведомления аккаунта — системными уведомлениями телефона, как push в приложении Anixart (у него — Firebase
// своего проекта, нам он недоступен). Запросы — тем же кодом, что у приложения (shim.js: подпись и relay, api.js: токен).
// Присылаем только то, что пришло после прошлой проверки (anix.notify.last — время самого нового присланного);
// первая проверка — точка отсчёта, старые непрочитанные не присылаем
import { api, auth } from '/js/api.js';

const LAST = 'anix.notify.last';
const bg = window.anixBackground;

const login = (p) => (p && p.login) || 'Пользователь';
const strip = (s, n = 140) => { const t = String(s || '').replace(/<[^>]+>/g, '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// уведомление сервера → { id, title, text, image, link } (link — anixart://…, его открывает links.js)
function card(n) {
  const c = n.comment || {};
  const base = { id: `${n.type}:${n.id}` };
  switch (n.type) {
    case 'episode': {
      const ep = n.episode || {}; const rel = ep.release || n.release || {}; const src = ep.source || {};
      const dub = src.type?.name;
      return { ...base, title: rel.title_ru || 'Новая серия', text: `Вышла ${ep.name || 'новая серия'}${dub ? ` · ${dub}` : ''}`, image: rel.image, link: `anixart://release?id=${rel.id}` };
    }
    case 'relatedRelease': {
      const rel = n.release || {};
      return { ...base, title: 'Новый релиз', text: `Добавлена страница «${rel.title_ru || ''}»`, image: rel.image, link: `anixart://release?id=${rel.id}` };
    }
    case 'friend': {
      const p = n.by_profile || n.profile || {};
      return { ...base, title: 'Друзья', text: n.status === 1 ? `${login(p)} добавил вас в друзья` : `${login(p)} хочет добавить вас в друзья`, image: p.avatar, link: `anixart://profile?id=${p.id}` };
    }
    case 'article': {
      const a = n.article || {}; const ch = a.channel || {};
      return { ...base, title: ch.title || 'Новая запись', text: 'Новая запись на канале', image: ch.avatar, link: `anixart://article?id=${a.id}` };
    }
    default: { // ответы и комментарии — к списку уведомлений
      const p = c.profile || n.profile || {};
      const mine = n.type === 'myCollection' || n.type === 'myArticle';
      return { ...base, title: mine ? 'Новый комментарий' : 'Новый ответ', text: `${login(p)}: ${c.is_spoiler ? 'может содержать спойлер' : strip(c.message)}`, image: p.avatar, link: 'anixart://notifications' };
    }
  }
}

async function check() {
  if (!auth.loggedIn) return [];
  let feed = null; // для тестов (android/test/push.mjs): уведомления вместо сервера
  try { feed = JSON.parse(localStorage.getItem('anix.test.notifyFeed') || 'null'); } catch { /* нет */ }
  const r = feed || await api.get('notification/all/0');
  const items = (r.content || []).filter((n) => n.is_new && n.timestamp);
  const last = Number(localStorage.getItem(LAST) || 0);
  const newest = Math.max(last, ...items.map((n) => n.timestamp));
  localStorage.setItem(LAST, String(newest));
  if (!last) return [];
  return items.filter((n) => n.timestamp > last).sort((a, b) => a.timestamp - b.timestamp).slice(-5).map(card);
}

check().then((list) => bg.done(JSON.stringify(list)), (e) => bg.done(JSON.stringify({ error: String(e && e.message || e) })));
