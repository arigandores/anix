'use strict';
// Сборка trt/bin/anix-trt.exe (только Windows): нужны Visual Studio Build Tools (C++), CUDA Toolkit 13.x и SDK
// TensorRT for RTX (заголовки и import-библиотеки) — его скрипт скачает в trt/sdk сам.
//   node trt/build.js
// CUDA подключается статически, рантайм MSVC — тоже (/MT): exe не требует ничего, кроме драйвера NVIDIA и
// tensorrt_rtx_*.dll, которые грузятся отложенно (/DELAYLOAD) из папки, переданной в --dlls.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TRT_VERSION = '1.7.1.116';
const SDK_URL = `https://developer.nvidia.com/downloads/trt/rtx_sdk/secure/1.7/tensorrt-rtx-${TRT_VERSION}-windows-amd64-cuda-13.4-release-external.zip`;
const DIR = __dirname;
const SDK = process.env.TRT_RTX_DIR || path.join(DIR, 'sdk', `TensorRT-RTX-${TRT_VERSION}`);
const OUT = path.join(DIR, 'bin');
// архитектуры: Turing … Blackwell + PTX для будущих
const ARCH = ['75', '80', '86', '89', '120'].map((a) => `-gencode arch=compute_${a},code=sm_${a}`).concat('-gencode arch=compute_120,code=compute_120');

function sh(cmd) { console.log('>', cmd.length > 220 ? cmd.slice(0, 220) + '…' : cmd); execSync(cmd, { stdio: 'inherit', shell: 'cmd.exe' }); }

if (!fs.existsSync(path.join(SDK, 'include', 'NvInfer.h'))) {
  const zip = path.join(DIR, 'sdk', 'trt-rtx.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  sh(`curl -L --fail -o "${zip}" "${SDK_URL}"`);
  sh(`tar -xf "${zip}" -C "${path.join(DIR, 'sdk')}"`);
  fs.rmSync(zip, { force: true });
}
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const vs = execSync(`"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`).toString().trim();
const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
const cuda = process.env.CUDA_PATH;
if (!cuda) throw new Error('нет CUDA_PATH — установите CUDA Toolkit 13.x');
fs.mkdirSync(OUT, { recursive: true });
const lib = path.join(SDK, 'lib');
sh([`call "${vcvars}" >nul &&`, `"${path.join(cuda, 'bin', 'nvcc.exe')}"`, '-O2 -std=c++17', ...ARCH,
  '-Xcompiler "/utf-8 /EHsc /MT" -cudart static',
  `-I "${path.join(SDK, 'include')}"`, `"${path.join(DIR, 'anix-trt.cu')}"`, `-o "${path.join(OUT, 'anix-trt.exe')}"`,
  `-L "${lib}" -ltensorrt_rtx_1_7 -ltensorrt_onnxparser_rtx_1_7 -ld3d11 -ldxgi -ldelayimp`,
  '-Xlinker /DELAYLOAD:tensorrt_rtx_1_7.dll -Xlinker /DELAYLOAD:tensorrt_onnxparser_rtx_1_7.dll -Xlinker /NODEFAULTLIB:MSVCRT'].join(' '));
for (const f of fs.readdirSync(OUT)) if (/\.(exp|lib)$/.test(f)) fs.rmSync(path.join(OUT, f));
console.log('готово:', path.join(OUT, 'anix-trt.exe'), (fs.statSync(path.join(OUT, 'anix-trt.exe')).size / 1048576).toFixed(1), 'МБ');
