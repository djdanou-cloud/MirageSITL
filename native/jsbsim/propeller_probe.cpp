// TASK-086: load a UIUC-derived propeller definition in pinned JSBSim and report
// the thrust FGPropeller::Calculate produces at prescribed RPM and advance ratio.
// Usage: mirage_jsbsim_propeller_probe ROOT AIRCRAFT < "rpm J" lines.
// ROOT holds aircraft/AIRCRAFT/AIRCRAFT.xml and engine/ (written by
// scripts/check-jsbsim-propellers.mjs). Prints one JSON object per point.
#include <cmath>
#include <cstdio>
#include <iostream>
#include <memory>
#include <string>

#include "FGFDMExec.h"
#include "initialization/FGInitialCondition.h"
#include "models/FGAtmosphere.h"
#include "models/FGPropulsion.h"
#include "models/propulsion/FGEngine.h"
#include "models/propulsion/FGPropeller.h"

using namespace JSBSim;

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "usage: mirage_jsbsim_propeller_probe ROOT AIRCRAFT\n";
    return 2;
  }
  auto fdm = std::make_unique<FGFDMExec>();
  fdm->SetDebugLevel(0);
  fdm->SetRootDir(SGPath(argv[1]));
  fdm->SetAircraftPath(SGPath("aircraft"));
  fdm->SetEnginePath(SGPath("engine"));
  fdm->SetSystemsPath(SGPath("systems"));
  if (!fdm->LoadModel(argv[2])) {
    std::cerr << "LoadModel failed\n";
    return 1;
  }
  auto propulsion = fdm->GetPropulsion();
  if (propulsion->GetNumEngines() != 1) return 1;
  auto propeller = dynamic_cast<FGPropeller*>(propulsion->GetEngine(0)->GetThruster());
  if (propeller == nullptr) {
    std::cerr << "thruster is not a propeller\n";
    return 1;
  }
  // Ixx is not read: v1.2.3 assigns it only when <ixx> is present.
  std::printf("{\"kind\":\"loaded\",\"diameterFt\":%.17g}\n", propeller->GetDiameter());
  double rpm = 0.0, j = 0.0;
  while (std::cin >> rpm >> j) {
    const double rps = rpm / 60.0;
    const double speedFps = j * rps * propeller->GetDiameter();
    auto ic = fdm->GetIC();
    ic->SetTerrainElevationFtIC(0.0);
    ic->SetAltitudeASLFtIC(0.0);
    ic->SetUBodyFpsIC(speedFps);
    ic->SetVBodyFpsIC(0.0);
    ic->SetWBodyFpsIC(0.0);
    ic->SetThetaRadIC(0.0);
    ic->SetPhiRadIC(0.0);
    ic->SetPsiRadIC(0.0);
    if (!fdm->RunIC()) return 1;
    // RunIC loaded the propulsion inputs (density, body air velocity). Thrust
    // is computed from the RPM at entry, before Calculate integrates RPM.
    propeller->SetRPM(rpm);
    propeller->Calculate(0.0);
    std::printf(
        "{\"kind\":\"point\",\"rpm\":%.17g,\"requestedJ\":%.17g,\"advanceRatio\":%.17g,"
        "\"densitySlugFt3\":%.17g,\"speedFps\":%.17g,\"thrustLbf\":%.17g,\"thrustCoefficient\":%.17g,"
        "\"powerFtLbfPerS\":%.17g}\n",
        rpm, j, fdm->GetPropertyValue("propulsion/engine/advance-ratio"),
        fdm->GetAtmosphere()->GetDensity(), speedFps, propeller->GetThrust(),
        propeller->GetThrustCoefficient(),
        fdm->GetPropertyValue("propulsion/engine/propeller-power-ftlbps"));
  }
  return 0;
}
