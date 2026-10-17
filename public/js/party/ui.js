// Интерфейс совместного просмотра: кнопка «Смотреть вместе» (тулбар и плеер), вход по коду, панель комнаты —
// код с копированием, участники, кто управляет, чат. Логика — party/room.js.
import { h, icon, dialog, confirmDialog, containScroll, flySend, nudge } from '../ui.js';
import { copyIcon } from '../lottie.js';
import { normCode } from './net.js';
import { navigate, switchTab } from '../router.js';

const INVITE_URL = 'https://arigandores.github.io/anix-desktop/watch/'; // GitHub Pages репозитория, docs/watch/index.html
import { party, present, sendChat, setControl, openContent, isHost, canControl, queueAdd, queuePlay, queueRemove, queueMove, giveHost, memberName, roomSkip, setRoomSkip } from './room.js';

// Вид кнопок «Смотреть вместе» задаёт класс in-party и число участников у <html> (CSS): кнопкам не нужны подписки —
// экраны в стеке навигации отключаются от страницы и снова подключаются, и подписка у них устаревала бы
function paintRoot() {
  const n = party.room ? present().length : 0;
  document.documentElement.classList.toggle('in-party', !!party.room);
  // «Предложить комнате» — только когда в комнате что-то идёт; в пустой — «Смотреть вместе» (выбранное включится)
  document.documentElement.classList.toggle('party-busy', !!party.room?.state?.content);
  document.documentElement.style.setProperty('--party-count', `"${n}"`);
}
party.on(paintRoot);

// Всплывающие сообщения чата: пишет другой участник, а чата сейчас не видно (панель закрыта, плеер свёрнут, вы в
// каталоге) — показываем, кто и что написал. 5 с, не больше трёх; клик — открыть панель комнаты.
// В полноэкранном режиме браузер показывает только полноэкранный элемент — туда и вставляем.
const BUBBLE_MS = 5000; const BUBBLES_MAX = 3;
let bubbles = null;
const chatVisible = () => [...document.querySelectorAll('.party-chat')].some((x) => x.offsetParent !== null && x.getClientRects().length);
function bubble({ ava, title, text, cls = '' }) {
  const host = document.fullscreenElement || document.body;
  if (!bubbles || bubbles.parentNode !== host) { bubbles?.remove(); bubbles = h('div', { class: 'party-bubbles', 'aria-live': 'polite' }); host.append(bubbles); }
  const el = h('button', { class: `party-bubble ${cls}`, title: 'Открыть комнату' }, ava, h('span', { class: 'grow' }, h('b', null, title), h('span', { class: 'txt' }, text)));
  const hide = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), 180); };
  el.onclick = (e) => { e.stopPropagation(); hide(); openRoomUi(); };
  bubbles.append(el);
  while (bubbles.childElementCount > BUBBLES_MAX) bubbles.firstChild.remove();
  setTimeout(hide, BUBBLE_MS);
}
function chatBubble(m) {
  if (m.me || (chatVisible() && document.hasFocus())) return;
  const who = party.room ? present().find((p) => p.id === m.from) : null;
  const ava = who?.avatar ? h('img', { src: who.avatar, referrerpolicy: 'no-referrer', alt: '' }) : h('span', { class: 'ava' }, (m.name || '?').slice(0, 1).toUpperCase());
  bubble({ ava, title: m.name, text: m.text });
}
// Права хоста перешли: новому хосту — заметное «Вы теперь хост», остальным — кто теперь хост
function hostChanged({ host }) {
  if (!party.room) return;
  if (host === party.room.peerId) {
    bubble({ cls: 'system', ava: h('span', { class: 'ava' }, icon('ic_group', 'sm')), title: 'Вы теперь хост комнаты',
      text: 'Можно менять порядок очереди, решать, кто управляет, и передать права другому' });
  } else noticeBubble({ from: host, who: memberName(host), text: 'Теперь хост комнаты' });
}
// чужие действия в комнате: кто и что сделал
function noticeBubble(n) {
  if (n.system) { partyInfo(n.text); return; }
  const who = party.room ? present().find((p) => p.id === n.from) : null;
  const src = n.avatar ?? who?.avatar;
  const ava = src ? h('img', { src, referrerpolicy: 'no-referrer', alt: '' }) : h('span', { class: 'ava' }, (n.who || '?').slice(0, 1).toUpperCase());
  bubble({ cls: 'notice', ava, title: n.who, text: n.text });
}
// Служебное уведомление совместного просмотра («Код скопирован», «Управляет только хост», ошибки входа…) — той же
// карточкой, что действия участников и сообщения чата, а не нижним тостом
export function partyInfo(text) {
  bubble({ cls: 'system-info', ava: h('span', { class: 'ava' }, icon('ic_group', 'sm')), title: 'Смотреть вместе', text });
}
party.on((type, m) => {
  if (type === 'chat') chatBubble(m); else if (type === 'host') hostChanged(m); else if (type === 'notice') noticeBubble(m);
  else if (type === 'left') bubbles?.replaceChildren();
});
// открыть комнату: в плеере — развернуть его и открыть панель, иначе — окно «Смотреть вместе»
function openRoomUi() {
  const ov = document.querySelector('.player-overlay');
  if (ov && ov.partyPanel) { ov.mini?.(false); ov.partyPanel(); } else partyDialog();
}
const badge = (btn) => btn.append(h('span', { class: 'party-count' }));

// Содержимое: вне комнаты — создать или войти по коду; в комнате — код и приглашение, что смотрим сейчас,
// очередь «Дальше» (хост перетаскивает и удаляет), участники, кто управляет, чат, выход.
// Поле чата и список сообщений создаются один раз: перерисовка не стирает недописанное сообщение.
export function roomView({ inPlayer = false, onClose } = {}) {
  const el = h('div', { class: 'party-view' });
  const chatList = containScroll(h('div', { class: 'party-chat' }));
  const input = h('input', { class: 'input', placeholder: 'Сообщение…', maxlength: 500, onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') send(); } });
  const sendBtn = h('button', { class: 'icon-btn', title: 'Отправить', onclick: () => send() }, icon('ic_send'));
  const send = () => { if (input.value.trim()) flySend(sendBtn); sendChat(input.value); input.value = ''; };
  const chatRow = h('div', { class: 'party-send' }, input, sendBtn);
  let chatRoom = null;
  let knownPeople = null; // кто уже был в списке: новый участник въезжает (при первом показе комнаты — без анимации)
  let sorting = false; let pendingRender = false; let dragEndAt = 0; // после перетаскивания клик не открывает страницу
  function render() {
    if (sorting) { pendingRender = true; return; }
    const r = party.room;
    el.classList.toggle('lobby', !r); // вне комнаты панель — по содержимому, без пустого места под чат
    if (!r) { chatRoom = null; knownPeople = null; el.replaceChildren(...lobby()); return; }
    if (chatRoom !== r) { chatRoom = r; knownPeople = null; chatList.replaceChildren(...r.chat.map(chatLine)); chatList.scrollTop = chatList.scrollHeight; chatList.refreshScroll(); }
    const s = r.state;
    const host = s && s.host;
    const amHost = isHost();
    const code = party.fmtCode(r.code);
    const copy = (text, msg) => navigator.clipboard?.writeText(text).then(() => partyInfo(msg), () => partyInfo(code));
    // https-ссылка: anixdesktop:// мессенджеры не делают кликабельной — страница-переходник (docs/watch) откроет приложение
    const invite = () => copy(`Смотрим аниме вместе в Anix Desktop: ${INVITE_URL}#${r.code}\nКод комнаты: ${code}`, 'Приглашение скопировано — отправьте его друзьям');
    const people = present().map((p) => h('div', { class: 'party-member', dataset: { id: p.id } },
      p.avatar ? h('img', { src: p.avatar, referrerpolicy: 'no-referrer', alt: '' }) : h('span', { class: 'ava' }, (p.name || '?').slice(0, 1).toUpperCase()),
      h('span', { class: 'grow' }, p.me ? `${p.name} (вы)` : p.name),
      p.id === host ? h('span', { class: 'tag' }, 'хост') : null,
      amHost && !p.me ? h('button', { class: 'btn btn-tonal sm give-host', title: `Отдать права хоста: ${p.name}`, onclick: () => giveHost(p.id) }, 'Сделать хостом') : null));
    const ctrl = h('input', { type: 'checkbox' }); ctrl.checked = !s || s.ctrl !== 'host';
    ctrl.onchange = () => setControl(ctrl.checked ? 'all' : 'host');
    const c = s && s.content;
    const now = c ? h('div', { class: 'party-item now link', title: 'Открыть страницу аниме', onclick: () => openReleasePage(c, onClose) },
      c.image ? h('img', { src: c.image, referrerpolicy: 'no-referrer', alt: '' }) : null,
      h('div', { class: 'grow' }, h('b', null, c.title), h('small', null, [c.epName, c.dub].filter(Boolean).join(' · '))),
      !inPlayer && !r.player ? h('button', { class: 'icon-btn', title: 'Открыть плеер', onclick: (e) => { e.stopPropagation(); onClose?.(); openContent(c); } }, icon('ic_play', 'sm')) : null)
      : h('div', { class: 'party-hint' }, inPlayer ? 'Серия, которую вы смотрите, включится у всех.' : 'Откройте любую серию во встроенном плеере — она включится у всех.');
    const q = (s && s.queue) || [];
    const list = h('div', { class: 'party-queue' }, ...q.map((it) => queueRow(it, amHost, r.peerId)));
    if (amHost) dragSort(list);
    // перерисовка отсоединяет чат от страницы, а это сбрасывает его прокрутку — сохраняем её
    const chatTop = chatList.scrollTop; const chatBottom = !chatList.isConnected || chatList.scrollHeight - chatTop - chatList.clientHeight < 40;
    el.replaceChildren(...[
      h('div', { class: 'party-code' },
        h('div', { class: 'grow' }, h('small', null, 'Код комнаты'), h('b', null, code)),
        h('button', { class: 'icon-btn', title: 'Скопировать код', onclick: (e) => { e.currentTarget.querySelector('.lt')?.done(); copy(code, 'Код скопирован'); } }, copyIcon())),
      h('button', { class: 'btn btn-primary', onclick: invite }, icon('ic_person_add', 'sm'), 'Пригласить'),
      h('div', { class: 'party-sub' }, 'Сейчас'), now,
      h('div', { class: 'party-sub' }, `Дальше${q.length ? ` · ${q.length}` : ''}`),
      q.length ? list : null,
      h('button', { class: 'btn btn-tonal party-suggest', onclick: () => startSuggest(onClose) }, icon('ic_search', 'sm'), 'Предложить следующее аниме'),
      h('div', { class: 'party-sub' }, `Участники · ${people.length}`), ...people,
      amHost ? h('label', { class: 'party-row' }, h('span', { class: 'grow' }, 'Управлять могут все', h('small', null, 'Выключено — пауза, перемотка, серии и очередь только у вас')), h('span', { class: 'switch' }, ctrl, h('span'))) : null,
      // пропуск опенинга и эндинга — для всей комнаты; меняет хост, гостям видно, что решено
      ...['opening', 'ending'].map((k) => {
        const cb = h('input', { type: 'checkbox' }); cb.checked = roomSkip(k); cb.disabled = !amHost;
        cb.onchange = () => setRoomSkip(k, cb.checked);
        return h('label', { class: `party-row ${amHost ? '' : 'readonly'}` }, h('span', { class: 'grow' }, k === 'opening' ? 'Пропускать опенинг' : 'Пропускать эндинг',
          h('small', null, amHost ? 'Для всех — пропускает ваш плеер' : 'Решает хост')), h('span', { class: 'switch' }, cb, h('span')));
      }),
      h('div', { class: 'party-sub' }, 'Чат'), chatList, chatRow,
      h('div', { class: 'party-foot' }, h('span', { class: 'muted3' }, `Связь: ${r.net ? `${r.net.up()} из ${r.net.total}` : '…'}`),
        h('button', { class: 'btn btn-tonal', onclick: () => { party.leave(); partyInfo('Вы вышли из комнаты'); } }, 'Выйти из комнаты')),
    ].filter(Boolean)); // null — пропуски (пустая очередь, не хост): replaceChildren вывел бы их текстом «null»
    chatList.scrollTop = chatBottom ? chatList.scrollHeight : chatTop;
    const ids = new Set();
    for (const row of el.querySelectorAll('.party-member')) {
      ids.add(row.dataset.id);
      if (knownPeople && !knownPeople.has(row.dataset.id)) nudge(row, [{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], 380);
    }
    knownPeople = ids;
  }
  // элемент очереди: включить — кто может управлять; убрать — хост или автор; перетаскивать — хост
  function queueRow(it, amHost, me) {
    const mine = it.by === me; const c = it.content;
    const open = (e) => { if (e.target.closest('button') || Date.now() - dragEndAt < 300) return; openReleasePage(c, onClose); };
    return h('div', { class: `party-item link ${amHost ? 'sortable' : ''}`, 'data-id': it.id, title: 'Открыть страницу аниме', onclick: open },
      amHost ? h('span', { class: 'drag', title: 'Перетащите, чтобы поменять порядок' }, icon('ic_drag', 'sm')) : null,
      c.image ? h('img', { src: c.image, referrerpolicy: 'no-referrer', alt: '' }) : null,
      h('div', { class: 'grow' }, h('b', null, c.title), h('small', null, [c.epName, c.dub].filter(Boolean).join(' · ')),
        h('small', { class: 'by' }, mine ? 'предложили вы' : `предлагает ${it.byName}`)),
      canControl() ? h('button', { class: 'icon-btn', title: 'Включить для всех сейчас', onclick: () => queuePlay(it.id) }, icon('ic_play', 'sm')) : null,
      amHost || mine ? h('button', { class: 'icon-btn', title: 'Убрать из очереди', onclick: () => queueRemove(it.id) }, icon('ic_close', 'sm')) : null);
  }
  // Перетаскивание в очереди, как в мобильных приложениях: элемент приподнимается и едет за пальцем/курсором,
  // остальные плавно раздвигаются; отпустили — встаёт на место. Без «призрака» браузерного drag-and-drop.
  // Пока тянем, панель не перерисовывается (события комнаты подождут) — иначе элемент выдернуло бы из-под руки.
  function dragSort(list) {
    list.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.party-item');
      if (!row || e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const rows = [...list.querySelectorAll('.party-item')];
      if (rows.length < 2) return; // одну карточку двигать некуда
      const from = rows.indexOf(row);
      const rects = rows.map((x) => x.getBoundingClientRect());
      const step = rects.length > 1 ? rects[1].top - rects[0].top : rects[0].height;
      const startY = e.clientY; let to = from; let moved = false;
      try { row.setPointerCapture(e.pointerId); } catch { /* не у всех указателей */ }
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (!moved) { if (Math.abs(dy) < 4) return; moved = true; sorting = true; row.classList.add('lifted'); list.classList.add('sorting'); }
        // ход — строго в пределах очереди: карточка не наезжает на «Предложить следующее» и заголовок
        const lo = rects[0].top - rects[from].top; const hi = rects[rects.length - 1].top - rects[from].top;
        const cy = Math.max(lo, Math.min(hi, dy));
        row.style.transform = `translateY(${cy}px) scale(1.02)`;
        // Сосед уступает место, как только край поднятой карточки пересёк его середину (как в iOS/Android и SortableJS),
        // а не когда до него доехал центр — иначе сдвиг запаздывает почти на высоту карточки
        const top = rects[from].top + cy; const bottom = rects[from].bottom + cy;
        to = from;
        for (let i = from + 1; i < rects.length; i++) if (bottom > rects[i].top + rects[i].height / 2) to = i;
        for (let i = from - 1; i >= 0; i--) if (top < rects[i].top + rects[i].height / 2) to = i;
        rows.forEach((x, i) => {
          if (i === from) return;
          const shift = from < to && i > from && i <= to ? -step : from > to && i >= to && i < from ? step : 0;
          x.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const up = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        if (!moved) return;
        dragEndAt = Date.now();
        row.classList.add('settling');
        row.style.transform = `translateY(${(to - from) * step}px)`;
        setTimeout(() => {
          sorting = false;
          if (to !== from) queueMove(row.dataset.id, to); // перерисовка выстроит новый порядок на тех же местах
          if (to === from || pendingRender) { pendingRender = false; render(); }
        }, 170);
      };
      // движение и отпускание слушаем на всём окне: захват указателя срабатывает не везде, а отпустить можно и ниже списка
      addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    });
  }
  function chatLine(m) { return h('div', { class: `msg ${m.me ? 'me' : ''}` }, h('b', null, m.name), ' ', m.text); }
  function lobby() {
    const code = h('input', { class: 'input', placeholder: 'Код или ссылка-приглашение', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') join(); } });
    const busy = (b, on) => { b.disabled = on; };
    const createBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
      busy(createBtn, true); createBtn.textContent = 'Подключение…';
      try { await party.create(); partyInfo('Комната создана — отправьте друзьям код'); } catch (e) { partyInfo(`Не удалось создать комнату: ${e.message}`); render(); }
    } }, 'Создать комнату');
    const joinBtn = h('button', { class: 'btn btn-tonal', onclick: () => join() }, 'Войти');
    async function join() {
      busy(joinBtn, true); joinBtn.textContent = 'Подключение…';
      try { await party.join(code.value); partyInfo('Вы в комнате'); } catch (e) { partyInfo(e.message || 'Не удалось войти'); render(); }
    }
    return [
      h('p', { class: 'party-hint' }, 'Пауза, перемотка, серия и скорость — у всех одновременно, есть чат. Каждый смотрит со своего интернета; сервер не нужен — команды идут через открытые серверы MQTT в зашифрованном виде.'),
      createBtn,
      h('div', { class: 'party-sub' }, 'Или войдите по коду друга'),
      h('div', { class: 'party-send' }, code, joinBtn),
    ];
  }
  const off = party.on((type, m) => {
    if (type === 'chat') { // листаете старые — не дёргаем вниз; внизу или пишете сами — показываем новое
      const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
      const line = chatLine(m);
      chatList.append(line);
      nudge(line, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 240); // новое сообщение проявляется
      chatList.refreshScroll();
      if (atBottom || m.me) chatList.scrollTop = chatList.scrollHeight;
      return;
    }
    if (['joined', 'left', 'members', 'state', 'status'].includes(type)) render();
  });
  render();
  return { el, destroy: off };
}

// «Предложить следующее аниме»: плеер сворачивается в угол (серия идёт), открывается «Главная», внизу — плашка-подсказка.
// Выбранная серия любого аниме уходит в очередь «Дальше» без вопросов (screens/episodes.js); «Отмена» — обычный режим.
let banner = null;
export function suggestMode(on) {
  party.intent = on ? { queue: 'any' } : null;
  if (on && !banner) {
    banner = h('div', { class: 'party-pick-banner', role: 'status' }, icon('ic_group', 'sm'),
      h('span', { class: 'grow' }, 'Выберите аниме и серию — она встанет в очередь «Дальше»'),
      h('button', { class: 'btn btn-tonal', onclick: backToWatching }, 'Вернуться к просмотру'));
    document.body.append(banner);
  } else if (!on && banner) { banner.remove(); banner = null; }
}
party.on((type) => { if (type === 'left') suggestMode(false); });
// передумали предлагать — режим выключается и мини-плеер разворачивается обратно
function backToWatching() {
  suggestMode(false);
  const ov = document.querySelector('.player-overlay');
  if (ov && ov.mini) ov.mini(false);
}
function startSuggest(onClose) {
  onClose?.();
  party.room?.player?.ctl.minimize?.();
  suggestMode(true);
  switchTab('home');
}
// Страница аниме из «Сейчас» или очереди: плеер сворачивается в угол — серия идёт дальше
function openReleasePage(c, onClose) {
  onClose?.();
  party.room?.player?.ctl.minimize?.();
  navigate('release', { id: c.releaseId });
}

// Окно «Смотреть вместе» (вне плеера)
// Та же панель, что в плеере, только под кнопкой 👥 в шапке: размер постоянный, чат листается внутри, «Выйти»
// закреплена внизу. Закрывается по ✕, клику мимо, Esc и сама — когда открылся плеер комнаты (там своя панель).
// Повторный вызов (снова 👥) — закрывает.
let popover = null;
export function partyDialog() {
  if (popover) { popover.close(); return null; }
  const v = roomView({ onClose: () => close() });
  const el = h('div', { class: 'party-panel party-popover', role: 'dialog', 'aria-label': 'Смотреть вместе' },
    h('div', { class: 'party-head' }, h('b', { class: 'grow' }, 'Смотреть вместе'), h('button', { class: 'icon-btn', title: 'Закрыть', onclick: () => close() }, icon('ic_close', 'sm'))),
    v.el);
  const onDoc = (e) => { if (!el.contains(e.target) && !e.target.closest('.party-btn, .backdrop')) close(); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.backdrop:not(.closing)')) close(); };
  const off = party.on((type) => { if (type === 'player') close(); });
  function close() {
    if (popover !== me) return;
    popover = null; off(); v.destroy();
    document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey);
    el.classList.add('closing'); setTimeout(() => el.remove(), 140);
  }
  const me = { close, el };
  popover = me;
  (document.fullscreenElement || document.body).append(el);
  setTimeout(() => { if (popover === me) document.addEventListener('pointerdown', onDoc, true); });
  document.addEventListener('keydown', onKey);
  return me;
}

// Кнопка в тулбаре главных вкладок: число участников, пока вы в комнате
// onlyInRoom — на внутренних экранах: кнопка видна, только пока вы в комнате
export function partyEntryButton({ onlyInRoom = false } = {}) {
  const btn = h('button', { class: `icon-btn party-btn ${onlyInRoom ? 'only-in-room' : ''}`, title: 'Смотреть вместе', 'aria-label': 'Смотреть вместе', onclick: () => partyDialog() }, icon('ic_group'));
  badge(btn);
  return btn;
}

// Кнопка в плеере: открывает панель комнаты справа, поверх видео
export function partyPlayerButton(ov, { canWatch = true } = {}) {
  const btn = h('button', { class: 'icon-btn party-btn', title: 'Смотреть вместе', 'aria-label': 'Смотреть вместе', hidden: !canWatch }, icon('ic_group'));
  badge(btn);
  let panel = null; let view = null;
  let dismissed = false; // закрыли панель сами — в этом плеере она сама больше не открывается
  const closePanel = () => {
    if (!panel) return;
    const p = panel; panel = null; view.destroy(); btn.classList.toggle('open', false);
    p.classList.add('closing'); setTimeout(() => p.remove(), 140);
  };
  const dismiss = () => { dismissed = true; closePanel(); };
  const openPanel = () => {
    if (panel) return;
    view = roomView({ inPlayer: true });
    panel = h('div', { class: 'party-panel', onclick: (ev) => ev.stopPropagation(), onpointerdown: (ev) => ev.stopPropagation() },
      h('div', { class: 'party-head' }, h('b', { class: 'grow' }, 'Смотреть вместе'), h('button', { class: 'icon-btn', title: 'Закрыть', onclick: dismiss }, icon('ic_close', 'sm'))),
      view.el);
    ov.append(panel); btn.classList.toggle('open', true);
  };
  btn.onclick = (e) => { e.stopPropagation(); if (panel) dismiss(); else openPanel(); };
  // В комнате панель открыта сразу — у хоста и у участников; создали комнату или вошли при открытом плеере — тоже
  if (party.room && canWatch) setTimeout(openPanel, 0);
  const off = party.on((type) => {
    if (!btn.isConnected) { off(); closePanel(); return; } // плеер закрыт — панель тоже
    if (type === 'joined' && canWatch && !dismissed) openPanel();
  });
  ov.partyPanel = () => { if (canWatch) openPanel(); }; // клик по всплывающему сообщению чата
  return btn;
}

// Выбрали серию, будучи в комнате: тот же тайтл и озвучка — включается у всех («следующая серия»); другое — спросить:
// включить для всех сейчас или поставить в очередь «Дальше». Возвращает 'play' | 'queue' | null (отмена).
export function partyPick(content) {
  const r = party.room; if (!r) return Promise.resolve('play');
  const c = r.state && r.state.content;
  const same = c && c.releaseId === content.releaseId && c.typeId === content.typeId && c.sourceId === content.sourceId;
  if (!c || same) return Promise.resolve(canControl() ? 'play' : 'queue');
  return new Promise((resolve) => {
    let done = false; const pick = (v) => () => { done = true; resolve(v); };
    dialog({
      title: 'Смотреть вместе',
      content: h('p', null, `${content.title} · ${content.epName}${content.dub ? ` · ${content.dub}` : ''}. Сейчас в комнате: ${c.title} · ${c.epName}.`),
      actions: [{ label: 'Отмена', onClick: pick(null) }, { label: 'В очередь «Дальше»', onClick: pick('queue') },
        ...(canControl() ? [{ label: 'Включить для всех', primary: true, onClick: pick('play') }] : [])],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}
export { queueAdd };

// Кнопка рядом с «Воспроизвести» на странице аниме: вне комнаты — создать комнату и выбрать серию (она включится у
// всех); в комнате — предложить это аниме: выбранная серия уйдёт в очередь «Дальше»
export function partyWatchButton(release, onWatch) {
  const btn = h('button', { class: 'btn btn-tonal lg btn-party', title: 'Смотреть вместе: пауза, перемотка и серии — у всех одновременно' },
    icon('ic_group'), h('span', { class: 'out' }, 'Смотреть вместе'), h('span', { class: 'in' }, 'Предложить комнате'));
  btn.onclick = async () => {
    if (party.room) { if (party.room.state?.content) suggestMode(true); onWatch(); return; } // ничего не идёт — просто выбрать серию
    btn.disabled = true;
    try { await party.create(); party.intent = null; partyInfo('Комната создана — выберите серию, она включится у всех'); onWatch(); } catch (e) { partyInfo(`Не удалось создать комнату: ${e.message}`); } finally { btn.disabled = false; }
  };
  return btn;
}

// Приглашение-ссылка anixdesktop://watch/<код> (electron/main.js): спросить и войти в комнату
async function onInvite(url) {
  const m = /watch\/([0-9A-Za-z-]+)/.exec(url || '');
  const code = m && normCode(m[1]);
  if (!code) return;
  if (party.room && party.room.code === code) { partyInfo('Вы уже в этой комнате'); return; }
  const text = party.room ? `Выйти из текущей комнаты и войти в ${party.fmtCode(code)}?` : `Войти в комнату ${party.fmtCode(code)}? Серия комнаты откроется сама.`;
  if (!(await confirmDialog('Смотреть вместе', text, 'Войти'))) return;
  try { await party.join(code); partyInfo('Вы в комнате'); } catch (e) { partyInfo(e.message || 'Не удалось войти'); }
}
const native = window.anixartNative;
if (native && native.onDeepLink) { native.onDeepLink(onInvite); native.pendingDeepLink().then(onInvite, () => {}); }
