# Как выпустить релиз

Установщик собирает GitHub Actions (`.github/workflows/release.yml`) — локально ничего собирать не нужно.
Релиз создаётся из **аннотированного тега** `vX.Y.Z`; текст релиза — сообщение этого тега.

## Шаги

1. **Версия.** В `package.json` поднимите `version` (например, `1.4.0`), закоммитьте и запушьте в `main`:

   ```
   git commit -am "Anix Desktop 1.4.0"
   git push public main
   ```

2. **Заметки к релизу.** Напишите их в файл, например `notes.md` (Markdown, как в прошлых релизах: что нового,
   как установить, про SmartScreen). Файл в репозиторий не добавляйте.

3. **Тег.** Версия в теге должна совпадать с `package.json`, иначе сборка остановится:

   ```
   git tag -a v1.4.0 -F notes.md
   git push public v1.4.0
   ```

4. **Готово.** Через 5–10 минут (25–30, если менялся `trt/`) в
   [Releases](https://github.com/arigandores/anix-desktop/releases) появится «Anix Desktop 1.4.0» с
   `AnixDesktop-Setup-1.4.0.exe` и текстом из тега. Ход сборки — во вкладке
   [Actions](https://github.com/arigandores/anix-desktop/actions/workflows/release.yml).

## Что делает сборка

- проверяет, что тег совпадает с версией в `package.json`;
- ставит зависимости и Electron;
- `anix-trt.exe` (ускорение NVIDIA): берёт из кэша, а если менялся `trt/` — ставит CUDA Toolkit 13.1 и собирает
  заново (на образе `windows-2022`: nvcc 13.1 не принимает Visual Studio 2026);
- кладёт ключи из секрета `CONFIG_LOCAL_JSON` в `config.local.json` — без секрета релиз не выпускается;
- собирает установщик (`npm run build:release`) и выкладывает его в релиз.

## Пробная сборка без релиза

Actions → Release → **Run workflow** (ветка `main`). Установщик появится в артефактах запуска (хранится 14 дней),
релиз не создаётся. Или из консоли: `gh workflow run release.yml --ref main`.

## Ключи (секрет `CONFIG_LOCAL_JSON`)

Это весь `config.local.json` целиком (Kodik, StudioMir, VK Видео, соцвход, Discord). Поменяли ключи локально —
обновите секрет:

```
gh secret set CONFIG_LOCAL_JSON -R arigandores/anix-desktop < config.local.json
```

Ключи попадают внутрь установщика — секрет лишь не даёт им попасть в репозиторий.

## Если что-то пошло не так

- **Ошибка в сборке** — исправьте, запушьте в `main`, удалите тег и поставьте заново:

  ```
  git push public :refs/tags/v1.4.0
  git tag -d v1.4.0
  git tag -a v1.4.0 -F notes.md
  git push public v1.4.0
  ```

- **Опечатка в тексте релиза** — правится прямо на GitHub (Edit release), пересобирать не нужно.
