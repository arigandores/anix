// Улучшение звука во встроенном плеере (Web Audio, встроенные блоки Chromium) — три переключателя:
//   Выравнивать громкость — тихие реплики громче, взрывы и крики тише
//   Чёткий голос          — голос озвучки (он по центру стерео) поднимается над музыкой и эффектами
//   Объёмный звук         — виртуальные колонки вокруг слушателя в наушниках (HRTF)
// Пока всё выключено, звук идёт обычным путём <video> (с родной синхронизацией с картинкой), Web Audio спит.
// Задержка обработки — ноль: фильтры, свёртка и мягкое ограничение её не добавляют. Готовые узлы Chromium, которые
// задерживают звук на 6 мс (DynamicsCompressorNode и HRTF в PannerNode), заменены: выравнивание — свой AudioWorklet
// без заглядывания вперёд (audio-leveler.js), объёмный звук — тот же HRTF Chromium, снятый один раз в свёртку.
// Выключенные ветки отсоединяются целиком и не тратят процессор.
import { prefs } from './store.js';

export const AUDIO_OPTS = [
  { key: 'level', pref: 'AUDIO_LEVEL', icon: 'ic_audio', short: 'Громкость', label: 'Выравнивать громкость', sub: 'Тихие реплики громче, взрывы и крики тише' },
  { key: 'voice', pref: 'AUDIO_VOICE', icon: 'ic_voice', short: 'Голос', label: 'Чёткий голос', sub: 'Озвучка разборчивее на фоне музыки и эффектов' },
  { key: 'surround', pref: 'AUDIO_SURROUND', icon: 'ic_headphones', short: 'Объёмный', label: 'Объёмный звук', sub: 'Для наушников: звук вокруг, а не внутри головы' },
];

const db = (x) => 10 ** (x / 20);
// Громкость сочетаний выровнена по «всё выключено» (test/audio.js): лучше должно быть звучание, а не просто громче.
// Выравнивание: громкое остаётся примерно как было, тихое поднимается.
// Порог по средней громкости (RMS): речь около −24 дБ становится на 4 дБ громче, шёпот −40 дБ — на 10 дБ,
// громкая сцена −16 дБ — на 2 дБ тише, взрыв −10 дБ — на 6 дБ тише.
const LEVEL = { threshold: -32, knee: 12, ratio: 4, rms: 0.02, attack: 0.01, release: 0.25, makeup: 10 };
const VOICE = { presence: 5.5, low: -4, mid: 1.4, side: 0.45, trim: -4.5 }; // разборчивость 2,8 кГц, меньше гула, центр громче боков
const SURROUND_TRIM = -2; // виртуальные колонки и комната собирают больше энергии, чем стерео
const ROOM = 0.25; // доля «комнаты» в объёмном звуке (её отклик нормирован по энергии)
const FADE = 0.03; // постоянная времени переключений, с: без щелчков
const LEVELER_URL = new URL('./audio-leveler.js', import.meta.url).href;

// Короткая «комната» для объёмного звука: без неё виртуальные колонки звучат внутри головы
function roomIR(sr, sec = 0.45) {
  const n = Math.floor(sr * sec); const pre = Math.floor(sr * 0.006);
  return [16807, 48271].map((s0) => {
    const d = new Float32Array(n); let seed = s0; let e = 0;
    for (let i = pre; i < n; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-(i - pre) / (sr * 0.09)) * (1 - i / n);
      e += d[i] * d[i];
    }
    const k = 1 / Math.sqrt(e); for (let i = 0; i < n; i++) d[i] *= k;
    return d;
  });
}

// Отклик встроенного HRTF Chromium для колонки под углом deg: PannerNode задерживает звук на ~6 мс, ConvolverNode — нет.
// Снимаем отклики офлайн, срезаем общую задержку (разница между ушами остаётся) и отдаём свёрткам.
async function speakerIRs(sr) {
  const LEN = 1024; const KEEP = 512;
  const one = async (deg) => {
    const c = new OfflineAudioContext(2, LEN, sr); const a = (deg * Math.PI) / 180;
    const b = c.createBuffer(1, LEN, sr); b.getChannelData(0)[0] = 1;
    const s = new AudioBufferSourceNode(c, { buffer: b });
    s.connect(new PannerNode(c, {
      panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 0,
      positionX: Math.sin(a), positionY: 0, positionZ: -Math.cos(a), channelCount: 1, channelCountMode: 'explicit',
    })).connect(c.destination);
    s.start();
    const o = await c.startRendering();
    return [o.getChannelData(0), o.getChannelData(1)];
  };
  const hs = await Promise.all([-30, 30, -110, 110].map(one));
  let mx = 0; for (const h of hs) for (const ch of h) for (const v of ch) mx = Math.max(mx, Math.abs(v));
  let on = LEN; for (const h of hs) for (const ch of h) for (let i = 0; i < on; i++) if (Math.abs(ch[i]) > mx * 0.01) { on = i; break; }
  on = Math.max(0, on - 4); // запас в 4 сэмпла на нарастание
  const [fl, fr, rl, rr] = hs.map((h) => h.map((ch) => ch.slice(on, on + KEEP)));
  return { fl, fr, rl, rr };
}

// Цепочка: input → голос (эквалайзер, центр/бока) → стерео или виртуальные колонки → выравнивание или напрямую → мягкое ограничение.
// Отдельно от <video>, чтобы проверять её на OfflineAudioContext (test/audio.js).
export async function buildChain(ctx) {
  const sr = ctx.sampleRate;
  const [hrir] = await Promise.all([speakerIRs(sr), ctx.audioWorklet.addModule(LEVELER_URL)]);
  const g = (v = 1) => new GainNode(ctx, { gain: v });
  const input = g(1);
  const low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 160, gain: 0 });
  const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2800, Q: 0.8, gain: 0 });
  input.connect(low).connect(presence);

  // центр M = (L+R)/2 и бока S = (L−R)/2; L' = M + S, R' = M − S
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  presence.connect(split);
  const mid = g(0.5); const side = g(0.5); const rNeg = g(-1);
  split.connect(mid, 0); split.connect(mid, 1);
  split.connect(side, 0); split.connect(rNeg, 1); rNeg.connect(side);
  const left = g(1); const right = g(1); const sideNeg = g(-1);
  mid.connect(left); side.connect(left);
  mid.connect(right); side.connect(sideNeg).connect(right);
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  left.connect(merge, 0, 0); right.connect(merge, 0, 1);

  const spatial = g(1);
  const stereoBus = g(1); merge.connect(stereoBus).connect(spatial);

  // Виртуальные колонки — три свёртки: фронт ±30° (с комнатой на своей стороне) и тылы ±110°. Тылам идут бока стерео
  // через 12 мс и без верхов; правый тыл — левый с обратным знаком, поэтому оба уха тылов — одна свёртка.
  const room = roomIR(sr);
  const ir = (chans) => {
    const n = Math.max(...chans.map((c) => c.length)); const b = ctx.createBuffer(2, n, sr);
    chans.forEach((c, i) => b.getChannelData(i).set(c));
    return new ConvolverNode(ctx, { buffer: b, disableNormalization: true });
  };
  const withRoom = (h, r) => { const o = new Float32Array(r.length); o.set(h); for (let i = 0; i < r.length; i++) o[i] += ROOM * r[i]; return o; };
  const rearDelay = Math.round(0.012 * sr);
  const rearIR = [0, 1].map((e) => { const o = new Float32Array(rearDelay + hrir.rl[e].length); for (let i = 0; i < hrir.rl[e].length; i++) o[rearDelay + i] = 0.7 * (hrir.rl[e][i] - hrir.rr[e][i]); return o; });
  const fl = ir([withRoom(hrir.fl[0], room[0]), hrir.fl[1]]);
  const fr = ir([hrir.fr[0], withRoom(hrir.fr[1], room[1])]);
  const rearLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.5 });
  const rear = ir(rearIR);
  const surroundBus = g(0); surroundBus.connect(spatial);
  fl.connect(surroundBus); fr.connect(surroundBus); rearLp.connect(rear).connect(surroundBus);

  // выравнивание громкости — своей веткой рядом с прямой
  const leveler = new AudioWorkletNode(ctx, 'anix-leveler', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: LEVEL,
  });
  const levelBus = g(0); leveler.connect(levelBus);
  const dryBus = g(1); spatial.connect(dryBus);

  // мягкое ограничение: вход делится на 2, чтобы кривая покрывала пики до +6 дБ
  const makeup = g(1);
  const clip = g(0.5);
  const shaper = new WaveShaperNode(ctx, { curve: clipCurve(), oversample: 'none' });
  levelBus.connect(makeup); dryBus.connect(makeup);
  makeup.connect(clip).connect(shaper);
  const output = g(1); shaper.connect(output);

  // Ветка, которую отсоединяем целиком, когда она выключена: сначала гасим её шину, потом рвём провода
  function branch(wires, bus) {
    let on = false; let timer = 0;
    return (want, level, instant) => {
      clearTimeout(timer);
      if (want && !on) for (const [a, b] of wires) a.connect(b); // повторное connect того же провода ничего не меняет
      on = want;
      if (instant) bus.gain.value = want ? level : 0; else bus.gain.setTargetAtTime(want ? level : 0, ctx.currentTime, FADE);
      if (!want) {
        const cut = () => { if (!on) for (const [a, b] of wires) { try { a.disconnect(b); } catch { /* уже */ } } };
        if (instant) cut(); else timer = setTimeout(cut, FADE * 6000);
      }
    };
  }
  const surroundBranch = branch([[left, fl], [right, fr], [side, rearLp]], surroundBus);
  const levelBranch = branch([[spatial, leveler]], levelBus);

  // o = { level, voice, surround }
  function apply(o, instant = false) {
    const t = ctx.currentTime;
    const set = (param, v) => { if (instant) param.value = v; else param.setTargetAtTime(v, t, FADE); };
    set(low.gain, o.voice ? VOICE.low : 0);
    set(presence.gain, o.voice ? VOICE.presence : 0);
    set(mid.gain, 0.5 * (o.voice ? VOICE.mid : 1));
    set(side.gain, 0.5 * (o.voice ? VOICE.side : 1));
    set(stereoBus.gain, o.surround ? 0 : 1);
    surroundBranch(!!o.surround, db(SURROUND_TRIM), instant);
    set(dryBus.gain, o.level ? 0 : 1);
    levelBranch(!!o.level, 1, instant);
    set(makeup.gain, db(o.level ? LEVEL.makeup : o.voice ? VOICE.trim : 0)); // с выравниванием громкость голоса держит оно
  }
  apply({}, true);
  return { input, output, apply };
}

// Мягкое ограничение вместо лимитера: без заглядывания вперёд, значит без задержки. Кривая для входа, поделённого
// на 2: до −2 дБ без изменений, выше — плавно к 0 дБ (за краем WaveShaper режет жёстко).
function clipCurve() {
  const n = 2049; const curve = new Float32Array(n); const knee = db(-2);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2; const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return curve;
}

// Звук забираем через video.captureStream(), а не createMediaElementSource: тот забирает звук у <video> навсегда,
// и браузер перестаёт подгонять его под картинку (на замере звук отставал на 35–38 мс, и выключение переключателей
// это не убирало). Захват продолжает идти при заглушённом элементе: пока улучшение включено, <video> молчит, а
// звучит обработка; выключили — элемент снова звучит сам, с родной синхронизацией, а Web Audio засыпает.
// Захваченный звук приходит раньше картинки: по замерам (test/audio.js) после задержки в 15 мс он оказывался то на 2 мс
// раньше, то на 15 мс позже — разброс от запуска к запуску. 10 мс ставят середину в ноль: остаётся примерно ±9 мс.
const SYNC = 0.01;

// Звук плеера: переключатели общие для всех серий (prefs AUDIO_LEVEL / AUDIO_VOICE / AUDIO_SURROUND).
// Громкость и mute плеера — тоже здесь: пока звучит обработка, их задаёт она, а не <video>.
export function createAudioFx({ video, onError, onVolume }) {
  let ctx = null; let chain = null; let delay = null; let out = null; let building = null; let dead = false;
  let stream = null; let track = null; let node = null; let routed = null;
  let volume = video.volume; let muted = video.muted;
  const st = Object.fromEntries(AUDIO_OPTS.map((x) => [x.key, !!prefs.get(x.pref)]));
  const active = () => AUDIO_OPTS.some((x) => st[x.key]);

  function ensure() {
    building ||= (async () => {
      const c = new AudioContext({ latencyHint: 'interactive' }); // самый короткий буфер вывода
      try {
        const ch = await buildChain(c);
        if (dead) { c.close().catch(() => {}); return false; }
        delay = new DelayNode(c, { delayTime: SYNC });
        out = new GainNode(c, { gain: 0 });
        delay.connect(ch.input); ch.output.connect(out).connect(c.destination);
        ctx = c; chain = ch;
        return true;
      } catch (e) {
        c.close().catch(() => {});
        building = null;
        for (const x of AUDIO_OPTS) st[x.key] = false;
        onError?.(e);
        return false;
      }
    })();
    return building;
  }
  // аудиодорожка захвата: при смене источника (качество, повтор после ошибки) появляется новая, старая замолкает
  function bind(t) {
    if (t === track) return;
    if (node) node.disconnect();
    if (track) track.stop();
    track = t;
    node = new MediaStreamAudioSourceNode(ctx, { mediaStream: new MediaStream([t]) }); // свежий буфер — ровная синхронизация
    node.connect(delay);
  }
  const onAddTrack = (e) => { if (e.track.kind === 'audio') bind(e.track); };
  function capture(on) {
    if (on && !stream) {
      stream = video.captureStream();
      stream.addEventListener('addtrack', onAddTrack);
      const t = stream.getAudioTracks().at(-1); if (t) bind(t);
    } else if (!on && stream) {
      stream.removeEventListener('addtrack', onAddTrack);
      for (const t of stream.getTracks()) t.stop();
      if (node) node.disconnect();
      stream = null; track = null; node = null;
    }
  }
  // кто звучит: обработка (элемент молчит, громкость — на выходе Web Audio) или сам <video>
  function output() {
    const fx = routed === 'fx';
    video.muted = fx || muted;
    video.volume = fx ? 1 : volume;
    if (out) out.gain.value = fx && !muted ? volume : 0;
    onVolume?.();
  }
  async function route() {
    if (!building && !active()) return; // ни разу не включали — Web Audio не создаём
    if (!(await ensure()) || dead) return;
    chain.apply(st, routed === null);
    const want = active() ? 'fx' : 'off';
    if (want !== routed) {
      routed = want;
      if (want === 'fx') { await ctx.resume().catch(() => {}); capture(true); } else capture(false);
      output();
      if (want === 'off') ctx.suspend().catch(() => {}); // выключено — процессор не тратим
    }
  }
  const onPlay = () => { if (ctx && routed === 'fx' && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
  video.addEventListener('play', onPlay);
  route();

  return {
    get: (key) => st[key],
    any: active,
    set(key, on) {
      const o = AUDIO_OPTS.find((x) => x.key === key);
      st[key] = !!on; prefs.set(o.pref, !!on);
      return route();
    },
    get volume() { return volume; },
    get muted() { return muted; },
    setVolume(v) { volume = Math.min(1, Math.max(0, v)); muted = volume === 0; output(); },
    setMuted(m) { muted = !!m; output(); },
    debug: () => ({ ctx, chain, out, routed, track }), // для тестов
    destroy() {
      dead = true;
      video.removeEventListener('play', onPlay);
      if (stream) capture(false);
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    },
  };
}
