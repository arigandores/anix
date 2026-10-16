// AudioWorklet «Выравнивать громкость» (audio.js): компрессор без заглядывания вперёд — в отличие от
// DynamicsCompressorNode Chromium (всегда 6 мс задержки). Мягкое колено и сглаживание ослабления по
// Giannoulis, Massberg, Reiss (2012). Детектор — средняя громкость (RMS за ~20 мс) обоих каналов вместе: реагирует
// на громкость сцены, а не на отдельные пики, и стерео не плывёт. Пики, которые проскакивают за время атаки,
// срезает мягкое ограничение на выходе цепочки.
class Leveler extends AudioWorkletProcessor {
  constructor({ processorOptions: o }) {
    super();
    this.t = o.threshold; this.r = o.ratio; this.w = o.knee;
    this.avg = Math.exp(-1 / (o.rms * sampleRate));
    this.att = Math.exp(-1 / (o.attack * sampleRate));
    this.rel = Math.exp(-1 / (o.release * sampleRate));
    this.p = 0; // средний квадрат
    this.y = 0; // сглаженное ослабление, дБ
  }

  process([inp], [out]) {
    const L = inp[0];
    if (!L) return true; // ветка отсоединена — тишина
    const R = inp[1] || L; const oL = out[0]; const oR = out[1] || oL;
    const { t, r, w, avg, att, rel } = this; let { p, y } = this;
    for (let i = 0; i < L.length; i++) {
      p = avg * p + (1 - avg) * 0.5 * (L[i] * L[i] + R[i] * R[i]);
      const xd = p > 1e-12 ? 10 * Math.log10(p) : -120;
      const d = xd - t;
      const yd = 2 * d < -w ? xd : 2 * d > w ? t + d / r : xd + ((1 / r - 1) * (d + w / 2) ** 2) / (2 * w);
      const c = xd - yd; // нужное ослабление, дБ
      y = c > y ? att * y + (1 - att) * c : rel * y + (1 - rel) * c;
      const gn = 10 ** (-y / 20);
      oL[i] = L[i] * gn; oR[i] = R[i] * gn;
    }
    this.p = p; this.y = y;
    return true;
  }
}
registerProcessor('anix-leveler', Leveler);
