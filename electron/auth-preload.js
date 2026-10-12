'use strict';
// Окно соцвхода выдаёт себя за Firefox (AUTH_UA в main.js). У Firefox нет client hints Chromium —
// убираем navigator.userAgentData, иначе Google видит несоответствие и блокирует вход.
try { delete Navigator.prototype.userAgentData; } catch { /* ignore */ }
