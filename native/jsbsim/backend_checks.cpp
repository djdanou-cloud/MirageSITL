// Real native oracle and whole-engine allocation probe. No model data bundled.
#include <array>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
extern "C" {
unsigned jsb_create(const char*,const char*,double);
int jsb_trim(unsigned,double*,unsigned);
int jsb_step(unsigned,const double*,unsigned,double*,unsigned);
int jsb_apply_contact(unsigned,const double*,unsigned,double*,unsigned);
int jsb_mass_properties(unsigned,double*,unsigned);
int jsb_set_initial_state(unsigned,const double*,unsigned);
void jsb_dispose(unsigned);
void jsb_allocation_track(unsigned);
double jsb_allocation_calls();
double jsb_allocation_bytes();
unsigned jsb_allocator_probe();
}
void require(bool ok,const char*message){if(!ok){std::fprintf(stderr,"%s\n",message);std::exit(1);}}
int main(int argc,char**argv){
  if(argc!=3)return 2;
  std::puts("{\"schemaVersion\":1,\"cases\":[");bool first=true;
  for(unsigned hz:{400U,800U,1200U}){
    const unsigned id=jsb_create(argv[1],argv[2],1.0/hz);require(id,"stationary create");
    std::array<double,13> initial{};initial[2]=2;
    require(jsb_set_initial_state(id,initial.data(),13)==0,"stationary initial state");
    std::array<double,4> controls{};std::array<double,22> out{};
    for(unsigned i=0;i<10*hz;i++)require(jsb_step(id,controls.data(),4,out.data(),22)==0,"ground settling");
    const double speed=std::hypot(out[3],out[4],out[5]);
    const double acceleration=std::hypot(out[19],out[20],out[21]);
    const double qw=out[6],qx=out[7],qy=out[8],qz=out[9],x=out[13],y=out[14],z=out[15];
    const double tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x);
    const double sfz=z+qw*tz+qx*ty-qy*tx;
    require(speed<.02 && acceleration<.05 && std::abs(sfz+out[18])<.05,"stationary specific force/frame oracle");
    std::array<double,6> impulse{};require(jsb_apply_contact(id,impulse.data(),6,out.data(),22)==-5,"double ground ownership accepted");
    require(jsb_allocator_probe()==1,"ground positive control");jsb_allocation_track(1);
    for(unsigned i=0;i<1000000;i++)require(jsb_step(id,controls.data(),4,out.data(),22)==0,"ground allocation step");
    jsb_allocation_track(0);
    require(jsb_allocation_calls()==0&&jsb_allocation_bytes()==0,"ground allocator gate failed");
    std::printf("{\"stationary\":true,\"hz\":%u,\"steps\":1000000,\"speedMps\":%.17g,\"accelerationMps2\":%.17g,\"specificDownMps2\":%.17g,\"gravityMps2\":%.17g,\"allocationCalls\":%.0f,\"allocationBytes\":%.0f}\n",hz,speed,acceleration,sfz,out[18],jsb_allocation_calls(),jsb_allocation_bytes());
    jsb_dispose(id);
  }
  for(unsigned hz:{400U,800U,1200U})for(unsigned scenario:{0U,1U,2U}){
    unsigned id=jsb_create(argv[1],argv[2],1.0/hz);require(id,"create");
    std::array<double,4> control{};std::array<double,22> out{};std::array<double,6> impulse{};
    require(jsb_trim(id,control.data(),4)==0,"native trim");const auto trim=control;
    require(jsb_allocator_probe()==1,"native allocator positive control");
    std::array<std::array<double,22>,10> samples{};
    double momentumError=0;
    for(unsigned tick=0;tick<10*hz;tick++){
      if(scenario==1 && tick==hz){control[1]+=.01;control[2]-=.01;}
      require(jsb_step(id,control.data(),4,out.data(),22)==0,"native step");
      if(scenario==2 && tick==2*hz){
        const auto before=out;double mass[10];require(jsb_mass_properties(id,mass,10)==0,"mass");
        impulse={1,-2,-3,.1,-.2,.3};
        require(jsb_apply_contact(id,impulse.data(),6,out.data(),22)==0,"contact");
        for(unsigned j=0;j<3;j++)momentumError=std::fmax(momentumError,std::abs((out[3+j]-before[3+j])*mass[0]-impulse[j]));
        for(unsigned i=0;i<3;i++){
          double k=0;for(unsigned j=0;j<3;j++)k+=mass[1+3*i+j]*(out[10+j]-before[10+j]);
          momentumError=std::fmax(momentumError,std::abs(k-impulse[3+i]));
          require(out[i]==before[i],"contact reintegrated position");
        }
        require(out[16]==before[16],"contact advanced time");
        require(jsb_apply_contact(id,impulse.data(),6,out.data(),22)==-1,"duplicate contact accepted");
      }
      if((tick+1)%hz==0)samples[(tick+1)/hz-1]=out;
    }
    require(momentumError<1e-8,"contact momentum mismatch");
    jsb_dispose(id);
    // Reset only between bounded evolving flight windows. One million actual
    // hot steps per rate/scenario; cold setup and trim excluded explicitly.
    double calls=0,bytes=0;unsigned completed=0;
    while(completed<1000000){
      id=jsb_create(argv[1],argv[2],1.0/hz);require(id,"reload");control=trim;
      require(jsb_trim(id,control.data(),4)==0,"retrim");
      for(unsigned t=0;t<hz;t++)require(jsb_step(id,control.data(),4,out.data(),22)==0,"warm");
      require(jsb_allocator_probe()==1,"probe");jsb_allocation_track(1);
      const unsigned n=std::min(4000U,1000000U-completed);
      for(unsigned t=0;t<n;t++){
        require(jsb_step(id,control.data(),4,out.data(),22)==0,"measured step");
        if(scenario==2){impulse.fill(0);impulse[2]=-0.0001;require(jsb_apply_contact(id,impulse.data(),6,out.data(),22)==0,"measured contact");}
      }
      jsb_allocation_track(0);calls+=jsb_allocation_calls();bytes+=jsb_allocation_bytes();completed+=n;jsb_dispose(id);
    }
    require(calls==0&&bytes==0,"native allocator gate failed");
    if(!first)std::puts(",");first=false;
    std::printf("{\"hz\":%u,\"scenario\":%u,\"steps\":%u,\"allocationCalls\":%.0f,\"allocationBytes\":%.0f,\"momentumError\":%.17g,\"trim\":[",hz,scenario,completed,calls,bytes,momentumError);
    for(unsigned j=0;j<4;j++)std::printf("%s%.17g",j?",":"",trim[j]);
    std::printf("],\"samples\":[");for(unsigned i=0;i<10;i++){if(i)std::printf(",");std::printf("[");for(unsigned j=0;j<22;j++)std::printf("%s%.17g",j?",":"",samples[i][j]);std::printf("]");}std::printf("]}\n");
  }std::puts("]}");
}
