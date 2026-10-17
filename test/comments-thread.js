require('./_failfast');
// Комментарии и правки по ним (вход и отправка подменены в странице — реальный аккаунт не затрагивается):
//  - тема по умолчанию — тёмная (чистый профиль, без выбора в настройках);
//  - статус на постере в списке обновляется, если сменить его на странице аниме и вернуться назад;
//  - экран комментариев: поле ввода закреплено под шапкой при прокрутке;
//  - «Показать N ответов» раскрывает ветку под комментарием (без перехода на другой экран);
//  - «Ответить» — поле в ветке («Спойлер» и «Отправить», без строки «Ответ: …»), отправленный ответ сразу в ветке.
// Запуск: npx electron test/comments-thread.js
const { app, BrowserWindow, nativeTheme } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'; // система — светлая: тёмная тема должна включаться сама, а не «как в системе»
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('console:', e.message); });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.removeItem('anixart.theme')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await settle(js, 5000);
  check(await js('document.documentElement.dataset.theme') === 'dark', 'тема по умолчанию — тёмная');
  // поле чата ИИ (ai.js) — с тем же общим классом .comment-input: кнопка «Отправить» справа от поля, на одной линии
  // (класс стал блоком под поле комментария — кнопка уезжала под поле)
  const ai = await js(`(async () => { const ui = await import('/js/ui.js');
    const box = ui.h('div', { class: 'comment-input ai-composer', style: { position: 'fixed', left: '0', bottom: '0', width: '800px', zIndex: 999 } }, ui.h('textarea', { class: 'input', rows: 1 }), ui.h('button', { class: 'icon-btn ai-send' }, ui.icon('ic_send')));
    document.body.append(box); await new Promise((r) => requestAnimationFrame(r));
    const t = box.querySelector('textarea').getBoundingClientRect(); const b = box.querySelector('button').getBoundingClientRect(); box.remove();
    return { right: b.left >= t.right - 1, sameRow: b.top < t.bottom }; })()`);
  check(ai.right && ai.sameRow, 'чат ИИ: кнопка «Отправить» справа от поля, на одной линии');

  // вход и изменяющие запросы — подменены
  await js(`(async () => {
    const { auth } = await import('/js/api.js');
    Object.defineProperty(auth, 'loggedIn', { get: () => true, configurable: true });
    window.__added = null;
    const of = window.fetch;
    const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (...a) => {
      const u = String(a[0].url || a[0]);
      if (/profile\\/list\\/(add|delete)\\//.test(u)) return json({ code: 0 });
      if (/release\\/comment\\/add\\//.test(u)) { window.__added = JSON.parse(a[1]?.body || '{}'); return json({ code: 0 }); }
      if (/release\\/comment\\/(delete|edit)\\//.test(u)) return json({ code: 0 });
      const r = await of(...a);
      // после «отправки» ответ появляется в ответах сервера — добавляем его в конец ветки
      if (window.__added && /release\\/comment\\/replies\\//.test(u)) {
        const j = await r.clone().json();
        j.content = [...(j.content || []), { id: 1e12, message: window.__added.message, profile: { login: 'Я', id: 1 }, timestamp: Date.now() / 1000, vote_count: 0, is_reply: true }];
        return json(j);
      }
      return r;
    };
  })()`);

  // 1. статус на постере: список → аниме → «Смотрю» → назад
  const st = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const until = async (fn, max = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = fn(); if (v) return v; await sleep(50); } return null; };
    const r = await import('/js/router.js');
    r.navigate('search', { query: 'Мастер Муси' });
    const row = await until(() => [...document.querySelectorAll('.screen[data-screen="search"] .release-row')].find((x) => !x.closest('.skeleton, .sk-root')));
    if (!row) return { err: 'нет результатов поиска' };
    if (row.querySelector('.status-bubble')) return { err: 'у первого результата уже есть статус' };
    row.click();
    const listBtn = await until(() => document.querySelector('.screen[data-screen="release"] .rel-title') && document.querySelector('.screen[data-screen="release"] .rel-actions .list-btn'));
    if (!listBtn) return { err: 'страница аниме не открылась: ' + [...document.querySelectorAll('#viewport .screen')].map((x) => x.dataset.screen).join(',') };
    listBtn.click();
    const item = await until(() => [...document.querySelectorAll('.sheet-item')].find((b) => /Смотрю/.test(b.textContent)));
    if (!item) return { err: 'нет пункта «Смотрю» в выборе статуса: ' + (document.querySelector('.backdrop')?.innerText || 'диалога нет').slice(0, 150) };
    item.click();
    await until(() => document.querySelector('.screen[data-screen="release"] .rel-actions .list-btn.tag-1'));
    history.back();
    const back = await until(() => { const s = document.querySelector('#viewport .screen:last-child'); return s && s.dataset.screen === 'search' ? s : null; });
    await sleep(300);
    const b = back && back.querySelector('.release-row .status-bubble');
    return { bubble: b ? b.className : null };
  })()`);
  if (st.err) check(false, `статус на постере: ${st.err}`);
  else check(st.bubble && st.bubble.includes('s1'), `статус «Смотрю» на постере в списке после возврата (${st.bubble})`);

  // 2–4. экран комментариев
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const until = async (fn, max = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = fn(); if (v) return v; await sleep(50); } return null; };
    (await import('/js/router.js')).navigate('comments', { kind: 'release', id: 21 });
    // настоящие комментарии, а не строки скелетона (у них тот же класс .comment)
    const scr = await until(() => { const s = document.querySelector('#viewport .screen:last-child'); return s?.dataset.screen === 'comments' && [...s.querySelectorAll('.comment')].filter((x) => !x.closest('.skeleton, .sk-root')).length > 5 ? s : null; });
    if (!scr) return { err: 'комментарии не загрузились' };
    const out = {};
    const vp = document.getElementById('viewport');
    vp.scrollTop = 800; await sleep(200);
    const comp = scr.querySelector('.comment-input.top'); const bar = scr.querySelector('.appbar');
    out.sticky = vp.scrollTop >= 400 && Math.abs(comp.getBoundingClientRect().top - bar.getBoundingClientRect().bottom) < 2;
    vp.scrollTop = 0;
    const btn = await until(() => [...scr.querySelectorAll('.thread-toggle')].find((b) => b.style.display !== 'none'));
    if (!btn) return { ...out, err: 'нет комментариев с ответами' };
    const cm = btn.closest('.comment');
    btn.click();
    out.inline = !!(await until(() => cm.querySelector('.comment-thread .comment.reply'))) && document.querySelector('#viewport .screen:last-child') === scr;
    const replyBtn = [...cm.querySelectorAll(':scope > .body > .tools button')].find((b) => b.textContent === 'Ответить');
    replyBtn.click();
    const inl = await until(() => cm.querySelector('.comment-thread .comment-input.inline'));
    out.composer = !!(inl && inl.querySelector('.composer-spoiler') && inl.querySelector('.composer-send') && inl.querySelector('textarea'));
    out.noReplyBar = !scr.innerText.includes('Ответ:');
    const sp = inl.querySelector('.composer-spoiler'); sp.click(); out.spoilerToggle = sp.getAttribute('aria-pressed') === 'true'; sp.click();
    const ta = inl.querySelector('textarea'); ta.value = 'Проверочный ответ из теста'; ta.dispatchEvent(new Event('input'));
    inl.querySelector('.composer-send').click();
    out.sent = !!(await until(() => [...cm.querySelectorAll('.comment-thread .comment.reply')].some((x) => x.textContent.includes('Проверочный ответ из теста'))));
    out.parentId = window.__added?.parentCommentId != null;
    out.composerClosed = !cm.querySelector('.comment-input.inline');

    // свои комментарии: изменить и удалить — карточка обновляется сразу (раньше оставалась прежней)
    const { auth: au } = await import('/js/api.js');
    const asAuthorOf = (el) => { const id = el.__authorId; Object.defineProperty(au, 'profileId', { get: () => id, configurable: true }); };
    const menu = async (el, label) => {
      el.querySelector(':scope > .body > .who .icon-btn').click();
      const it = await until(() => [...document.querySelectorAll('.sheet-item')].find((b) => b.textContent.includes(label)));
      it.click();
    };
    const dialogBtn = (label) => until(() => [...document.querySelectorAll('.backdrop:not(.closing) .dialog-actions .btn')].find((b) => b.textContent === label));
    // комментарий без ответов: id автора — из данных, что пришли в список (вешаем на элемент при поиске)
    const plain = [...scr.querySelectorAll('.list > .comment, .grid > .comment, .comment:not(.reply)')].find((x) => !x.closest('.skeleton, .sk-root') && x !== cm && !x.querySelector('.thread-toggle:not([style*="none"])'));
    const { A: api0 } = await import('/js/api.js');
    const page0 = await api0.releaseComments(21, 0, 1);
    const who = plain.querySelector('.who').textContent;
    const data = (page0.content || []).find((x) => who.startsWith(x.profile?.login || '\\u0000'));
    if (!data) return { ...out, err2: 'не нашёл данные комментария для проверки удаления' };
    plain.__authorId = data.profile.id; asAuthorOf(plain);
    await menu(plain, 'Редактировать');
    const editTa = await until(() => document.querySelector('.backdrop:not(.closing) .dialog textarea'));
    editTa.value = 'Изменённый текст из теста';
    (await dialogBtn('Сохранить')).click();
    out.edited = !!(await until(() => plain.querySelector('.msg').textContent.includes('Изменённый текст из теста')));
    const countBefore = parseInt(scr.querySelector('.row .muted').textContent.replace(/[^0-9]/g, ''), 10);
    await menu(plain, 'Удалить');
    (await dialogBtn('Удалить')).click();
    out.deleted = !!(await until(() => !plain.isConnected, 3000));
    const countAfter = parseInt(scr.querySelector('.row .muted').textContent.replace(/[^0-9]/g, ''), 10);
    out.countDown = countAfter === countBefore - 1;
    return out;
  })()`);
  if (r.err) check(false, r.err);
  check(r.sticky, 'поле ввода закреплено под шапкой при прокрутке');
  check(r.inline, '«Показать ответы» — ветка под комментарием, без перехода на другой экран');
  check(r.composer && r.noReplyBar, '«Ответить» — поле в ветке со «Спойлер» и «Отправить», без «Ответ: …»');
  check(r.spoilerToggle, '«Спойлер» — переключатель (aria-pressed)');
  check(r.sent && r.parentId && r.composerClosed, 'отправленный ответ сразу в ветке, поле закрылось');
  if (r.err2) check(false, r.err2);
  check(r.edited, 'свой комментарий изменён — новый текст виден сразу');
  check(r.deleted && r.countDown, 'свой комментарий удалён — исчез со страницы, счётчик на один меньше');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
