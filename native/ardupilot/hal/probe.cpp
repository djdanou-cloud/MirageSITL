// Native mailbox peer and independent SI/unit/clock oracle.
#include "browser_hal.h"
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>

static std::atomic<bool> counting{false};
static std::atomic<unsigned long> allocations{0};
extern "C" void *__real_malloc(size_t);
extern "C" void *__wrap_malloc(size_t n) {
    if (counting.load()) allocations.fetch_add(1);
    return __real_malloc(n);
}
static uint32_t *shared;
static void put(unsigned i,uint32_t v) { __atomic_store_n(shared+i,v,__ATOMIC_RELEASE); }
static uint32_t get(unsigned i) { return __atomic_load_n(shared+i,__ATOMIC_ACQUIRE); }
static void value(unsigned i,double v) {
    uint64_t bits; std::memcpy(&bits,&v,8); put(16+i*2,uint32_t(bits)); put(17+i*2,uint32_t(bits>>32));
}
static void *firmware(void *) {
    uint16_t pwm[32]{}; pwm[0]=1123; pwm[31]=1987;
    MirageHal::Sensor sensor{};
    for (;;) { MirageHal::exchange(pwm,true,sensor); }
    return nullptr;
}
static void await(uint32_t state) {
    for (unsigned i=0;i<10000000;i++) { if(get(3)==state)return; if((i&1023)==0)usleep(1); }
    std::abort();
}
int main(int argc,char **argv) {
    const unsigned hz=argc>1?unsigned(std::atoi(argv[1])):800;
    const unsigned steps=argc>2?unsigned(std::atoi(argv[2])):1000;
    shared=reinterpret_cast<uint32_t *>(mirage_hal_mailbox());
    assert(mirage_hal_version()==1 && mirage_hal_configure(hz,7)==0);
    assert(mirage_hal_configure(0,7)==-1);
    pthread_t thread; assert(pthread_create(&thread,nullptr,firmware,nullptr)==0);
    value(0,32); value(1,35); value(2,100); value(3,4); value(4,-2); value(5,1);
    value(6,0.25); value(7,-0.5); value(8,-9.80665);
    value(9,0.1); value(10,-0.2); value(11,0.3);
    value(12,std::cos(0.25)); value(15,std::sin(0.25));
    value(16,0.21); value(17,-0.03); value(18,0.43); value(20,16); value(22,2);
    // A real allocating control proves the counter is active.
    counting=true; void *volatile control=std::malloc(32); counting=false;
    assert(control!=nullptr && allocations.load()>0); std::free(control);
    allocations=0;
    for(unsigned n=0;n<steps+1000;n++) {
        await(MirageHal::Requested);
        assert(get(6)==n && get(7)==0 && get(11)==32 && get(128)==1123 && get(159)==1987);
        const uint64_t us=(uint64_t(n)+1)*1000000/hz;
        put(14,uint32_t(us)); put(15,uint32_t(us>>32)); put(8,n+1);
        if(n==1000)counting=true;
        put(3,MirageHal::Supplied); mirage_hal_notify();
    }
    await(MirageHal::Requested); counting=false;
    double d[16]; for(unsigned i=0;i<16;i++) {
        uint64_t bits=uint64_t(get(192+i*2))|(uint64_t(get(193+i*2))<<32);std::memcpy(d+i,&bits,8);
    }
    assert(std::abs(d[0]-0.1*180/std::acos(-1.0))<1e-12);
    assert(std::abs(d[3]-210)<1e-12 && std::abs(d[8]-0.5*180/std::acos(-1.0))<1e-12);
    assert(d[9]==0.25 && d[12]==4);
    mirage_hal_stop(); await(MirageHal::Stopped);
    pthread_cancel(thread); pthread_join(thread,nullptr);
    std::printf("{\"hz\":%u,\"steps\":%u,\"allocationCalls\":%lu,\"positiveControl\":true,\"gyroDegS\":%.17g,\"magMilliGauss\":%.17g,\"yawDeg\":%.17g,\"timestampUs\":%.0f,\"stopped\":true}\n",hz,steps,allocations.load(),d[0],d[3],d[8],d[15]);
    assert(allocations.load()==0);
}
