// Лендинг Anix: прямые ссылки на файлы последнего релиза (GitHub API), звёзды, скриншоты, сравнение до/после.
// Без JS и при ошибке API кнопки ведут на страницу последнего релиза — там всегда актуальные файлы.
(() => {
  'use strict';
  const REPO = 'arigandores/anix';
  const API = 'https://api.github.com/repos/' + REPO;
  const CACHE_KEY = 'anix-site-release-v2'; // v2 — файл платформы из последнего релиза, где он есть
  const CACHE_MS = 30 * 60 * 1000; // без входа GitHub отвечает одному адресу до 60 раз в час
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.documentElement.classList.add('js');

  /* ---------- Релиз ---------- */
  const store = {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(CACHE_KEY));
        return v && Date.now() - v.at < CACHE_MS ? v.data : null;
      } catch { return null; }
    },
    set(data) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* приватный режим */ }
    },
  };

  const isInstaller = (n) => /\.exe$/i.test(n);
  const isApk = (n) => /\.apk$/i.test(n);

  async function fetchJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  }

  async function loadRelease() {
    const cached = store.get();
    if (cached) return cached;
    const [releases, repo] = await Promise.all([
      fetchJson(API + '/releases?per_page=100'),
      fetchJson(API).catch(() => null),
    ]);
    const published = releases.filter((r) => !r.draft && !r.prerelease); // GitHub отдаёт от новых к старым
    const latest = published[0];
    if (!latest) throw new Error('нет опубликованных релизов');
    // Релиз бывает не для всех платформ («Платформы» в тексте тега, release.yml): файл платформы — из последнего
    // релиза, где он есть, а не только из самого свежего
    const pick = (test) => {
      for (const r of published) {
        const a = r.assets.find((x) => test(x.name));
        if (a) return { url: a.browser_download_url, name: a.name, size: a.size };
      }
      return null;
    };
    let downloads = 0;
    for (const r of releases) for (const a of r.assets) if (isInstaller(a.name) || isApk(a.name)) downloads += a.download_count;
    const data = {
      version: latest.tag_name.replace(/^v/, ''),
      date: latest.published_at,
      page: latest.html_url,
      win: pick(isInstaller),
      apk: pick(isApk),
      downloads,
      stars: repo ? repo.stargazers_count : null,
    };
    store.set(data);
    return data;
  }

  const nf = new Intl.NumberFormat('ru-RU');
  const plural = new Intl.PluralRules('ru-RU');
  const words = { one: 'скачивание', few: 'скачивания', many: 'скачиваний', other: 'скачивания' };
  const mb = (b) => (b >= 100 * 1024 * 1024 ? Math.round(b / 1048576) : (b / 1048576).toFixed(1).replace('.', ',')) + ' МБ';
  const day = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  function applyRelease(d) {
    $$('[data-version]').forEach((el) => { el.textContent = d.version; });
    $$('[data-date]').forEach((el) => { el.textContent = d.date ? ' · ' + day(d.date) : ''; });
    $$('[data-release-link]').forEach((el) => { el.href = d.page; });
    for (const kind of ['win', 'apk']) {
      const a = d[kind];
      if (!a) continue; // файла нет в релизе — кнопка остаётся на странице релиза
      $$(`[data-dl="${kind}"]`).forEach((el) => {
        el.href = a.url;
      });
      $$(`[data-dl-meta="${kind}"]`).forEach((el) => { el.textContent = a.name + ' · ' + mb(a.size); });
    }
    if (d.stars != null) {
      $$('[data-stars]').forEach((el) => { $('span', el).textContent = nf.format(d.stars); el.hidden = false; });
    }
    if (d.downloads >= 100) { // маленький счётчик не показываем — он скорее отпугивает
      const li = $('[data-downloads]');
      if (li) { $('span', li).textContent = nf.format(d.downloads) + ' ' + words[plural.select(d.downloads)]; li.hidden = false; }
    }
  }

  loadRelease().then(applyRelease).catch((e) => console.warn('[anix-site] релиз не загрузился, ссылки ведут на страницу релиза:', e));

  /* ---------- Платформа посетителя ---------- */
  const ua = navigator.userAgent;
  const onAndroid = /Android/i.test(ua);
  const onWindows = /Windows/i.test(ua);
  if (onAndroid) {
    // На телефоне первым — APK
    const row = $('[data-cta-row]');
    const apk = row && $('[data-dl="apk"]', row);
    const win = row && $('[data-dl="win"]', row);
    if (apk && win) {
      row.prepend(apk);
      apk.classList.replace('btn-secondary', 'btn-primary');
      win.classList.replace('btn-primary', 'btn-secondary');
    }
  }
  const suggested = onAndroid ? 'apk' : onWindows ? 'win' : null;
  if (suggested) $(`.dl-card[data-platform="${suggested}"]`)?.classList.add('suggested');

  /* ---------- Шапка ---------- */
  const nav = $('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Сравнение до/после ---------- */
  $$('[data-compare]').forEach((box) => {
    const range = $('.compare-range', box);
    const set = () => box.style.setProperty('--pos', range.value + '%');
    range.addEventListener('input', set);
    set();
  });

  /* ---------- Вкладки скриншотов ---------- */
  const tabs = $$('.seg [role="tab"]');
  function selectTab(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    updateCarousel();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      selectTab(tabs[(i + d + tabs.length) % tabs.length], true);
    });
  });
  if (onAndroid && tabs[1]) selectTab(tabs[1]);

  /* ---------- Карусель ---------- */
  const carousel = $('[data-carousel]');
  const track = carousel && $('.track', carousel);
  const prev = carousel && $('[data-prev]', carousel);
  const next = carousel && $('[data-next]', carousel);
  function updateCarousel() {
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth - 2;
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft >= max;
  }
  if (track) {
    const step = (d) => {
      const slide = $('.slide', track);
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      track.scrollBy({ left: d * (slide.offsetWidth + gap), behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    track.addEventListener('keydown', (e) => {
      if (e.target !== track) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    });
    track.addEventListener('scroll', updateCarousel, { passive: true });
    addEventListener('resize', updateCarousel);
    updateCarousel();
  }

  /* ---------- Просмотр скриншота ---------- */
  const lb = $('.lightbox');
  const lbFig = $('figure', lb);
  const lbCap = $('figcaption', lb);
  const lbImg = document.createElement('img');
  lbImg.decoding = 'async';
  lbFig.prepend(lbImg);
  let group = [];
  let index = 0;
  let opener = null;

  function show(i) {
    index = (i + group.length) % group.length;
    const el = group[index];
    lbImg.src = el.dataset.zoom;
    lbImg.alt = $('img', el)?.alt || '';
    lbCap.textContent = el.dataset.caption || '';
    const many = group.length > 1;
    $('.lb-prev', lb).hidden = !many;
    $('.lb-next', lb).hidden = !many;
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-zoom]');
    if (!el) return;
    const scope = el.closest('.track, .phones');
    group = scope ? $$('[data-zoom]', scope) : [el];
    opener = el;
    show(group.indexOf(el));
    lb.showModal();
  });
  $('.lb-close', lb).addEventListener('click', () => lb.close());
  $('.lb-prev', lb).addEventListener('click', () => show(index - 1));
  $('.lb-next', lb).addEventListener('click', () => show(index + 1));
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target === lbFig) lb.close(); });
  lb.addEventListener('keydown', (e) => {
    if (group.length < 2) return;
    if (e.key === 'ArrowRight') show(index + 1);
    if (e.key === 'ArrowLeft') show(index - 1);
  });
  lb.addEventListener('close', () => { lbImg.removeAttribute('src'); opener?.focus({ preventScroll: true }); });

  /* ---------- Проявление при прокрутке ---------- */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const items = $$('.sec-head, .feature, .card, .dl-card, .table-wrap, .faq, .final-in')
      .filter((el) => el.getBoundingClientRect().top > innerHeight); // то, что уже на экране, не прячем
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach((el, i) => {
      el.classList.add('reveal');
      if (el.classList.contains('card')) el.style.transitionDelay = (i % 3) * 60 + 'ms';
      io.observe(el);
    });
  }
})();
