// Mirage JSBSim bridge ABI v1. JSBSim owns aircraft integration.
// Core library LGPL-2.1; aircraft data must carry its own reviewed license.
#include <FGFDMExec.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <initialization/FGTrim.h>
#include <limits>
#include <math/FGQuaternion.h>
#include <memory>
#include <models/FGAccelerations.h>
#include <models/FGPropagate.h>
#include <models/FGMassBalance.h>
#include <models/FGGroundReactions.h>
#ifdef __EMSCRIPTEN__
#include <emscripten/heap.h>
#endif
namespace {
constexpr double FT_M = 0.3048;
struct Session {
  JSBSim::FGFDMExec exec;
  std::array<SGPropertyNode *, 4> controls{};
  JSBSim::FGColumnVector3 origin;
  JSBSim::FGMatrix33 ecef_to_origin;
  double dt = 0;
  bool stepped = false;
  bool contact_pending = false;
};
std::array<std::unique_ptr<Session>, 16> sessions;
std::array<unsigned, 16> generations{};
Session *lookup(unsigned token) {
  const unsigned slot = token & 15U, generation = token >> 4U;
  if (!generation || generations[slot] != generation)
    return nullptr;
  return sessions[slot].get();
}
void capture_origin(Session &session) {
  const auto p = session.exec.GetPropagate();
  for (unsigned j = 1; j <= 3; j++)
    session.origin(j) = p->GetLocation(j);
  session.ecef_to_origin = p->GetTec2l();
}
bool region(const double *ptr, unsigned count) {
  if (!ptr || reinterpret_cast<uintptr_t>(ptr) % 8 != 0)
    return false;
#ifdef __EMSCRIPTEN__
  const auto start = reinterpret_cast<uintptr_t>(ptr);
  if (start > emscripten_get_heap_size() ||
      count > (emscripten_get_heap_size() - start) / 8)
    return false;
#endif
  return true;
}
} // namespace
extern "C" {
unsigned jsb_abi_version() { return 1; }
int jsb_read_state(unsigned, double *, unsigned);
// Model/root strings and session allocation are cold configuration only.
unsigned jsb_create(const char *root, const char *model, double dt) {
  if (!root || !model ||
      !(dt == 1.0 / 400 || dt == 1.0 / 800 || dt == 1.0 / 1200))
    return 0;
  try {
    for (unsigned i = 0; i < sessions.size(); i++)
      if (!sessions[i] &&
          generations[i] < (std::numeric_limits<unsigned>::max() >> 4U)) {
        auto s = std::make_unique<Session>();
        s->exec.SetDebugLevel(0);
        s->exec.SetRootDir(SGPath(root));
        s->exec.SetAircraftPath(SGPath("aircraft"));
        s->exec.SetEnginePath(SGPath("engine"));
        s->exec.SetSystemsPath(SGPath("systems"));
        s->exec.Setdt(dt);
        if (!s->exec.LoadModel(model))
          return 0;
#ifdef MIRAGE_CONTACT_IMPULSE
        const auto gears=s->exec.GetGroundReactions()->GetNumGearUnits();
        if(gears<0||gears>64)return 0;
        s->exec.GetAccelerations()->ReserveGroundConstraintStorage(2*gears);
#endif
        s->exec.DisableOutput();
        s->exec.SetPropertyValue("ic/h-sl-ft", 1000.0);
        s->exec.SetPropertyValue("ic/u-fps", 150.0);
        s->exec.SetPropertyValue("ic/lat-gc-deg", 0.0);
        s->exec.SetPropertyValue("ic/long-gc-deg", 0.0);
        if (!s->exec.RunIC())
          return 0;
        const char *names[] = {"fcs/throttle-cmd-norm", "fcs/aileron-cmd-norm",
                               "fcs/elevator-cmd-norm", "fcs/rudder-cmd-norm"};
        for (unsigned j = 0; j < 4; j++) {
          s->controls[j] =
              s->exec.GetPropertyManager()->GetNode(names[j], true);
          if (!s->controls[j])
            return 0;
        }
        capture_origin(*s);
        s->dt = dt;
        sessions[i] = std::move(s);
        return (++generations[i] << 4U) | i;
      }
  } catch (...) {
    return 0;
  }
  return 0;
}
// Output 22 f64: pos NED3, velocity NED3, body-to-NED wxyz4,
// body gyro3, FRD specific force3, simulation time, ASL height, gravity
// magnitude, origin-NED coordinate acceleration3. Position, velocity, attitude
// share one fixed origin.
int jsb_step(unsigned id, const double *command, unsigned count, double *out,
             unsigned out_count) {
  if (!lookup(id) || count != 4 || out_count != 22 || !region(command, count) ||
      !region(out, out_count))
    return -1;
  for (unsigned j = 0; j < 4; j++)
    if (!std::isfinite(command[j]) || command[j] < (j == 0 ? 0.0 : -1.0) ||
        command[j] > 1.0)
      return -2;
  const auto input_begin = reinterpret_cast<uintptr_t>(command),
             output_begin = reinterpret_cast<uintptr_t>(out);
  if (input_begin > std::numeric_limits<uintptr_t>::max() - 32 ||
      output_begin > std::numeric_limits<uintptr_t>::max() - 176 ||
      (input_begin < output_begin + 176 && output_begin < input_begin + 32))
    return -1;
  auto &s = *lookup(id);
  s.stepped = true;
  for (unsigned j = 0; j < 4; j++)
    s.controls[j]->setDoubleValue(command[j]);
  if (!s.exec.Run())
    return -3;
  s.contact_pending = true;
  return jsb_read_state(id,out,out_count);
}
// Snapshot only; never advances time or mutates integration state.
int jsb_read_state(unsigned id, double *out, unsigned out_count) {
  if (!lookup(id) || out_count != 22 || !region(out,out_count)) return -1;
  auto &s = *lookup(id);
  const auto p = s.exec.GetPropagate();
  const auto a = s.exec.GetAccelerations();
  JSBSim::FGColumnVector3 delta;
  for (unsigned j = 1; j <= 3; j++)
    delta(j) = p->GetLocation(j) - s.origin(j);
  const auto local = s.ecef_to_origin * delta;
  double scratch[22];
  const auto body_to_origin = s.ecef_to_origin * p->GetTb2ec();
  const auto velocity = body_to_origin * p->GetUVW();
  const auto accel =
      body_to_origin * (a->GetUVWdot() + p->GetPQR() * p->GetUVW());
  for (unsigned j = 0; j < 3; j++) {
    scratch[j] = local(j + 1) * FT_M;
    scratch[3 + j] = velocity(j + 1) * FT_M;
    scratch[19 + j] = accel(j + 1) * FT_M;
    scratch[10 + j] = p->GetPQR(j + 1);
    scratch[13 + j] = a->GetBodyAccel(j + 1) * FT_M;
  }
  // Convert the fixed-origin body matrix using JSBSim's passive convention.
  const JSBSim::FGQuaternion q(body_to_origin.Transposed());
  for (unsigned j = 0; j < 4; j++)
    scratch[6 + j] = q(j + 1);
  scratch[16] = s.exec.GetSimTime();
  scratch[17] = p->GetAltitudeASLmeters();
  scratch[18] = a->GetGravAccelMagnitude() * FT_M;
  for (double v : scratch)
    if (!std::isfinite(v))
      return -4;
  for (unsigned j = 0; j < 22; j++)
    out[j] = scratch[j];
  return 0;
}
// Cold setup ABI v1: lat/lon rad, ASL m, roll/pitch/yaw rad, body velocity
// m/s, body angular rate rad/s, terrain ASL m. No hot reset/heap growth.
int jsb_set_initial_state(unsigned id,const double*values,unsigned count) {
  auto *s=lookup(id);
  if(!s||s->stepped||count!=13||!region(values,count))return -1;
  for(unsigned i=0;i<13;i++)if(!std::isfinite(values[i]))return -2;
  if(std::abs(values[0])>1.5707963267948966||std::abs(values[1])>3.141592653589793||values[2]<-1000||values[2]>1000000)return -2;
  const char *names[]={"ic/lat-gc-deg","ic/long-gc-deg","ic/h-sl-ft","ic/phi-rad","ic/theta-rad","ic/psi-rad","ic/u-fps","ic/v-fps","ic/w-fps","ic/p-rad_sec","ic/q-rad_sec","ic/r-rad_sec","ic/terrain-elevation-ft"};
  for(unsigned i=0;i<13;i++)s->exec.SetPropertyValue(names[i],values[i]*(i<2?57.29577951308232:(i==2||(i>=6&&i<=8)||i==12?1/FT_M:1)));
  if(!s->exec.RunIC())return -3;
  capture_origin(*s);s->contact_pending=false;return 0;
}
unsigned jsb_contact_abi_version() {
#ifdef MIRAGE_CONTACT_IMPULSE
  return 1;
#else
  return 0;
#endif
}
// Cold/dynamic mass query for nonintegrating constraint solvers: kg and full
// row-major body inertia kg m^2. Fuel burn can change these values.
int jsb_mass_properties(unsigned id,double *out,unsigned count) {
  if(!lookup(id)||count!=10||!region(out,count))return -1;
  constexpr double SLUG_KG=4.4482216152605/FT_M;
  const auto mass=lookup(id)->exec.GetMassBalance();
  out[0]=mass->GetMass()*SLUG_KG;
  for(unsigned i=0;i<3;i++)for(unsigned j=0;j<3;j++)out[1+3*i+j]=mass->GetJ()(i+1,j+1)*SLUG_KG*FT_M*FT_M;
  return 0;
}
// Additive contact ABI v1: origin-NED linear impulse N s, then body angular
// impulse N m s. Applied once after a successful fixed step, with no pose/time
// integration. A nonintegrating constraint stage must own the impulse solve.
int jsb_apply_contact(unsigned id,const double *impulse,unsigned count,
                      double *out,unsigned out_count) {
#ifndef MIRAGE_CONTACT_IMPULSE
  return -5;
#else
  auto *s=lookup(id);
  if(!s || !s->contact_pending || count!=6 || out_count!=22 ||
     !region(impulse,count) || !region(out,out_count))return -1;
  // Built-in loaded gear owns its active ground constraints. Never apply a
  // second externally solved ground impulse to the same active contact tick.
  if(s->exec.GetGroundReactions()->GetWOW())return -5;
  const auto ib=reinterpret_cast<uintptr_t>(impulse),ob=reinterpret_cast<uintptr_t>(out);
  if(ib>std::numeric_limits<uintptr_t>::max()-48 || ob>std::numeric_limits<uintptr_t>::max()-176 ||
     (ib<ob+176 && ob<ib+48))return -1;
  for(unsigned j=0;j<6;j++)if(!std::isfinite(impulse[j]))return -2;
  constexpr double LBF_N=4.4482216152605;
  const auto p=s->exec.GetPropagate();
  const auto mass=s->exec.GetMassBalance();
  if(!(mass->GetMass()>0))return -4;
  const auto body_to_origin=s->ecef_to_origin*p->GetTb2ec();
  const JSBSim::FGColumnVector3 linear(impulse[0],impulse[1],impulse[2]);
  const JSBSim::FGColumnVector3 angular(impulse[3],impulse[4],impulse[5]);
  const auto dv=body_to_origin.Transposed()*linear/(LBF_N*mass->GetMass());
  const auto dw=mass->GetJinv()*(angular/(LBF_N*FT_M));
  for(unsigned j=1;j<=3;j++)if(!std::isfinite(dv(j))||!std::isfinite(dw(j)))return -2;
  p->ApplyBodyImpulse(dv,dw);
  s->contact_pending=false;
  const int status=jsb_read_state(id,out,out_count);
  if(status!=0)return status;
  const auto local_dv=body_to_origin*dv;
  for(unsigned j=0;j<3;j++) {
    out[13+j]+=dv(j+1)*FT_M/s->dt;
    out[19+j]+=local_dv(j+1)*FT_M/s->dt;
  }
  return 0;
#endif
}
// Cold full trim only, before any integration. This may allocate in upstream
// code.
int jsb_trim(unsigned id, double *controls, unsigned count) {
  auto *s = lookup(id);
  if (!s || s->stepped || count != 4 || !region(controls, count))
    return -1;
  try {
    s->exec.SetPropertyValue("fcs/mixture-cmd-norm", 1.0);
    s->exec.SetPropertyValue("propulsion/set-running", -1.0);
    JSBSim::FGTrim trim(&s->exec, JSBSim::tFull);
    trim.SetTolerance(1e-6);
    if (!trim.DoTrim())
      return -2;
    double values[4];
    for (unsigned i = 0; i < 4; i++) {
      values[i] = s->controls[i]->getDoubleValue();
      if (!std::isfinite(values[i]) || values[i] < (i == 0 ? 0.0 : -1.0) ||
          values[i] > 1.0)
        return -3;
    }
    capture_origin(*s);
    for (unsigned i = 0; i < 4; i++)
      controls[i] = values[i];
    return 0;
  } catch (...) {
    return -2;
  }
}
void jsb_dispose(unsigned id) {
  if (lookup(id))
    sessions[id & 15U].reset();
}
}
#ifdef MIRAGE_JSBSIM_NATIVE_SMOKE
int main(int argc, char **argv) {
  if (argc != 3)
    return 2;
  const unsigned id = jsb_create(argv[1], argv[2], 1.0 / 400);
  if (!id)
    return 3;
  double c[4] = {0, 0, 0, 0}, out[22];
  for (unsigned i = 0; i < 400; i++)
    if (jsb_step(id, c, 4, out, 22) != 0)
      return 4;
  for (double v : out)
    std::printf("%.17g ", v);
  std::puts("");
  jsb_dispose(id);
  return 0;
}
#endif
