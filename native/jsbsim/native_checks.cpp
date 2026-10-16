// Native contract/numerical checks against the pinned JSBSim bridge, not WASM
// parity.
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
extern "C" unsigned jsb_create(const char *, const char *, double);
extern "C" int jsb_step(unsigned, const double *, unsigned, double *, unsigned);
extern "C" int jsb_trim(unsigned, double *, unsigned);
extern "C" void jsb_dispose(unsigned);
namespace {
bool tracking = false;
std::size_t calls = 0, bytes = 0;
void account(std::size_t n) {
  if (tracking) {
    calls++;
    bytes += n;
  }
}
void require(bool condition, const char *description) {
  if (!condition) {
    std::fprintf(stderr, "Native JSBSim check failed: %s\n", description);
    std::exit(1);
  }
}
double qnorm(const std::array<double, 22> &a) {
  double s = 0;
  for (unsigned i = 6; i < 10; i++)
    s += a[i] * a[i];
  return std::sqrt(s);
}
} // namespace
#ifdef MIRAGE_ALLOCATOR_PROBE
extern "C" void *__real_malloc(std::size_t);
extern "C" void *__real_calloc(std::size_t, std::size_t);
extern "C" void *__real_realloc(void *, std::size_t);
extern "C" void *__wrap_malloc(std::size_t n) {
  account(n);
  return __real_malloc(n);
}
extern "C" void *__wrap_calloc(std::size_t n, std::size_t s) {
  account(n * s);
  return __real_calloc(n, s);
}
extern "C" void *__wrap_realloc(void *p, std::size_t n) {
  account(n);
  return __real_realloc(p, n);
}
extern "C" void *__real_aligned_alloc(std::size_t, std::size_t);
extern "C" int __real_posix_memalign(void **, std::size_t, std::size_t);
extern "C" void *__wrap_aligned_alloc(std::size_t alignment, std::size_t n) {
  account(n);
  return __real_aligned_alloc(alignment, n);
}
extern "C" int __wrap_posix_memalign(void **p, std::size_t alignment,
                                     std::size_t n) {
  account(n);
  return __real_posix_memalign(p, alignment, n);
}
void *operator new(std::size_t n, std::align_val_t alignment) {
  account(n);
  void *p = nullptr;
  if (__real_posix_memalign(&p, static_cast<std::size_t>(alignment),
                            n ? n : 1) != 0)
    throw std::bad_alloc();
  return p;
}
void *operator new[](std::size_t n, std::align_val_t alignment) {
  return ::operator new(n, alignment);
}
void operator delete(void *p, std::align_val_t) noexcept { std::free(p); }
void operator delete[](void *p, std::align_val_t) noexcept { std::free(p); }
void operator delete(void *p, std::size_t, std::align_val_t) noexcept {
  std::free(p);
}
void operator delete[](void *p, std::size_t, std::align_val_t) noexcept {
  std::free(p);
}
void *operator new(std::size_t n) {
  account(n);
  if (auto *p = __real_malloc(n ? n : 1))
    return p;
  throw std::bad_alloc();
}
void *operator new[](std::size_t n) { return ::operator new(n); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p, std::size_t) noexcept { std::free(p); }
void operator delete[](void *p, std::size_t) noexcept { std::free(p); }
#endif
int main(int argc, char **argv) {
  if (argc != 3)
    return 2;
  constexpr double dt = 1.0 / 400;
  auto id = jsb_create(argv[1], argv[2], dt);
  require(id != 0, "load model");
  std::array<double, 4> controls{};
  std::array<double, 22> out{}, previous{}, older{};
  auto stale = id;
  jsb_dispose(id);
  id = jsb_create(argv[1], argv[2], dt);
  require(id != 0 && id != stale, "generation-tagged handle");
  out.fill(42);
  require(jsb_step(stale, controls.data(), 4, out.data(), 22) != 0,
          "stale handle rejected");
  for (double x : out)
    require(x == 42, "rejection preserves output");
  require(jsb_step(id, controls.data(), 4,
                   reinterpret_cast<double *>(controls.data()), 22) != 0,
          "overlapping regions rejected");
  controls[0] = std::numeric_limits<double>::quiet_NaN();
  require(jsb_step(id, controls.data(), 4, out.data(), 22) != 0,
          "nonfinite controls rejected");
  controls[0] = 0;
  const int trimStatus = jsb_trim(id, controls.data(), 4);
  require(trimStatus == 0, "full native trim converges");
  double maxVelocity = 0, maxAcceleration = 0, maxSpecificForce = 0;
  for (unsigned i = 0; i < 400; i++) {
    require(jsb_step(id, controls.data(), 4, out.data(), 22) == 0,
            "finite trimmed step");
    require(std::abs(qnorm(out) - 1) < 1e-10, "normalized wxyz");
    for (double x : out)
      require(std::isfinite(x), "finite SI output");
    if (i > 2) {
      for (unsigned j = 0; j < 3; j++) {
        maxVelocity =
            std::max(maxVelocity, std::abs((out[j] - older[j]) / (2 * dt) -
                                           previous[3 + j]));
        maxAcceleration = std::max(
            maxAcceleration, std::abs((out[3 + j] - older[3 + j]) / (2 * dt) -
                                      previous[19 + j]));
      }
    }
    // Independently rotate reported body specific force using the public
    // quaternion.
    const double qw = out[6], qx = out[7], qy = out[8], qz = out[9],
                 x = out[13], y = out[14], z = out[15];
    const double tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z),
                 tz = 2 * (qx * y - qy * x);
    const double sf[] = {x + qw * tx + qy * tz - qz * ty,
                         y + qw * ty + qz * tx - qx * tz,
                         z + qw * tz + qx * ty - qy * tx};
    for (unsigned j = 0; j < 3; j++)
      maxSpecificForce =
          std::max(maxSpecificForce,
                   std::abs(out[19 + j] - sf[j] - (j == 2 ? out[18] : 0)));
    older = previous;
    previous = out;
  }
  require(maxVelocity < 0.1, "position derivative matches SI velocity");
  require(maxAcceleration < 0.1,
          "velocity derivative matches coordinate acceleration");
  require(maxSpecificForce < 0.05,
          "specific force and gravity frame/sign balance");
  require(jsb_trim(id, controls.data(), 4) != 0,
          "no allocating trim after stepping");
  const double time = out[16];
  require(std::abs(time - 1) < 1e-9, "400 steps equal one simulated second");
  // Keep the actual evolving aircraft, controls and model evaluation in the
  // measured path.
  std::uint64_t trajectoryHash = 14695981039346656037ULL;
  unsigned completed = 0;
  bool finite = true;
#ifdef MIRAGE_ALLOCATOR_PROBE
  tracking = true;
  void *positive = ::operator new(64);
  ::operator delete(positive);
  tracking = false;
  require(calls > 0 && bytes >= 64, "allocator positive control");
  calls = 0;
  bytes = 0;
  tracking = true;
#endif
  for (unsigned batch = 0; batch < 250 && finite; batch++) {
    for (unsigned step = 0; step < 4000; step++) {
      if (jsb_step(id, controls.data(), 4, out.data(), 22) != 0) {
        finite = false;
        break;
      }
      for (double value : out) {
        require(std::isfinite(value), "finite measured trajectory");
        std::uint64_t bits;
        std::memcpy(&bits, &value, sizeof(bits));
        for (unsigned byte = 0; byte < 8; byte++) {
          trajectoryHash ^= (bits >> (8 * byte)) & 255;
          trajectoryHash *= 1099511628211ULL;
        }
      }
      completed++;
    }
    tracking = false;
    jsb_dispose(id);
    if (batch + 1 < 250 && finite) {
      id = jsb_create(argv[1], argv[2], dt);
      require(id != 0, "reload between bounded flight windows");
      require(jsb_trim(id, controls.data(), 4) == 0,
              "trim between bounded flight windows");
      for (unsigned warmup = 0; warmup < 400; warmup++)
        require(jsb_step(id, controls.data(), 4, out.data(), 22) == 0,
                "warmup before allocation window");
    }
#ifdef MIRAGE_ALLOCATOR_PROBE
    tracking = true;
#endif
  }
  tracking = false;
  jsb_dispose(id);
  std::printf(
      "{\"schemaVersion\":1,\"nativeTrimPassed\":true,\"numericalPassed\":true,"
      "\"maxVelocityErrorMps\":%.17g,\"maxAccelerationErrorMps2\":%.17g,"
      "\"maxSpecificForceErrorMps2\":%.17g,\"steps\":%u,\"finite\":%s,"
      "\"allocationCalls\":%zu,\"allocationBytes\":%zu,"
      "\"trajectoryHash\":\"%016llx\",\"allocatorInstrumented\":%s}\n",
      maxVelocity, maxAcceleration, maxSpecificForce, completed,
      finite ? "true" : "false", calls, bytes,
      static_cast<unsigned long long>(trajectoryHash),
#ifdef MIRAGE_ALLOCATOR_PROBE
      "true"
#else
      "false"
#endif
  );
  return finite && completed == 1000000 ? (calls == 0 ? 0 : 2) : 1;
}
