// anix-trt — апскейл кадров нейросетью на тензорных ядрах NVIDIA (TensorRT for RTX) для Anix Desktop.
//
// Отдельный процесс: падение драйвера или TensorRT не роняет приложение. Electron (electron/trt.js) запускает его
// с --parent <pid главного процесса> --dlls <папка с tensorrt_rtx_*.dll> --cache <папка кэша движков>.
//
// Кадр приходит по stdin как RGBA8, считается на видеокарте (RGBA -> тензор -> TensorRT -> RGBA) и пишется прямо
// в общую D3D11-текстуру из кольца. Текстуры создаются один раз на сеанс; их NT-хэндлы дублируются в главный
// процесс, он отдаёт их окну через sharedTexture — кадр до WebGPU доходит без копирования через память.
// CUDA не регистрирует текстуры с NT-хэндлом, поэтому у слота две текстуры: рабочая (в неё пишет CUDA) и общая
// (её видит окно); после записи D3D11 копирует рабочую в общую и ждёт конец копирования (запрос D3D11_QUERY_EVENT).
// Синхронизации у rgba-текстур нет: кадр считается готовым после этого ожидания, а слот кольца
// переиспользуется, только когда окно сообщило, что дорисовало его (это следит electron/trt.js).
//
// Протокол. Вход (stdin): заголовок 16 байт {u32 'ANXT', u32 тип, u32 длина JSON, u32 длина данных}, JSON, данные.
//   1 open  {"model":"janai-v31-bal","w":1280,"h":720,"ring":3} + байты ONNX (из app.asar внешний процесс читать не может)
//                                                     -> {"type":"open","ok":true,"handles":["…"],"ow":…,"oh":…,"ms":…}
//   2 frame {"slot":0,"w":1280,"h":720,"fmt":"NV12","o0":0,"s0":1280,"o1":…,"s1":…,"o2":…,"s2":…,"matrix":"bt709","full":0}
//           + кадр как его отдаёт VideoFrame.copyTo (NV12, I420, RGBA, BGRA)  -> {"type":"frame","slot":0,"ms":…}
//   3 close                                             -> {"type":"close"}
// Выход (stdout): по строке JSON на ответ. Первая строка — {"type":"ready",…} или {"type":"fatal",…}.

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <cuda_runtime.h>
#include <cuda_d3d11_interop.h>
#include <cuda_fp16.h>
#include <fcntl.h>
#include <io.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include "NvInfer.h"
#include "NvOnnxParser.h"

using namespace nvinfer1;

// ---------- мелочи: ответы, JSON ----------
static void reply(const std::string& s) { fwrite(s.data(), 1, s.size(), stdout); fputc('\n', stdout); fflush(stdout); }
static std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if ((unsigned char)c < 0x20) o += ' '; else o += c; }
  return o;
}
static std::string jstr(const std::string& j, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = j.find(k); if (p == std::string::npos) return "";
  p = j.find(':', p); p = j.find('"', p); if (p == std::string::npos) return "";
  std::string o;
  for (size_t i = p + 1; i < j.size() && j[i] != '"'; i++) { if (j[i] == '\\' && i + 1 < j.size()) i++; o += j[i]; }
  return o;
}
static double jnum(const std::string& j, const char* key, double def = 0) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = j.find(k); if (p == std::string::npos) return def;
  p = j.find(':', p); if (p == std::string::npos) return def;
  return atof(j.c_str() + p + 1);
}
static std::wstring widen(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(n ? n - 1 : 0, L'\0'); if (n) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
  return w;
}
static bool readAll(void* dst, size_t n) {
  char* p = (char*)dst;
  while (n) { size_t r = fread(p, 1, n, stdin); if (!r) return false; p += r; n -= r; }
  return true;
}
static std::vector<char> readFile(const std::wstring& path) {
  std::ifstream f(path, std::ios::binary); if (!f) return {};
  return std::vector<char>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
static void writeFile(const std::wstring& path, const void* data, size_t n) { std::ofstream f(path, std::ios::binary); f.write((const char*)data, n); }
#define CK(x) do { cudaError_t e_ = (x); if (e_ != cudaSuccess) throw std::string(#x) + ": " + cudaGetErrorString(e_); } while (0)
#define HR(x) do { HRESULT h_ = (x); if (FAILED(h_)) { char b_[32]; sprintf(b_, " 0x%08lx", (unsigned long)h_); throw std::string(#x) + b_; } } while (0)

class Logger : public ILogger {
  void log(Severity s, const char* msg) noexcept override { if (s <= Severity::kWARNING) fprintf(stderr, "[trt] %s\n", msg); }
} gLogger;

// ---------- ядра: RGBA8 -> тензор NCHW [0..1] и тензор -> RGBA8 в текстуру ----------
template <typename T> __device__ inline T toT(float v);
template <> __device__ inline float toT<float>(float v) { return v; }
template <> __device__ inline __half toT<__half>(float v) { return __float2half(v); }
__device__ inline float fromT(float v) { return v; }
__device__ inline float fromT(__half v) { return __half2float(v); }

// Кадр в формате VideoFrame (NV12 / I420 — как пришёл из декодера, RGBA / BGRA) -> RGB [0..1]. YUV переводится
// по матрице и диапазону из colorSpace кадра; цветность — билинейно (по горизонтали отсчёты совпадают с яркостью,
// по вертикали — посередине, как в H.264/HEVC 4:2:0)
struct Conv {
  int kind; // 0 RGBA, 1 BGRA, 2 NV12, 3 I420
  long long o0, o1, o2; int s0, s1, s2;
  float yo, ys, cs, kr, kgb, kgr, kb;
};
template <typename T>
__global__ void kIn(const unsigned char* src, Conv c, int w, int h, T* dst) {
  int x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= w || y >= h) return;
  float r, g, b;
  if (c.kind <= 1) {
    const unsigned char* p = src + c.o0 + (size_t)y * c.s0 + (size_t)x * 4;
    r = p[c.kind ? 2 : 0] / 255.f; g = p[1] / 255.f; b = p[c.kind ? 0 : 2] / 255.f;
  } else {
    float Y = src[c.o0 + (size_t)y * c.s0 + x];
    int cw = (w + 1) / 2, ch = (h + 1) / 2;
    float cx = x * 0.5f, cy = (y + 0.5f) * 0.5f - 0.5f;
    int x0 = (int)floorf(cx), y0 = (int)floorf(cy); float fx = cx - x0, fy = cy - y0;
    int x1 = min(x0 + 1, cw - 1), y1 = min(y0 + 1, ch - 1); x0 = max(x0, 0); y0 = max(y0, 0);
    auto U = [&](int xx, int yy) -> float { return c.kind == 2 ? src[c.o1 + (size_t)yy * c.s1 + xx * 2] : src[c.o1 + (size_t)yy * c.s1 + xx]; };
    auto V = [&](int xx, int yy) -> float { return c.kind == 2 ? src[c.o1 + (size_t)yy * c.s1 + xx * 2 + 1] : src[c.o2 + (size_t)yy * c.s2 + xx]; };
    float u = (U(x0, y0) * (1 - fx) + U(x1, y0) * fx) * (1 - fy) + (U(x0, y1) * (1 - fx) + U(x1, y1) * fx) * fy;
    float v = (V(x0, y0) * (1 - fx) + V(x1, y0) * fx) * (1 - fy) + (V(x0, y1) * (1 - fx) + V(x1, y1) * fx) * fy;
    float yy = (Y - c.yo) * c.ys, cb = (u - 128.f) * c.cs, cr = (v - 128.f) * c.cs;
    r = yy + c.kr * cr; g = yy - c.kgb * cb - c.kgr * cr; b = yy + c.kb * cb;
  }
  size_t n = (size_t)w * h, i = (size_t)y * w + x;
  dst[i] = toT<T>(fminf(fmaxf(r, 0.f), 1.f)); dst[n + i] = toT<T>(fminf(fmaxf(g, 0.f), 1.f)); dst[2 * n + i] = toT<T>(fminf(fmaxf(b, 0.f), 1.f));
}
static Conv makeConv(const std::string& j) {
  Conv c{};
  std::string f = jstr(j, "fmt"), m = jstr(j, "matrix");
  c.kind = f == "NV12" ? 2 : f == "I420" ? 3 : (f == "BGRA" || f == "BGRX") ? 1 : 0;
  c.o0 = (long long)jnum(j, "o0"); c.o1 = (long long)jnum(j, "o1"); c.o2 = (long long)jnum(j, "o2");
  c.s0 = (int)jnum(j, "s0"); c.s1 = (int)jnum(j, "s1"); c.s2 = (int)jnum(j, "s2");
  bool full = jnum(j, "full") != 0;
  c.yo = full ? 0.f : 16.f; c.ys = full ? 1.f / 255.f : 1.f / 219.f; c.cs = full ? 1.f / 255.f : 1.f / 224.f;
  if (m == "smpte170m" || m == "bt470bg") { c.kr = 1.402f; c.kgb = 0.344136f; c.kgr = 0.714136f; c.kb = 1.772f; }
  else if (m == "bt2020-ncl") { c.kr = 1.4746f; c.kgb = 0.16455f; c.kgr = 0.57135f; c.kb = 1.8814f; }
  else { c.kr = 1.5748f; c.kgb = 0.1873f; c.kgr = 0.4681f; c.kb = 1.8556f; } // bt709 и по умолчанию
  return c;
}
template <typename T>
__global__ void kOut(const T* src, int w, int h, cudaSurfaceObject_t surf) {
  int x = blockIdx.x * blockDim.x + threadIdx.x, y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= w || y >= h) return;
  size_t n = (size_t)w * h, i = (size_t)y * w + x;
  auto q = [](float v) { return (unsigned char)__float2int_rn(fminf(fmaxf(v, 0.f), 1.f) * 255.f); };
  uchar4 o = make_uchar4(q(fromT(src[i])), q(fromT(src[n + i])), q(fromT(src[2 * n + i])), 255);
  surf2Dwrite(o, surf, x * 4, y);
}

// ---------- устройство ----------
static ID3D11Device* gD3D = nullptr;
static ID3D11DeviceContext* gCtx = nullptr;
static int gCuda = 0;
static HANDLE gParent = nullptr;
static std::wstring gCacheDir;
static cudaStream_t gStream = nullptr;
static bool gTrtLoaded = false; // библиотеки TensorRT нашлись (без них программа только сообщает о видеокарте)

static std::string initDevice() {
  // D3D11 на той же видеокарте, что CUDA-устройство 0 (по LUID) — иначе общая текстура не откроется в CUDA
  int n = 0; CK(cudaGetDeviceCount(&n)); if (!n) throw std::string("нет устройств CUDA");
  cudaDeviceProp prop{}; CK(cudaGetDeviceProperties(&prop, 0));
  IDXGIFactory1* fac = nullptr; HR(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&fac));
  IDXGIAdapter1* ad = nullptr; IDXGIAdapter1* pick = nullptr;
  for (UINT i = 0; fac->EnumAdapters1(i, &ad) != DXGI_ERROR_NOT_FOUND; i++) {
    DXGI_ADAPTER_DESC1 d; ad->GetDesc1(&d);
    if (!memcmp(&d.AdapterLuid, prop.luid, sizeof(LUID))) { pick = ad; break; }
    ad->Release();
  }
  fac->Release();
  if (!pick) throw std::string("не найден D3D-адаптер видеокарты CUDA");
  D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_1;
  HR(D3D11CreateDevice(pick, D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &gD3D, nullptr, &gCtx));
  int dev = 0; CK(cudaD3D11GetDevice(&dev, pick)); gCuda = dev; CK(cudaSetDevice(gCuda));
  pick->Release();
  CK(cudaStreamCreateWithFlags(&gStream, cudaStreamNonBlocking));
  cudaDeviceProp p2{}; CK(cudaGetDeviceProperties(&p2, gCuda));
  std::ostringstream o;
  o << "{\"type\":\"ready\",\"gpu\":\"" << esc(p2.name) << "\",\"cc\":" << p2.major << "." << p2.minor
    << ",\"vram\":" << (p2.totalGlobalMem >> 20) << ",\"trt\":" << (gTrtLoaded ? getInferLibVersion() : 0) << "}";
  return o.str();
}

// ---------- сеанс: движок под модель и размер кадра + кольцо текстур ----------
struct Slot { ID3D11Texture2D* tex = nullptr; ID3D11Texture2D* work = nullptr; cudaGraphicsResource_t res = nullptr; HANDLE local = nullptr; };
struct Session {
  std::unique_ptr<IRuntime> runtime; std::unique_ptr<ICudaEngine> engine; std::unique_ptr<IRuntimeConfig> rtcfg;
  std::unique_ptr<IRuntimeCache> cache; std::unique_ptr<IExecutionContext> ctx;
  std::wstring cacheFile;
  std::string inName, outName; DataType inType = DataType::kFLOAT, outType = DataType::kFLOAT;
  int w = 0, h = 0, ow = 0, oh = 0;
  void* dIn = nullptr; void* dOut = nullptr; void* dRgba = nullptr; void* hRgba = nullptr; size_t rgbaCap = 0;
  std::vector<Slot> ring;
  ID3D11Query* done = nullptr; // конец копирования в общую текстуру
  std::vector<HANDLE> remote;  // копии хэндлов в главном процессе — закрываем там же при закрытии сеанса
  ~Session() {
    for (HANDLE h : remote) DuplicateHandle(gParent, h, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
    if (gStream) cudaStreamSynchronize(gStream);
    if (cache && !cacheFile.empty()) { std::unique_ptr<IHostMemory> m(cache->serialize()); if (m) writeFile(cacheFile, m->data(), m->size()); }
    for (auto& s : ring) { if (s.res) cudaGraphicsUnregisterResource(s.res); if (s.local) CloseHandle(s.local); if (s.tex) s.tex->Release(); if (s.work) s.work->Release(); }
    if (done) done->Release();
    ctx.reset(); cache.reset(); rtcfg.reset(); engine.reset(); runtime.reset();
    if (dIn) cudaFree(dIn); if (dOut) cudaFree(dOut); if (dRgba) cudaFree(dRgba); if (hRgba) cudaFreeHost(hRgba);
  }
};
static std::unique_ptr<Session> gS;
static size_t dtSize(DataType t) { return t == DataType::kHALF ? 2 : 4; }

static std::wstring keyName(const std::string& model, size_t onnxSize, int w, int h) {
  // кэш: модель (имя и размер файла) + размер кадра + видеокарта + версия TensorRT
  cudaDeviceProp prop{}; cudaGetDeviceProperties(&prop, gCuda);
  std::ostringstream o; o << model << "-" << onnxSize << "-" << w << "x" << h << "-sm" << prop.major << prop.minor << "-trt" << getInferLibVersion();
  return gCacheDir + L"\\" + widen(o.str());
}

static std::string openSession(const std::string& j, const std::vector<char>& onnx) {
  auto t0 = std::chrono::steady_clock::now();
  gS.reset();
  auto S = std::make_unique<Session>();
  std::string model = jstr(j, "model");
  S->w = (int)jnum(j, "w"); S->h = (int)jnum(j, "h");
  int ringN = (int)jnum(j, "ring", 3);
  if (onnx.empty() || model.empty() || S->w <= 0 || S->h <= 0) throw std::string("open: нужны model, w, h и ONNX");
  std::wstring base = keyName(model, onnx.size(), S->w, S->h);
  std::wstring planFile = base + L".plan"; S->cacheFile = base + L".rtcache";

  // движок: из кэша или сборка из ONNX под ровно этот размер кадра
  std::vector<char> plan = readFile(planFile);
  bool built = false;
  S->runtime.reset(createInferRuntime(gLogger));
  if (!plan.empty()) {
    S->engine.reset(S->runtime->deserializeCudaEngine(plan.data(), plan.size()));
  }
  if (!S->engine) {
    std::unique_ptr<IBuilder> b(createInferBuilder(gLogger));
    std::unique_ptr<INetworkDefinition> net(b->createNetworkV2(0));
    std::unique_ptr<nvonnxparser::IParser> parser(nvonnxparser::createParser(*net, gLogger));
    if (!parser->parse(onnx.data(), onnx.size())) throw std::string("не удалось разобрать ONNX: ") + model;
    std::unique_ptr<IBuilderConfig> cfg(b->createBuilderConfig());
    IOptimizationProfile* prof = b->createOptimizationProfile();
    const char* in = net->getInput(0)->getName();
    Dims4 d{1, 3, S->h, S->w};
    prof->setDimensions(in, OptProfileSelector::kMIN, d); prof->setDimensions(in, OptProfileSelector::kOPT, d); prof->setDimensions(in, OptProfileSelector::kMAX, d);
    cfg->addOptimizationProfile(prof);
    cfg->setNbComputeCapabilities(1); cfg->setComputeCapability(ComputeCapability::kCURRENT, 0);
    std::unique_ptr<IHostMemory> ser(b->buildSerializedNetwork(*net, *cfg));
    if (!ser) throw std::string("не удалось собрать движок TensorRT");
    writeFile(planFile, ser->data(), ser->size());
    S->engine.reset(S->runtime->deserializeCudaEngine(ser->data(), ser->size()));
    if (!S->engine) throw std::string("не удалось загрузить движок TensorRT");
    built = true;
  }
  // кэш JIT-компиляции ядер (TensorRT-RTX собирает ядра под видеокарту при первом запуске)
  S->rtcfg.reset(S->engine->createRuntimeConfig());
  S->cache.reset(S->rtcfg->createRuntimeCache());
  std::vector<char> rc = readFile(S->cacheFile);
  if (!rc.empty()) S->cache->deserialize(rc.data(), rc.size());
  S->rtcfg->setRuntimeCache(*S->cache);
  S->ctx.reset(S->engine->createExecutionContext(S->rtcfg.get()));
  if (!S->ctx) throw std::string("не удалось создать контекст TensorRT");

  for (int i = 0; i < S->engine->getNbIOTensors(); i++) {
    const char* nm = S->engine->getIOTensorName(i);
    if (S->engine->getTensorIOMode(nm) == TensorIOMode::kINPUT) { S->inName = nm; S->inType = S->engine->getTensorDataType(nm); }
    else { S->outName = nm; S->outType = S->engine->getTensorDataType(nm); }
  }
  if (!S->ctx->setInputShape(S->inName.c_str(), Dims4{1, 3, S->h, S->w})) throw std::string("размер входа не подходит модели");
  Dims od = S->ctx->getTensorShape(S->outName.c_str());
  if (od.nbDims != 4 || od.d[1] != 3) throw std::string("неожиданная форма выхода модели");
  S->oh = (int)od.d[2]; S->ow = (int)od.d[3];
  CK(cudaMalloc(&S->dIn, (size_t)3 * S->w * S->h * dtSize(S->inType)));
  CK(cudaMalloc(&S->dOut, (size_t)3 * S->ow * S->oh * dtSize(S->outType)));
  S->ctx->setTensorAddress(S->inName.c_str(), S->dIn);
  S->ctx->setTensorAddress(S->outName.c_str(), S->dOut);
  // прогрев: первый запуск собирает ядра (JIT) — пусть это будет здесь, а не на первом кадре
  for (int i = 0; i < 2; i++) if (!S->ctx->enqueueV3(gStream)) throw std::string("enqueueV3 не прошёл");
  CK(cudaStreamSynchronize(gStream));
  { std::unique_ptr<IHostMemory> m(S->cache->serialize()); if (m) writeFile(S->cacheFile, m->data(), m->size()); }

  // кольцо общих текстур RGBA8 размером выхода; NT-хэндлы — в главный процесс
  D3D11_QUERY_DESC qd{}; qd.Query = D3D11_QUERY_EVENT; HR(gD3D->CreateQuery(&qd, &S->done));
  std::ostringstream hs;
  for (int i = 0; i < ringN; i++) {
    Slot s;
    D3D11_TEXTURE2D_DESC td{};
    td.Width = S->ow; td.Height = S->oh; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET | D3D11_BIND_UNORDERED_ACCESS;
    td.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
    HR(gD3D->CreateTexture2D(&td, nullptr, &s.tex));
    IDXGIResource1* r1 = nullptr; HR(s.tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&r1));
    HRESULT hr = r1->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &s.local);
    r1->Release(); HR(hr);
    HANDLE dup = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), s.local, gParent, &dup, 0, FALSE, DUPLICATE_SAME_ACCESS)) throw std::string("DuplicateHandle не прошёл");
    S->remote.push_back(dup);
    D3D11_TEXTURE2D_DESC wd = td; wd.MiscFlags = 0;
    HR(gD3D->CreateTexture2D(&wd, nullptr, &s.work));
    CK(cudaGraphicsD3D11RegisterResource(&s.res, s.work, cudaGraphicsRegisterFlagsSurfaceLoadStore));
    S->ring.push_back(s);
    char b[32]; sprintf(b, "%llu", (unsigned long long)(uintptr_t)dup);
    hs << (i ? "," : "") << "\"" << b << "\"";
  }
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::ostringstream o;
  o << "{\"type\":\"open\",\"ok\":true,\"handles\":[" << hs.str() << "],\"ow\":" << S->ow << ",\"oh\":" << S->oh
    << ",\"built\":" << (built ? "true" : "false") << ",\"half\":" << (S->inType == DataType::kHALF ? "true" : "false") << ",\"ms\":" << (int)ms << "}";
  gS = std::move(S);
  return o.str();
}

static std::string runFrame(const std::string& j, uint32_t binLen) {
  auto t0 = std::chrono::steady_clock::now();
  Session* S = gS.get();
  int slot = (int)jnum(j, "slot"), w = (int)jnum(j, "w"), h = (int)jnum(j, "h");
  Conv cv = makeConv(j);
  size_t need = cv.kind <= 1 ? (size_t)cv.o0 + (size_t)cv.s0 * h : (size_t)cv.o0 + (size_t)cv.s0 * h;
  if (!S || w != S->w || h != S->h || slot < 0 || slot >= (int)S->ring.size() || need > binLen || !cv.s0) {
    std::vector<char> skip(binLen); readAll(skip.data(), binLen);
    throw std::string("frame: нет сеанса или размер не совпадает");
  }
  if (S->rgbaCap < binLen) {
    if (S->hRgba) cudaFreeHost(S->hRgba); if (S->dRgba) cudaFree(S->dRgba);
    CK(cudaHostAlloc(&S->hRgba, binLen, cudaHostAllocDefault)); CK(cudaMalloc(&S->dRgba, binLen)); S->rgbaCap = binLen;
  }
  if (!readAll(S->hRgba, binLen)) throw std::string("stdin закрыт");
  auto t1 = std::chrono::steady_clock::now();
  CK(cudaMemcpyAsync(S->dRgba, S->hRgba, binLen, cudaMemcpyHostToDevice, gStream));
  dim3 bs(16, 16), gi((w + 15) / 16, (h + 15) / 16), go((S->ow + 15) / 16, (S->oh + 15) / 16);
  if (S->inType == DataType::kHALF) kIn<__half><<<gi, bs, 0, gStream>>>((const unsigned char*)S->dRgba, cv, w, h, (__half*)S->dIn);
  else kIn<float><<<gi, bs, 0, gStream>>>((const unsigned char*)S->dRgba, cv, w, h, (float*)S->dIn);
  if (!S->ctx->enqueueV3(gStream)) throw std::string("enqueueV3 не прошёл");
  Slot& s = S->ring[slot];
  CK(cudaGraphicsMapResources(1, &s.res, gStream));
  cudaArray_t arr = nullptr; CK(cudaGraphicsSubResourceGetMappedArray(&arr, s.res, 0, 0));
  cudaResourceDesc rd{}; rd.resType = cudaResourceTypeArray; rd.res.array.array = arr;
  cudaSurfaceObject_t surf = 0; CK(cudaCreateSurfaceObject(&surf, &rd));
  if (S->outType == DataType::kHALF) kOut<__half><<<go, bs, 0, gStream>>>((const __half*)S->dOut, S->ow, S->oh, surf);
  else kOut<float><<<go, bs, 0, gStream>>>((const float*)S->dOut, S->ow, S->oh, surf);
  CK(cudaGraphicsUnmapResources(1, &s.res, gStream));
  CK(cudaStreamSynchronize(gStream));
  cudaDestroySurfaceObject(surf);
  // рабочая -> общая; ждём, пока видеокарта закончит копирование, — тогда кадр можно показывать
  gCtx->CopyResource(s.tex, s.work);
  gCtx->End(S->done);
  while (gCtx->GetData(S->done, nullptr, 0, 0) == S_FALSE) YieldProcessor();
  auto t2 = std::chrono::steady_clock::now();
  std::ostringstream o;
  o << "{\"type\":\"frame\",\"slot\":" << slot << ",\"ms\":" << std::chrono::duration<double, std::milli>(t2 - t1).count()
    << ",\"readMs\":" << std::chrono::duration<double, std::milli>(t1 - t0).count() << "}";
  return o.str();
}

int main(int argc, char** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  setvbuf(stdin, nullptr, _IOFBF, 1 << 20);
  DWORD parentPid = 0; std::string dlls, cache;
  for (int i = 1; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--parent")) parentPid = (DWORD)atoi(argv[++i]);
    else if (!strcmp(argv[i], "--dlls")) dlls = argv[++i];
    else if (!strcmp(argv[i], "--cache")) cache = argv[++i];
  }
  try {
    if (!dlls.empty()) SetDllDirectoryW(widen(dlls).c_str()); // tensorrt_rtx_*.dll подгружаются отложенно (/DELAYLOAD)
    gTrtLoaded = LoadLibraryW(L"tensorrt_rtx_1_7.dll") && LoadLibraryW(L"tensorrt_onnxparser_rtx_1_7.dll");
    gCacheDir = widen(cache.empty() ? "." : cache);
    gParent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, parentPid ? parentPid : GetCurrentProcessId());
    if (!gParent) throw std::string("нет доступа к главному процессу");
    reply(initDevice());
  } catch (const std::string& e) { reply("{\"type\":\"fatal\",\"error\":\"" + esc(e) + "\"}"); return 1; }

  for (;;) {
    uint32_t hdr[4];
    if (!readAll(hdr, sizeof hdr) || hdr[0] != 0x54584E41 /* 'ANXT' */) break;
    std::string j(hdr[2], '\0');
    if (hdr[2] && !readAll(&j[0], hdr[2])) break;
    try {
      if (hdr[1] == 1) {
        std::vector<char> onnx(hdr[3]); if (hdr[3] && !readAll(onnx.data(), hdr[3])) break;
        if (!gTrtLoaded) throw std::string("библиотеки TensorRT не найдены");
        reply(openSession(j, onnx));
      }
      else if (hdr[1] == 2) reply(runFrame(j, hdr[3]));
      else if (hdr[1] == 3) { gS.reset(); reply("{\"type\":\"close\"}"); }
      else if (hdr[1] == 0) break;
    } catch (const std::string& e) {
      reply(std::string("{\"type\":\"") + (hdr[1] == 1 ? "open" : hdr[1] == 2 ? "frame" : "error") + "\",\"ok\":false,\"slot\":" +
            std::to_string((int)jnum(j, "slot", -1)) + ",\"error\":\"" + esc(e) + "\"}");
    }
  }
  gS.reset();
  return 0;
}
