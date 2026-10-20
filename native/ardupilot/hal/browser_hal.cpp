#include "browser_hal.h"
#include <cmath>
#include <cstring>
#include <pthread.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

namespace {
alignas(64) uint32_t words[256] = {MirageHal::MAGIC, 1, 1024, 0, 800, 1};
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
uint64_t tick = 0;
uint32_t configured_hz = 800, configured_epoch = 1;
uint32_t load(unsigned i) { return __atomic_load_n(words+i, __ATOMIC_ACQUIRE); }
void store(unsigned i, uint32_t value) { __atomic_store_n(words+i, value, __ATOMIC_RELEASE); }
double read_double(unsigned i) {
    uint64_t bits = uint64_t(load(i)) | (uint64_t(load(i+1)) << 32);
    double value; std::memcpy(&value, &bits, 8); return value;
}
void write_double(unsigned i, double value) {
    uint64_t bits; std::memcpy(&bits, &value, 8);
    store(i, uint32_t(bits)); store(i+1, uint32_t(bits >> 32));
}
bool decode(MirageHal::Sensor &s) {
    const uint32_t hz = load(4);
    if ((hz != 400 && hz != 800 && hz != 1200) || load(0) != MirageHal::MAGIC ||
        load(1) != 1 || load(2) != 1024 || hz != configured_hz || load(5) != configured_epoch || load(13) != 0 ||
        load(6) != uint32_t(tick) || load(7) != uint32_t(tick >> 32) || load(9) != uint32_t(tick) ||
        load(10) != 0 || load(11) != 32 || load(12) > 1 ||
        load(8) != uint32_t(tick+1)) return false;
    s.timestamp_us = uint64_t(load(14)) | (uint64_t(load(15)) << 32);
    if (tick >= 9007199254ULL || s.timestamp_us != ((tick+1)*1000000ULL)/hz) return false;
    for (unsigned i=0; i<40; i++) {
        s.values[i] = read_double(16+i*2);
        if (!std::isfinite(s.values[i]) || std::abs(s.values[i]) > 1e9) return false;
    }
    const auto &v = s.values;
    double norm = 0;
    for (unsigned i=12; i<16; i++) norm += v[i]*v[i];
    if (std::abs(v[0]) > 90 || std::abs(v[1]) > 180 || std::abs(v[2]) > 100000 ||
        std::abs(norm-1) > 1e-6 || v[19] < 0 || v[20] < 0 || v[21] < 0 || v[22] < 0) return false;
    for (unsigned i=23; i<35; i++) if (v[i] < 0 || v[i] > 1) return false;
    for (unsigned i=92; i<128; i++) if (load(i) != 0) return false;
    for (unsigned i=160; i<192; i++) if (load(i) != 0) return false;
    for (unsigned i=224; i<256; i++) if (load(i) != 0) return false;
    return true;
}
}

double MirageHal::degrees(double radians) { return radians*57.2957795130823208768; }
void MirageHal::diagnostics(const Sensor &s, double out[16]) {
    const auto &v = s.values;
    for (unsigned i=0; i<3; i++) { out[i] = degrees(v[9+i]); out[3+i] = v[16+i]*1000; }
    const double w=v[12], x=v[13], y=v[14], z=v[15];
    out[6] = degrees(std::atan2(2*(w*x+y*z), 1-2*(x*x+y*y)));
    out[7] = degrees(std::asin(std::fmax(-1.0,std::fmin(1.0,2*(w*y-z*x)))));
    out[8] = degrees(std::atan2(2*(w*z+x*y), 1-2*(y*y+z*z)));
    for (unsigned i=0; i<3; i++) { out[9+i] = v[6+i]; out[12+i] = v[3+i]; }
    out[15] = double(s.timestamp_us);
}

bool MirageHal::exchange(const uint16_t pwm[32], bool armed, Sensor &out) {
    pthread_mutex_lock(&mutex);
    if (load(3) == Stop) { store(3,Stopped); }
    if (load(3) != Stopped && load(3) != Fault) {
        for (unsigned i=0; i<32; i++) store(128+i,pwm[i]);
        store(6,uint32_t(tick)); store(7,uint32_t(tick >> 32));
        store(9,uint32_t(tick)); store(11,32); store(12,armed ? 1 : 0);
        store(3,Requested);
    }
    for (;;) {
        const uint32_t state = load(3);
        if (state == Supplied) break;
        if (state == Stop) store(3,Stopped);
        // Paused, stopped and faulted firmware sleeps until its owned thread is
        // terminated. It never advances the simulator clock or spins a CPU.
#ifdef __EMSCRIPTEN__
        // Wait on the published state itself. Host notification never acquires
        // a contended pthread mutex or enters a clock/proxy slow path. The
        // futex's expected-value check prevents a lost wake between unlock
        // and wait when the host already supplied the next input.
        const uint32_t expected=load(3);
        pthread_mutex_unlock(&mutex);
        if(expected != Supplied) emscripten_futex_wait(words+3,expected,INFINITY);
        pthread_mutex_lock(&mutex);
#else
        pthread_cond_wait(&condition,&mutex);
#endif
    }
    Sensor staged{};
    if (!decode(staged)) {
        store(10,1); store(3,Fault);
        for (;;) pthread_cond_wait(&condition,&mutex);
    }
    double diag[16]; diagnostics(staged,diag);
    for (unsigned i=0; i<16; i++) write_double(192+i*2,diag[i]);
    out = staged; tick++;
    pthread_mutex_unlock(&mutex);
    return true;
}

extern "C" {
EXPORT uint32_t mirage_hal_version() { return MirageHal::VERSION; }
EXPORT uintptr_t mirage_hal_mailbox() { return reinterpret_cast<uintptr_t>(words); }
EXPORT int32_t mirage_hal_configure(uint32_t hz, uint32_t epoch) {
    pthread_mutex_lock(&mutex);
    const bool valid = (hz == 400 || hz == 800 || hz == 1200) && epoch != 0 && tick == 0 &&
        (load(3) == MirageHal::Initial || load(3) == MirageHal::Requested);
    if (valid) { configured_hz=hz; configured_epoch=epoch; store(4,hz); store(5,epoch); }
    pthread_mutex_unlock(&mutex);
    return valid ? 0 : -1;
}
EXPORT void mirage_hal_notify() {
#ifdef __EMSCRIPTEN__
    emscripten_futex_wake(words+3,1);
#else
    pthread_mutex_lock(&mutex); pthread_cond_broadcast(&condition); pthread_mutex_unlock(&mutex);
#endif
}
EXPORT void mirage_hal_stop() { store(3,MirageHal::Stop); mirage_hal_notify(); }
}
