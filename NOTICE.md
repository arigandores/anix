# Сторонние компоненты и товарные знаки

Код Anix распространяется по лицензии MIT (`LICENSE`). Сторонние компоненты — по своим лицензиям:

| Компонент | Где | Лицензия |
|---|---|---|
| Google Sans Medium (Google) | `public/fonts/` | SIL Open Font License 1.1 — `public/fonts/OFL.txt` |
| Material Symbols Rounded (Google) | `public/icons/` (интерфейс) | Apache License 2.0 |
| Simple Icons | `public/icons/ic_vk, ic_telegram, ic_google, ic_discord, ic_tiktok` | CC0 1.0; логотипы — товарные знаки их владельцев |
| Логотип, иконка приложения, флаги, значок Яндекса | `public/icons/`, `build/icon.svg` | нарисованы для Anix, MIT |
| hls.js 1.7.3 | `public/vendor/hls.min.js` | Apache License 2.0 |
| MQTT.js 5.16.1 | `public/vendor/mqtt.min.js` (совместный просмотр) | MIT |
| lottie-web 5.13.0 (Airbnb), сборка light | `public/vendor/lottie_light.min.js` (анимации интерфейса; сами анимации — `public/lottie`, сцены — `tools/lottie-studio`) | MIT |
| text-to-lottie player (Diffusion Studio) | `tools/lottie-studio` (редактор и проверка анимаций, в сборку не входит) | MIT |
| ArtCNN (Joao Chrisostomo, Kacper Michajłow) | `public/models/upscale/artcnn-*` | MIT |
| 2x AnimeJaNai HD V3.1, HD V3 (Compact / UltraCompact / SuperUltraCompact), SD Compact (the-database, github.com/the-database/mpv-upscale-2x_animejanai) | `public/models/upscale/janai-*`, `public/models/upscale-onnx/janai-*` (веса переложены в формат движка — под той же лицензией) | CC BY-NC-SA 4.0 — только некоммерческое использование |
| 2x AniSD G6i1 SPAN и AniSD AC (Sirosky, github.com/Sirosky/Upscale-Hub) | `public/models/upscale/anisd-*`, `public/models/upscale-onnx/anisd-*` | CC BY-NC 4.0 — только некоммерческое использование |
| NVIDIA TensorRT for RTX 1.7 | не входит в сборку: по кнопке «Установить» скачивается с PyPI (`tensorrt_rtx_cu13_libs`) в папку данных приложения | лицензия NVIDIA (проприетарная) |
| NVIDIA CUDA Runtime | статически в `anix-trt.exe` | лицензия NVIDIA CUDA Toolkit (распространение рантайма разрешено) |
| Agent Client Protocol SDK, claude-agent-acp | `node_modules` (в сборке) | Apache License 2.0 |
| Claude Agent SDK (Anthropic) | `node_modules` (в сборке) | Anthropic Commercial Terms of Service |
| Electron | сборка Windows | MIT |

**Товарные знаки.** Anixart, его название, логотип и тексты интерфейса принадлежат их правообладателям.
Anix — независимый неофициальный проект, не связанный с разработчиками Anixart и не одобренный ими.
Каталог, аккаунты и комментарии предоставляет сервис Anixart; видео — сторонние источники (Kodik, Sibnet и др.).
Claude — товарный знак Anthropic.
