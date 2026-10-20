// Native malformed-frame tests exercise the consumer independently of JS guards.
#include "browser_hal.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
static uint32_t *words;
static MirageHal::Sensor output{777,{}};
static uint32_t get(unsigned i){return __atomic_load_n(words+i,__ATOMIC_ACQUIRE);}
static void put(unsigned i,uint32_t v){__atomic_store_n(words+i,v,__ATOMIC_RELEASE);}
static void *firmware(void *){uint16_t pwm[32]{};MirageHal::exchange(pwm,false,output);return nullptr;}
static void await(uint32_t state){
    for(unsigned i=0;i<10000000;i++){if(get(3)==state)return;if((i&1023)==0)usleep(1);}std::abort();
}
int main(int argc,char **argv){
    assert(argc==2);const unsigned kind=unsigned(std::atoi(argv[1]));assert(kind<9);
    words=reinterpret_cast<uint32_t *>(mirage_hal_mailbox());
    assert(mirage_hal_configure(800,7)==0);
    pthread_t thread;assert(pthread_create(&thread,nullptr,firmware,nullptr)==0);await(MirageHal::Requested);
    uint64_t bits;const double one=1;std::memcpy(&bits,&one,8);put(40,uint32_t(bits));put(41,uint32_t(bits>>32));
    put(8,1);put(14,1250);
    const unsigned offsets[]={0,1,2,5,8,11,13,14,41};
    const uint32_t values[]={0,2,64,8,2,33,1,0,1};put(offsets[kind],values[kind]);
    put(3,MirageHal::Supplied);mirage_hal_notify();await(MirageHal::Fault);
    assert(get(10)==1 && output.timestamp_us==777 && get(192)==0 && get(193)==0);
    pthread_cancel(thread);pthread_join(thread,nullptr);
    std::printf("{\"case\":%u,\"nativeRejected\":true,\"outputUnchanged\":true}\n",kind);
}
