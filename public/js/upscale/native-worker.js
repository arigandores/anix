// Замер «настоящего» разрешения вне главного потока (native.js): кадр видео (VideoFrame) -> яркость -> ширина контуров.
// Чтение пикселей и счёт (~10 мс на 1080p) не задерживают плеер и не попадают во время кадра апскейла.
import { edgeWidth, lumaOf } from './native.js';

let cv = null; let cx = null;
self.onmessage = ({ data: { id, frame } }) => {
  try {
    const W = frame.displayWidth; const H = frame.displayHeight;
    if (!cv || cv.width !== W || cv.height !== H) { cv = new OffscreenCanvas(W, H); cx = cv.getContext('2d', { willReadFrequently: true }); }
    cx.drawImage(frame, 0, 0, W, H);
    const r = edgeWidth(lumaOf(cx.getImageData(0, 0, W, H).data, W, H), W, H);
    self.postMessage({ id, w: r.w, h: r.h, W, H });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  } finally {
    frame.close();
  }
};
