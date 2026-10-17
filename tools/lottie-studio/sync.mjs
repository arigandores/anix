// Сцены плеера → приложение: public/projects/anix-ui/<имя>-<N>/lottie.json копируется (сжатым) в
// ../../public/lottie/<имя>.json. Сцены — единственный источник анимаций: правятся скиллом text-to-lottie
// и проверяются в этом плеере (npm run dev), после правки — node sync.mjs.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'public', 'projects', 'anix-ui');
const out = join(here, '..', '..', 'public', 'lottie');

for (const scene of readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
  const file = join(src, scene, 'lottie.json');
  if (!existsSync(file)) continue;
  const name = scene.replace(/-\d+$/, '');
  const json = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(join(out, `${name}.json`), json);
  console.log(`${scene} → public/lottie/${name}.json  ${(json.length / 1024).toFixed(1)} КБ`);
}
