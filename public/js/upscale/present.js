// Вывод апскейла на холст поверх <video>: один проход рисует итоговую картинку под размер окна.
// Цвет — из текстуры сети (rgb-модель), из VideoFrame (результат TensorRT, electron/trt.js) или из кадра видео; яркость luma-модели (ArtCNN) подмешивается
// к цвету: c + (Y' − Y(c)) — меняется только яркость, цветоразностные составляющие остаются.
// Масштаб — Catmull-Rom по 9 билинейным выборкам; при сильном уменьшении — билинейно.
// Шторка сравнения: левее split — исходный кадр (тот же кадр видео), без лишней работы для видеокарты.

const SHADER = /* wgsl */`
struct U { split: f32, flags: u32, p0: f32, p1: f32 }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var video: texture_external;
@group(0) @binding(2) var colorTex: texture_2d<f32>;
@group(0) @binding(3) var lumaTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: U;
@group(0) @binding(5) var colorExt: texture_external;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn catmull(tex: texture_2d<f32>, uv: vec2f) -> vec4f {
  let size = vec2f(textureDimensions(tex));
  let sp = uv * size;
  let t1 = floor(sp - 0.5) + 0.5;
  let f = sp - t1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (t1 - 1.0) / size; let t3 = (t1 + 2.0) / size; let t12 = (t1 + w2 / w12) / size;
  var r = vec4f(0.0);
  r += textureSampleLevel(tex, samp, vec2f(t0.x, t0.y), 0.0) * w0.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(t12.x, t0.y), 0.0) * w12.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(t3.x, t0.y), 0.0) * w3.x * w0.y;
  r += textureSampleLevel(tex, samp, vec2f(t0.x, t12.y), 0.0) * w0.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(t12.x, t12.y), 0.0) * w12.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(t3.x, t12.y), 0.0) * w3.x * w12.y;
  r += textureSampleLevel(tex, samp, vec2f(t0.x, t3.y), 0.0) * w0.x * w3.y;
  r += textureSampleLevel(tex, samp, vec2f(t12.x, t3.y), 0.0) * w12.x * w3.y;
  r += textureSampleLevel(tex, samp, vec2f(t3.x, t3.y), 0.0) * w3.x * w3.y;
  return r;
}
fn sampleUp(tex: texture_2d<f32>, uv: vec2f, down: bool) -> vec4f {
  if (down) { return textureSampleLevel(tex, samp, uv, 0.0); }
  return catmull(tex, uv);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let orig = textureSampleBaseClampToEdge(video, samp, i.uv).rgb;
  if (i.uv.x < u.split) { return vec4f(orig, 1.0); }
  var c = orig;
  if ((u.flags & 1u) != 0u) { c = sampleUp(colorTex, i.uv, (u.flags & 4u) != 0u).rgb; }
  if ((u.flags & 16u) != 0u) { c = textureSampleBaseClampToEdge(colorExt, samp, i.uv).rgb; }
  if ((u.flags & 2u) != 0u) {
    let y = sampleUp(lumaTex, i.uv, (u.flags & 8u) != 0u).r;
    c += y - dot(c, vec3f(0.2126, 0.7152, 0.0722));
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

export function createPresenter(device, canvas) {
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  // не 'opaque': непрозрачный слой поверх <video> Chromium считает перекрытием и перестаёт выводить кадры видео
  // (requestVideoFrameCallback срабатывает раз в секунду). Альфа в шейдере всё равно 1 — выглядит так же.
  ctx.configure({ device, format, alphaMode: 'premultiplied' });
  const module = device.createShaderModule({ code: SHADER });
  const pipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dummy = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const uv = new ArrayBuffer(16); const uf = new Float32Array(uv); const uu = new Uint32Array(uv);

  // color/luma: GPUTexture или null; colorFrame: VideoFrame (результат TensorRT) или null; split: 0..1 (0 — без шторки)
  function draw(encoder, video, { color = null, colorFrame = null, luma = null, split = 0 }) {
    const W = canvas.width;
    const down = (t) => !!t && t.width > W * 1.6;
    uf[0] = split;
    uu[1] = (color ? 1 : 0) | (luma ? 2 : 0) | (down(color) ? 4 : 0) | (down(luma) ? 8 : 0) | (colorFrame ? 16 : 0);
    device.queue.writeBuffer(ubuf, 0, uv);
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: samp },
      { binding: 1, resource: device.importExternalTexture({ source: video }) },
      { binding: 2, resource: (color || dummy).createView() },
      { binding: 3, resource: (luma || dummy).createView() },
      { binding: 4, resource: { buffer: ubuf } },
      { binding: 5, resource: device.importExternalTexture({ source: colorFrame || video }) },
    ] });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  }

  return {
    draw,
    destroy() { try { ctx.unconfigure(); } catch { /* холст уже убран */ } ubuf.destroy(); dummy.destroy(); },
  };
}
