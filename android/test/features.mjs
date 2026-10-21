// На Android нет улучшения картинки, AI-помощника, статуса в Discord и стороннего плеера (public/js/platform.js):
// ни вкладки, ни разделов настроек, ни пунктов меню плеера и чипа плеера; апскейл не включается и из старой настройки
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, screenshot, pageErrors, persist } from './_device.mjs';

await ensureDevice();
install();
await launch({ fresh: true });
// старые настройки (как будто перенесли с ПК): апскейл «Авто», сторонний плеер, Discord — на Android не действуют
await js(`(localStorage.setItem('anixart.pref.UPSCALE_MODE', '"auto"'), localStorage.setItem('anixart.pref.SELECTED_PLAYER', '3'), localStorage.setItem('anixart.pref.DISCORD_PRESENCE', 'true'), 1)`);
await persist();
await launch();

check('нет вкладки AI', await js(`!document.querySelector('.nav-item[data-tab="ai"]')`));
check('сторонний плеер из старой настройки → встроенный', await js(`localStorage.getItem('anixart.pref.SELECTED_PLAYER')`) === '2');

// Настройки: разделы
await tap('[title="Настройки"]');
check('настройки открылись', !!(await until(`${REAL('.settings-tab')} > 3`, 10000)));
const sections = await js(`[...document.querySelectorAll('.settings-tab')].map((b) => b.dataset.section + ':' + b.textContent.trim())`);
check('разделы без AI-помощника и Discord', !sections.some((s) => /^(ai|discord):/.test(s)), sections);
check('вместо «Картинка и звук» — «Звук»', sections.includes('picture:Звук'), sections);
await tap('.settings-tab[data-section="picture"]');
const picture = await js(`document.querySelector('.settings-body').textContent`);
check('в «Звуке» нет улучшения картинки, TensorRT, проверки видеокарты', !/Улучшение картинки|TensorRT|видеокарт|Разрешение улучшения/.test(picture), picture.slice(0, 120));
check('в «Звуке» есть переключатели звука', await js(`document.querySelectorAll('.settings-body .switch').length`) >= 1);
await tap('.settings-tab[data-section="playback"]');
check('в «Воспроизведении» нет пути к mpv/VLC', !/mpv|VLC|Сторонний плеер/i.test(await js(`document.querySelector('.settings-body').textContent`)));
await tap('.settings-body .menu-item', { text: 'Видеоплеер' });
const players = await js(`[...document.querySelectorAll('.backdrop .sheet-item, .backdrop [role="menuitemradio"], .backdrop .menu-item, .backdrop button')].map((b) => b.textContent.trim()).filter(Boolean)`);
check('выбор плеера в настройках — без стороннего', players.length > 0 && !players.some((p) => /Сторонний|mpv|VLC/i.test(p)), players);
await back();
await tap('.settings-tab[data-section="about"]');
check('«О приложении» — Anix', /Anix\b(?! Desktop)/.test(await js(`document.querySelector('.settings-body').textContent`)));
screenshot('features-settings');
await back(); // настройки → главная

// Чип плеера на экране серий и меню плеера
const api = await js(`fetch('/api/config/toggles').then((r) => r.status)`);
if (api >= 500) { skip('экран серий и плеер', `бекенд Anixart отвечает ${api}`); done('features'); }
await tap('.release-row', { index: 0, wait: 25000 });
await tap('.btn-watch', { wait: 20000 });
await until(`${REAL('.type-row, .ep-row')} > 0`, 20000);
if (await js(`${REAL('.type-row')} > 0`)) await tap('.type-row', { index: 0 });
await until(`${REAL('.ep-row')} > 0`, 20000);
await tap('.wchip-player');
const chip = await js(`[...document.querySelectorAll('.pop-item')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim())`);
check('чип плеера: встроенный и веб, без стороннего и «до 4K»', chip.length === 2 && !chip.some((c) => /Сторонний|mpv|4K|нейросет/i.test(c)), chip);
screenshot('features-player-chip');
await back();
await tap('.ep-row', { index: 0 });
const ok = await until(`(() => { const v = document.querySelector('.player-overlay video'); return v && v.readyState >= 2; })()`, 40000);
if (!ok) skip('меню плеера', 'серия не загрузилась');
else {
  check('апскейл выключен, хотя в настройке «Авто»', await js(`document.querySelector('.player-overlay').upscale.mode === 'off' && document.querySelector('.player-overlay .up-canvas')?.hidden !== false`));
  await tap('.player-stage', { after: 700 });
  await tap('.player-overlay .gear', { after: 700 });
  const rows = await js(`[...document.querySelectorAll('.player-menu .pm-row')].map((r) => r.textContent.trim())`);
  check('меню плеера: качество, звук, скорость, пропуски — без «Улучшения»', rows.length >= 3 && !rows.some((r) => /Улучшение/.test(r)) && rows.some((r) => /Звук/.test(r)), rows);
  screenshot('features-player-menu');
  const keyU = await js(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true })), document.querySelector('.player-overlay').upscale.mode)`);
  check('клавиша U не включает апскейл', keyU === 'off', keyU);
  await back(); await back();
}
check('Discord: статус не отправляется', await js(`performance.getEntriesByType('resource').every((e) => !/\\/discord\\//.test(e.name))`));
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('features');
