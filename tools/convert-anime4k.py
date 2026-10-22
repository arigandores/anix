"""Anime4K (bloc97, MIT) GLSL-шейдер апскейла -> модель для WebGPU-апскейла плеера (public/models/upscale/<id>.json + .bin).

Anime4K Upscale CNN x2 (S/M/L/VL/UL): свёртки 3x3 по 4 канала, вход каждого следующего слоя — CReLU предыдущего
(max(x,0) и max(-x,0)), затем свёртка 1x1 по CReLU всех слоёв -> 4 канала -> DepthToSpace 2x2: добавка яркости, которая
прибавляется ко всем цветам билинейно растянутого кадра (MAIN_tex(MAIN_pos)). В нашем движке: слои — act 'crelu'
(тензор 2·cout каналов), выход — shuffle.broadcast и residual 'bilinear' (public/js/upscale/engine.js).
Сейчас конвертер разбирает варианты с 4 каналами на слой (S, M): у L/VL/UL по 8 каналов и выход на 3 цвета.

Веса в GLSL — mat4(16 чисел) по столбцам: столбец j — входной канал j группы go_N (N=0 — max(x,0), N=1 — max(-x,0)),
строка — выходной канал. Отвод (x, y): x — по горизонтали, y — вниз (как строки кадра; --flip-y — наоборот).

Запуск: python tools/convert-anime4k.py Anime4K_Upscale_CNN_x2_M.glsl anime4k-m "Anime4K CNN M"
Лицензия Anime4K — MIT (Copyright (c) 2019 bloc97): текст лицензии кладётся рядом (public/models/upscale/ANIME4K-LICENSE).
"""
import argparse, json, os, re, struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'models', 'upscale')

ap = argparse.ArgumentParser()
ap.add_argument('glsl'); ap.add_argument('id'); ap.add_argument('name')
ap.add_argument('--flip-y', action='store_true')
a = ap.parse_args()
src = open(a.glsl, encoding='utf-8').read()

passes = [p for p in src.split('//!DESC')[1:] if '-Conv-' in p.split('\n')[0]]
NUM = r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?'
ops = []; data = []; tensors = [{'c': 3}]
for li, body in enumerate(passes):
    last = '1x1' in body.split('\n')[0]
    k = 1 if last else 3
    terms = re.findall(r'mat4\(([^)]*)\)\s*\*\s*go?_(\d+)(?:\(\s*(' + NUM + r')\s*,\s*(' + NUM + r')\s*\))?', body)
    bias = [float(x) for x in re.search(r'result \+= vec4\(([^)]*)\);', body).group(1).split(',')]
    groups = max(int(t[1]) for t in terms) + 1
    cin = 3 if li == 0 else groups * 4
    cout = 4
    T = k * k
    w = [[[0.0] * T for _ in range(cin)] for _ in range(cout)]
    for vals, n, xo, yo in terms:
        v = [float(x) for x in vals.split(',')]
        t = 0 if k == 1 else (int(float(yo)) * (-1 if a.flip_y else 1) + 1) * 3 + int(float(xo)) + 1
        n = int(n)
        for j in range(4):
            ci = n * 4 + j
            if ci >= cin: continue
            for co in range(cout):
                w[co][ci][t] += v[j * 4 + co]
    op = {'k': k, 'cin': cin, 'cout': cout, 'w': len(data)}
    for co in range(cout):
        for ci in range(cin):
            data.extend(w[co][ci])
    op['b'] = len(data); data.extend(bias)
    if last:
        op.update({'in': list(range(1, len(tensors))), 'out': -1, 'act': None})
    else:
        op.update({'in': [li], 'out': li + 1, 'act': 'crelu'})
        tensors.append({'c': cout * 2})
    ops.append(op)

macs = sum(o['k'] * o['k'] * o['cin'] * o['cout'] for o in ops)
spec = {'in': 'rgb', 'unshuffle': 1, 'shuffle': {'r': 2, 'mode': 'DCR', 'broadcast': True}, 'residual': 'bilinear', 'clip': [0.0, 1.0],
        'id': a.id, 'name': a.name, 'scale': 2, 'tensors': tensors, 'ops': ops, 'weights': len(data), 'macs': macs,
        'license': 'Anime4K, MIT, Copyright (c) 2019 bloc97'}
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, a.id + '.json'), 'w', encoding='utf-8') as f: json.dump(spec, f, ensure_ascii=False, separators=(',', ':'))
with open(os.path.join(OUT, a.id + '.bin'), 'wb') as f: f.write(b''.join(struct.pack('<e', x) for x in data))
print(f'{a.id}: слоёв {len(ops)}, весов {len(data)}, умножений на пиксель {macs}')
