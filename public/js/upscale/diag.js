// Диагностика движка апскейла на телефоне (anixdesktop://upscale-diag → app.js): модели в разных раскладках ядра
// свёртки (веса в uniform или storage, размер рабочей группы, пикселей на поток, счёт в f16/f32) на кадре-текстуре;
// время и ошибки WebGPU — в журнал телефона (adb logcat -s AnixWeb). Нужна, чтобы подобрать ядро под мобильные
// видеокарты: на Adreno раскладка с ПК считала кадр секундами. Каждый вариант сначала — на маленьком кадре, медленный
// дальше не гоняется (иначе драйвер сбрасывает видеокарту)
import { getGpu, loadModel, createUpscaler } from './engine.js';

const VARIANTS = [
  { name: 'вшитые 16x16 PX2 CC2', kernel: { bake: true } },
  { name: 'вшитые 8x8 PX2', kernel: { bake: true, BW: 8, BH: 8 } },
  { name: 'вшитые 8x8 PX1', kernel: { bake: true, BW: 8, BH: 8, PX: 1 } },
  { name: 'вшитые 16x8 PX1 CC4', kernel: { bake: true, BW: 16, BH: 8, PX: 1, CC: 4 } },
  { name: 'вшитые 8x8 PX4', kernel: { bake: true, BW: 8, BH: 8, PX: 4 } },
  { name: 'ПК (uniform, 16x16, PX2, CC2)', kernel: {} },
  { name: 'storage', kernel: { noUniform: true } },
  { name: 'storage 8x8', kernel: { noUniform: true, BW: 8, BH: 8 } },
  { name: 'storage 8x8 PX1', kernel: { noUniform: true, BW: 8, BH: 8, PX: 1 } },
  { name: 'storage 16x8 PX2 CC1', kernel: { noUniform: true, BW: 16, BH: 8, CC: 1 } },
  { name: 'uniform 8x8 PX1 COB2', kernel: { BW: 8, BH: 8, PX: 1, COB: 2 } },
];
const SIZES = [[320, 180], [854, 480], [1280, 720]];

export async function runDiag(log = (m) => window.__anixLog?.(m)) {
  // Anime4K M фрагментными шейдерами WebGL2 (anime4k-gl.js) — путь мобильных плееров
  try {
    const { createAnime4K } = await import('../anime4k-gl.js');
    for (const [name, chain] of [['M', ['Anime4K_Upscale_CNN_x2_M.glsl']], ['RestoreS+M', ['Anime4K_Restore_CNN_S.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl']], ['RestoreM+M', ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl']]]) {
      const a = createAnime4K(document.createElement('video'), { chain, sharpen: 'rcas' });
      for (const [w, h] of [[854, 480], [1280, 720]]) log(`diag anime4k-gl ${name} ${w}x${h}: ${(await a.bench(w, h, 7)).toFixed(1)} мс`);
      a.dispose();
      await new Promise((ok) => setTimeout(ok, 500));
    }
    log('diag: anime4k готово');
  } catch (e) { log(`diag anime4k-gl: ошибка ${e && e.message}`); }
  const { device, f16 } = await getGpu();
  log(`diag: старт, shader-f16=${f16}`);
  const makeTex = (w, h) => {
    const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d');
    const g = cx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2c49b'); g.addColorStop(1, '#2b4c7e');
    cx.fillStyle = g; cx.fillRect(0, 0, w, h); cx.strokeStyle = '#111'; cx.lineWidth = 3;
    for (let i = 0; i < 10; i++) { cx.beginPath(); cx.arc(w / 2, h / 2, 10 + i * h / 22, 0, 6.2); cx.stroke(); }
    const t = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    device.queue.copyExternalImageToTexture({ source: cv }, { texture: t }, [w, h]);
    return t;
  };
  for (const id of ['artcnn-c4f16', 'artcnn-c4f32', 'janai-v3-suc']) {
    const spec = await loadModel(id);
    for (const math16 of [true]) { // f32 на телефоне вдвое медленнее (первый замер)
      for (const v of VARIANTS) {
        let line = `diag ${id} ${math16 ? 'f16' : 'f32'} ${v.name}:`;
        let up = null;
        try {
          device.pushErrorScope('validation');
          up = await createUpscaler(spec, { input: 'texture', kernel: v.kernel, math16 });
          for (const [w, h] of SIZES) {
            const tex = makeTex(w, h);
            up.setSize(w, h);
            const once = async () => {
              const e = device.createCommandEncoder(); up.encode(e, tex);
              const t0 = performance.now(); device.queue.submit([e.finish()]);
              await device.queue.onSubmittedWorkDone();
              return performance.now() - t0;
            };
            await once(); // прогрев (компиляция)
            await new Promise((ok) => setTimeout(ok, 150));
            const ts = []; for (let i = 0; i < 3; i++) { ts.push(await once()); await new Promise((ok) => setTimeout(ok, 120)); }
            tex.destroy();
            ts.sort((a, b) => a - b);
            line += ` ${w}x${h}=${ts[1].toFixed(1)}мс`;
            if (ts[1] > 60) { line += ' (дальше не гоняю)'; break; }
          }
          const err = await device.popErrorScope();
          if (err) line += ` ОШИБКА ${err.message.slice(0, 160)}`;
        } catch (e) {
          line += ` ИСКЛЮЧЕНИЕ ${String(e && e.message || e).slice(0, 160)}`;
          try { await device.popErrorScope(); } catch { /* уже снят */ }
        } finally { up?.destroy(); }
        log(line);
        await new Promise((ok) => setTimeout(ok, 300));
      }
    }
  }
  log('diag: готово');
}
