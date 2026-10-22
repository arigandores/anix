// Anix: дебандинг — убирает «квадратики» и ступеньки сжатия h264 на ровных участках (тёмные сцены, небо, градиенты).
// Алгоритм f3kdb (как deband в mpv, своя реализация): вокруг точки — 4 соседа по кругу случайного радиуса и угла;
// если все они отличаются от точки меньше порога (ровный участок, ступенька сжатия в 1–3 уровня яркости) — точка
// заменяется их средним. Линии и детали контрастнее порога — не трогаются. Два прохода: ближе с порогом выше, дальше —
// ниже. Идёт первым в цепочке, до Anime4K (Restore и резкость иначе подчёркивают края блоков).
// MIT, Anix

//!DESC Anix-Deband
//!HOOK MAIN
//!BIND HOOKED
#define TH 0.018
#define RANGE 16.0
// хэш без sin (Dave Hoskins, hash12): дешевле на мобильной видеокарте
highp float rnd(highp vec2 p) { highp vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec4 hook() {
    highp vec2 pos = HOOKED_pos;
    highp vec2 px = pos * HOOKED_size;
    vec4 c = HOOKED_tex(pos);
    // в тёмном — порог выше: там сжатие грубее, а ступеньки заметнее
    float dark = 1.0 + 0.8 * (1.0 - smoothstep(0.05, 0.35, dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))));
    for (int i = 1; i <= 2; i++) {
        highp float fi = float(i);
        highp float r = RANGE * fi * mix(0.5, 1.0, rnd(px + fi));
        highp float a = 6.2831853 * rnd(px.yx * 1.37 + fi * 3.1);
        highp vec2 o = vec2(cos(a), sin(a)) * r * HOOKED_pt;
        highp vec2 q = vec2(-o.y, o.x);
        vec4 s0 = HOOKED_tex(pos + o), s1 = HOOKED_tex(pos - o), s2 = HOOKED_tex(pos + q), s3 = HOOKED_tex(pos - q);
        vec3 d = max(max(abs(s0.rgb - c.rgb), abs(s1.rgb - c.rgb)), max(abs(s2.rgb - c.rgb), abs(s3.rgb - c.rgb)));
        float th = TH * dark / fi;
        if (max(d.r, max(d.g, d.b)) < th) c = (s0 + s1 + s2 + s3) * 0.25;
    }
    return c;
}
