// The real HAL kernel in isolation: allocator instrumentation is test-only.
// This is not replacement ArduPilot firmware or flight acceptance evidence.
#include "browser_hal.h"
#include <emscripten.h>
#include <atomic>
#include <cstdlib>
static std::atomic<bool> counting{false};
static std::atomic<uint32_t> calls{0}, bytes{0};
extern "C" void *__real_malloc(size_t);
extern "C" void *__wrap_malloc(size_t n) {
    if(counting.load()) { calls.fetch_add(1); bytes.fetch_add(uint32_t(n)); }
    return __real_malloc(n);
}
extern "C" EMSCRIPTEN_KEEPALIVE void mirage_probe_count_begin() { calls=0;bytes=0;counting=true; }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t mirage_probe_count_end() { counting=false;return calls.load(); }
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t mirage_probe_bytes() {return bytes.load();}
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t mirage_probe_control() {
    counting=true;void *volatile p=std::malloc(32);counting=false;std::free(p);return calls.load();
}
int main() {
    uint16_t pwm[32]{};pwm[0]=1000;pwm[1]=1250;pwm[2]=1750;pwm[3]=2000;
    MirageHal::Sensor sensor{};
    for(;;)MirageHal::exchange(pwm,true,sensor);
}
