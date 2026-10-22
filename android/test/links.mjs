// Ссылки между приложениями: приглашение anixdesktop://watch/<код> (запуск по ссылке и в уже открытое приложение),
// «Поделиться» — системное меню, внешние ссылки — в браузере, «Скопировать» — без ошибок; ссылки на Anixart
// (https://anixart.tv/release/…, anixart://…, ссылка в тексте) — экран в приложении
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, sleep, sh, PKG, topActivity, screenshot, pageErrors } from './_device.mjs';

const CODE = 'ABCD2345WXYZ';
const LINK = `anixdesktop://watch/${CODE}`;
const inviteDialog = () => until(`(() => { const d = document.querySelector('.backdrop:not(.closing)'); return d && /ABCD-2345-WXYZ/.test(d.textContent) ? d.textContent : null; })()`, 10000);
const cancelDialog = async () => { await tap('.backdrop:not(.closing) button', { text: 'Отмена', after: 600 }); };

await ensureDevice();
install();

// Приложение не запущено — ссылка открывает его и предлагает войти в комнату
sh(`am force-stop ${PKG}`);
await launch({ link: LINK });
check('ссылка-приглашение запускает приложение', topActivity().startsWith(PKG), topActivity());
check('…и предлагает войти в комнату с этим кодом', !!(await inviteDialog()));
screenshot('links-invite');
await cancelDialog();
check('«Отмена» — без комнаты', !!(await until(`!document.querySelector('.backdrop:not(.closing)')`, 5000)));

// Приложение открыто — ссылка приходит в него же (без перезапуска страницы)
await js('window.__mark = 1');
sh(`am start -W -a android.intent.action.VIEW -d '${LINK}' ${PKG}`);
check('открытое приложение получает приглашение', !!(await inviteDialog()));
check('страница не перезагружалась', await js('window.__mark === 1'));
await cancelDialog();

// Внешняя ссылка (window.open) — в браузере
await tap('[title="Настройки"]', { after: 900 });
await tap('.settings-tab[data-section="about"]');
await tap('.settings-body .menu-item', { text: 'Исходный код', after: 2500 });
const top1 = topActivity();
check('внешняя ссылка — в браузере, не в приложении', !!top1 && !top1.startsWith(PKG), top1);
check('страница приложения на месте (не ушла на сайт)', await js(`location.origin === 'http://127.0.0.1:38371' && !!document.querySelector('.settings-tab')`));
sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1200);
await back();

if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('«Поделиться»', 'бекенд Anixart не отвечает'); done('links'); }
// «Поделиться» на странице аниме — системное меню
await until(`${REAL('.release-row')} > 0`, 25000);
const relId = await js(`document.querySelector('.release-row').dataset.key`);
await tap('.release-row', { index: 0, wait: 25000, after: 1200 });
await until(`${REAL('.btn-watch')}`, 20000);
await tap('.appbar [title="Ещё"]', { after: 700 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) .menu-item, .backdrop:not(.closing) button', { text: 'Поделиться', after: 2000 });
const top2 = topActivity();
check('«Поделиться» — системное меню Android', /intentresolver|ChooserActivity|ResolverActivity/i.test(top2), top2);
screenshot('links-share');
await back();
await sleep(800);
check('после меню — снова приложение', topActivity().startsWith(PKG), topActivity());
// «Скопировать ссылку» — без ошибок и с подтверждением
if (await js(`!!document.querySelector('.backdrop:not(.closing)')`)) await back();
await tap('.appbar [title="Ещё"]', { after: 700 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) .menu-item, .backdrop:not(.closing) button', { text: 'Скопировать ссылку', after: 900 });
check('«Скопировать ссылку» — «Скопировано»', !!(await until(`/Скопировано/.test(document.body.textContent)`, 3000)));
const clip = sh('cmd clipboard get-primary-clip 2>/dev/null || true');
if (/anix|https?:/i.test(clip)) check('в буфере обмена — ссылка', true, clip.trim().slice(0, 60));

// Ссылки на Anixart: приложение закрыто — ссылка на аниме открывает его страницу
const screenNow = () => js(`document.querySelector('#viewport > .screen')?.dataset.screen || ''`);
sh(`am force-stop ${PKG}`);
await launch({ link: `https://anixart.tv/release/${relId}` });
check('ссылка anixart.tv/release/… запускает приложение на странице аниме', !!(await until(`document.querySelector('#viewport > .screen')?.dataset.screen === 'release' && !!document.querySelector('.btn-watch, .screen h1')`, 20000)), await screenNow());
await back();
check('«Назад» — на Главную', !!(await until(`document.querySelector('#viewport > .screen')?.dataset.screen === 'tab:home'`, 5000)), await screenNow());
// приложение открыто — anixart://profile?id=… приходит в него же
await js('window.__mark = 2');
sh(`am start -W -a android.intent.action.VIEW -d 'anixart://profile?id=1' ${PKG}`);
check('anixart://profile?id=… в открытом приложении — профиль', !!(await until(`document.querySelector('#viewport > .screen')?.dataset.screen === 'profile'`, 10000)) && await js('window.__mark === 2'), await screenNow());
await back();
// ссылка в тексте (комментарий, описание) — в приложении, не в браузере
await js(`(() => { const a = document.createElement('a'); a.href = 'https://mirror.anixart-app.com/collection/1'; a.target = '_blank'; a.textContent = 'коллекция'; document.querySelector('#viewport .screen').append(a); a.click(); return 1; })()`);
await sleep(1500);
check('ссылка на коллекцию в тексте — экран коллекции в приложении', await screenNow() === 'collection' && topActivity().startsWith(PKG), `${await screenNow()} ${topActivity()}`);
check('ссылка не на экран (anixart.tv/tg) — не перехватывается', await js(`import('/js/links.js').then(({ appLink }) => appLink('https://anixart.tv/tg') === null && appLink('https://evil.example/release/1') === null)`));
// «Открывать ссылки Anixart здесь» в настройках — системный экран «Открывать по умолчанию»
await back();
await tap('[title="Настройки"]', { after: 900 });
await tap('.settings-tab[data-section="advanced"]');
await tap('.settings-body .menu-item', { text: 'Открывать ссылки Anixart здесь', after: 2000 });
check('«Открывать ссылки Anixart здесь» — настройки Android', /settings/i.test(topActivity()), topActivity());
sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1000);
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('links');
