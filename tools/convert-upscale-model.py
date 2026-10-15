"""ONNX -> модель для WebGPU-апскейла плеера (public/models/upscale/<id>.json + <id>.bin).

Граф сводится к списку свёрток (3x3 или 1x1) с «хвостом» — активацией и поэлементными связями,
которые движок считает в том же проходе. Поддерживаются семейства:
  ArtCNN C (яркость, длинный skip), Real-ESRGAN Compact / AnimeJaNai V3 (PReLU, nearest-residual),
  SPAN / AnimeJaNai V3.1 / AniSD (SiLU, внимание sigmoid-0.5 или tanh(conv1x1), concat, pixel-unshuffle).

Хвост свёртки (r — её сырой выход + bias):  out = act(r) * mul + add
  act:  none | relu | prelu | silu | tanh | sigm05 (sigmoid(r) - 0.5)
  mul:  сумма тензоров (или 'self' — сам r); пусто — без умножения
  add:  сумма тензоров
Запуск (нужны onnx и numpy):  python tools/convert-upscale-model.py <model.onnx> <id> [--name "..."]
Веса — float16 подряд, смещения в JSON — в элементах.
"""
import argparse, json, os
import numpy as np
import onnx
from onnx import numpy_helper

ap = argparse.ArgumentParser()
ap.add_argument('onnx')
ap.add_argument('id')
ap.add_argument('--name', default='')
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'upscale'))
a = ap.parse_args()

m = onnx.load(a.onnx)
g = m.graph
init = {i.name: numpy_helper.to_array(i).astype(np.float32) for i in g.initializer}
for n in g.node:  # Constant-узлы — тоже константы
    if n.op_type == 'Constant':
        for x in n.attribute:
            if x.name == 'value':
                init[n.output[0]] = numpy_helper.to_array(x.t).astype(np.float32)
inp = [i for i in g.input if i.name not in init][0]
in_ch = inp.type.tensor_type.shape.dim[1].dim_value

blob, size = [], 0
def put(arr):
    global size
    off = size
    flat = np.ascontiguousarray(arr, dtype=np.float32).ravel()
    blob.append(flat.astype('<f2'))
    size += flat.size
    return off

ops = []          # свёртки
tensors = [{'c': in_ch}]  # 0 — вход сети
expr = {}         # имя ONNX-тензора -> выражение
spec = {'in': 'luma' if in_ch == 1 else 'rgb', 'unshuffle': 1, 'shuffle': None, 'residual': None, 'clip': None}

# выражения: ('T', id) — готовый тензор; ('R', op) — сырой выход свёртки; ('act', fn, e); ('add', e1, e2);
# ('mul', e1, e2); ('subc', e, const); ('sig', e); ('cat', [e...]); ('pre',) — препроцессинг входа
expr[inp.name] = ('T', 0)

memo = {}
def materialize(e):
    """Выражение -> id тензора; при необходимости дописывает хвост свёртки (один раз на выражение)."""
    if e[0] == 'T':
        return e[1]
    key = repr(e)
    if key not in memo:
        memo[key] = _materialize(e)
    return memo[key]

def _materialize(e):
    if e[0] == 'R':
        return finish(e[1], {'act': None})
    # найти единственную свёртку, чей сырой выход ещё не зафиксирован
    raws = set()
    def walk(x):
        if x[0] == 'R': raws.add(x[1])
        elif x[0] in ('act', 'sig', 'subc'): walk(x[2] if x[0] == 'act' else x[1])
        elif x[0] in ('add', 'mul'): walk(x[1]); walk(x[2])
    walk(e)
    open_ = [k for k in raws if ops[k].get('out') is None]
    assert len(open_) == 1, f'не удалось свернуть выражение {e}'
    k = open_[0]
    tail = fold(e, k)
    return finish(k, tail)

def term(x, k):
    """слагаемое суммы -> 'self' или id тензора"""
    if x[0] == 'R' and x[1] == k: return 'self'
    return materialize(x)

def gate(x, k):
    """функция от сырого r -> имя активации"""
    if x[0] == 'act' and x[2] == ('R', k): return x[1]
    if x[0] == 'subc' and x[1][0] == 'sig' and x[1][1] == ('R', k) and abs(x[2] - 0.5) < 1e-6: return 'sigm05'
    if x[0] == 'mul' and x[1] == ('R', k) and x[2] == ('sig', ('R', k)): return 'silu'
    return None

def sumterms(x, k):
    if x[0] == 'add': return sumterms(x[1], k) + sumterms(x[2], k)
    return [term(x, k)]

def fold(e, k):
    if e == ('R', k): return {'act': None}
    fn = gate(e, k)
    if fn: return {'act': fn}
    if e[0] == 'mul':
        for x, y in ((e[1], e[2]), (e[2], e[1])):
            fn = gate(y, k)
            if fn and fn != 'silu': return {'act': fn, 'mul': sumterms(x, k)}
    if e[0] == 'add':
        for x, y in ((e[1], e[2]), (e[2], e[1])):
            try:
                t = fold(x, k)
            except AssertionError:
                continue
            if 'mul' not in t and 'add' not in t:
                t['add'] = sumterms(y, k)
                return t
    raise AssertionError(f'не удалось свернуть выражение {e}')

def finish(k, tail):
    op = ops[k]
    if op.get('out') is not None:
        assert tail == {'act': None}, 'выход свёртки уже зафиксирован с другим хвостом'
        return op['out']
    if tail['act'] == 'prelu':
        op['alpha'] = put(op.pop('_alpha').reshape(-1))
    op.pop('_alpha', None)
    op.update({k2: v for k2, v in tail.items() if v is not None and k2 != 'act'})
    op['act'] = tail['act']
    tensors.append({'c': op['cout']})
    op['out'] = len(tensors) - 1
    return op['out']

def match_unshuffle():
    # Pad(reflect) -> Reshape -> Transpose(0,1,3,5,2,4) -> Reshape перед первой свёрткой = pixel-unshuffle 2
    return any(n.op_type == 'Transpose' and list(onnx.helper.get_attribute_value(n.attribute[0])) == [0, 1, 3, 5, 2, 4] for n in g.node)

if match_unshuffle():
    spec['unshuffle'] = 2

for n in g.node:
    t = n.op_type
    attrs = {x.name: onnx.helper.get_attribute_value(x) for x in n.attribute}
    if t in ('Constant', 'Shape'):
        continue  # константы и арифметика форм (её узлы ниже пропускаются: их входы — не данные сети)
    if t in ('Pad', 'Reshape', 'Transpose') and spec['unshuffle'] == 2 and n.input[0] in expr and expr[n.input[0]] in (('T', 0), ('pre',)):
        expr[n.output[0]] = ('pre',)
        continue
    if t == 'Conv':
        w = init[n.input[1]]
        b = init[n.input[2]] if len(n.input) > 2 else np.zeros(w.shape[0], np.float32)
        kk = w.shape[2]
        assert w.shape[2:] in ((3, 3), (1, 1)) and attrs.get('group', 1) == 1
        src = expr[n.input[0]]
        if src == ('pre',): src = ('T', 0)
        ins = [materialize(x) for x in src[1]] if src[0] == 'cat' else [materialize(src)]
        if spec['unshuffle'] == 2 and ins == [0]:
            tensors[0]['c'] = in_ch * 4
        cin = sum(tensors[i]['c'] for i in ins)
        assert cin == w.shape[1], f'каналы {cin} != {w.shape[1]}'
        ops.append({'k': int(kk), 'in': ins, 'cin': int(w.shape[1]), 'cout': int(w.shape[0]), 'w': put(w), 'b': put(b), 'out': None})
        expr[n.output[0]] = ('R', len(ops) - 1)
    elif t == 'Relu':
        expr[n.output[0]] = ('act', 'relu', expr[n.input[0]])
    elif t == 'Tanh':
        expr[n.output[0]] = ('act', 'tanh', expr[n.input[0]])
    elif t == 'PRelu':
        e = expr[n.input[0]]
        assert e[0] == 'R'
        ops[e[1]]['_alpha'] = init[n.input[1]]
        expr[n.output[0]] = ('act', 'prelu', e)
    elif t == 'Sigmoid':
        expr[n.output[0]] = ('sig', expr[n.input[0]])
    elif t == 'Sub' and n.input[1] in init:
        expr[n.output[0]] = ('subc', expr[n.input[0]], float(init[n.input[1]].reshape(-1)[0]))
    elif t == 'Add' and spec['shuffle'] is None:
        expr[n.output[0]] = ('add', expr[n.input[0]], expr[n.input[1]])
    elif t == 'Mul' and n.input[0] in expr and n.input[1] in expr:
        expr[n.output[0]] = ('mul', expr[n.input[0]], expr[n.input[1]])
    elif t == 'Concat' and int(attrs.get('axis', 0)) == 1:
        expr[n.output[0]] = ('cat', [expr[x] for x in n.input])
    elif t == 'DepthToSpace':
        e = expr[n.input[0]]
        assert e[0] == 'R' and e[1] == len(ops) - 1, 'DepthToSpace должен идти сразу за последней свёрткой'
        spec['shuffle'] = {'r': int(attrs['blocksize']), 'mode': attrs.get('mode', b'DCR').decode()}
        ops[-1]['out'] = -1
        ops[-1]['act'] = None
        ops[-1].pop('_alpha', None)
        expr[n.output[0]] = ('final',)
    elif t == 'Resize':
        assert n.input[0] == inp.name and attrs.get('mode') == b'nearest'
        spec['residual'] = 'nearest'
        expr[n.output[0]] = ('final',)
    elif t == 'Add':
        assert spec['residual'] == 'nearest'
        expr[n.output[0]] = ('final',)
    elif t == 'Clip':
        lo = init.get(n.input[1]) if len(n.input) > 1 and n.input[1] else None
        hi = init.get(n.input[2]) if len(n.input) > 2 and n.input[2] else None
        spec['clip'] = [float(lo) if lo is not None else 0.0, float(hi) if hi is not None else 1.0]
        expr[n.output[0]] = ('final',)
    elif t == 'Slice' and expr.get(n.input[0]) == ('final',):
        expr[n.output[0]] = ('final',)  # обрезка до исходного размера — движок пишет только в пределах кадра
    elif n.input and n.input[0] not in expr:
        continue  # арифметика форм
    else:
        raise SystemExit(f'неподдерживаемая операция: {t} {list(n.input)}')

assert spec['shuffle'], 'нет DepthToSpace на выходе'
for op in ops:
    op.pop('_alpha', None)
    assert op['out'] is not None, 'есть свёртка без потребителя'
macs = sum(op['cin'] * op['cout'] * op['k'] * op['k'] for op in ops) / spec['unshuffle'] ** 2
spec.update({'id': a.id, 'name': a.name or a.id, 'scale': spec['shuffle']['r'] // spec['unshuffle'],
             'tensors': tensors, 'ops': ops, 'weights': size, 'macs': int(macs)})
os.makedirs(a.out, exist_ok=True)
with open(os.path.join(a.out, a.id + '.bin'), 'wb') as f:
    for part in blob:
        f.write(part.tobytes())
with open(os.path.join(a.out, a.id + '.json'), 'w', encoding='utf-8') as f:
    json.dump(spec, f, ensure_ascii=False, separators=(',', ':'))
print(a.id, spec['in'], 'unshuffle', spec['unshuffle'], 'ops', len(ops), 'tensors', len(tensors), 'MAC/px', int(macs), 'weights', size)
