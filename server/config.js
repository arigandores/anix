'use strict';
// Ключи сторонних сервисов (Kodik, StudioMir, VK Видео, соцвход) в репозитории не хранятся.
// Они читаются из первого найденного файла:
//   1. путь из переменной ANIX_CONFIG
//   2. config.local.json в корне приложения (его кладёт в сборку build/release.js)
//   3. ~/.anixart-desktop/config.json
// Формат — config.example.json. Без ключа соответствующий источник или способ входа недоступен.
const fs = require('fs');
const os = require('os');
const path = require('path');

function load() {
  const candidates = [
    process.env.ANIX_CONFIG,
    path.join(__dirname, '..', 'config.local.json'),
    path.join(os.homedir(), '.anixart-desktop', 'config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return { file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* следующий */ }
  }
  return { file: null };
}

const config = load();
const get = (p) => p.split('.').reduce((o, k) => (o && o[k] != null && o[k] !== '' ? o[k] : null), config);

// Что доступно в этой сборке — для фронтенда (скрыть соцвход без ключей)
function features() {
  return {
    kodik: !!get('kodik.token'),
    studiomir: !!get('studiomir.apiKey'),
    vkVideo: !!(get('vkVideo.clientId') && get('vkVideo.clientSecret')),
    social: {
      google: !!(get('social.google.apiKey') && get('social.google.authHandler')),
      telegram: !!(get('social.telegram.clientId') && get('social.telegram.redirectUri')),
      vk: !!get('social.vk.clientId'),
      yandex: !!get('social.yandex.clientId'),
    },
  };
}

module.exports = { get, features, file: config.file };
