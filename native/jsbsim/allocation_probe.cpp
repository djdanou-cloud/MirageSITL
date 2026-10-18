// Actual allocator instrumentation, shared by native and WASM verification.
#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <new>
namespace {
// Volatile prevents the compiler from assuming malloc cannot affect private
// counters: the linker's --wrap rewrite happens after that optimization stage.
volatile bool tracking = false;
volatile std::uint64_t calls = 0, bytes = 0;
void account(std::size_t n) { if (tracking) { ++calls; bytes += n; } }
void *volatile positive_pointer = nullptr;
}
extern "C" {
void *__real_malloc(std::size_t);
void *__real_calloc(std::size_t, std::size_t);
void *__real_realloc(void *, std::size_t);
void *__real_aligned_alloc(std::size_t, std::size_t);
int __real_posix_memalign(void **,std::size_t,std::size_t);
void *__wrap_malloc(std::size_t n) { account(n); return __real_malloc(n); }
void *__wrap_calloc(std::size_t n, std::size_t s) { account(n*s); return __real_calloc(n,s); }
void *__wrap_realloc(void *p,std::size_t n) { account(n); return __real_realloc(p,n); }
void *__wrap_aligned_alloc(std::size_t a,std::size_t n) { account(n); return __real_aligned_alloc(a,n); }
int __wrap_posix_memalign(void **p,std::size_t a,std::size_t n) { account(n); return __real_posix_memalign(p,a,n); }
void jsb_allocation_track(unsigned enabled) { tracking = enabled != 0; }
double jsb_allocation_calls() { return static_cast<double>(calls); }
double jsb_allocation_bytes() { return static_cast<double>(bytes); }
unsigned jsb_allocator_probe() {
  if (tracking) return 0;
  calls = bytes = 0; tracking = true;
  positive_pointer = std::malloc(64);
  tracking = false;
  const bool detected = positive_pointer && calls > 0 && bytes >= 64;
  std::free(positive_pointer); positive_pointer = nullptr;
  calls = bytes = 0;
  return detected;
}
}
void *operator new(std::size_t n) { if (auto p=std::malloc(n)) return p; throw std::bad_alloc(); }
void *operator new[](std::size_t n) { return ::operator new(n); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p,std::size_t) noexcept { std::free(p); }
void operator delete[](void *p,std::size_t) noexcept { std::free(p); }
void *operator new(std::size_t n,std::align_val_t a) { void *p=nullptr; if(::posix_memalign(&p,static_cast<std::size_t>(a),n)!=0)throw std::bad_alloc();return p; }
void *operator new[](std::size_t n,std::align_val_t a) { return ::operator new(n,a); }
void operator delete(void *p,std::align_val_t) noexcept { std::free(p); }
void operator delete[](void *p,std::align_val_t) noexcept { std::free(p); }
void operator delete(void *p,std::size_t,std::align_val_t) noexcept { std::free(p); }
void operator delete[](void *p,std::size_t,std::align_val_t) noexcept { std::free(p); }
