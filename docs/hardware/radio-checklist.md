# Physical USB radio acceptance

English source. [Russian mirror](../ru/radio-checklist.md).

Status: NOT_RUN. Browser mocks verify software behavior and cannot establish
EdgeTX/OpenTX hardware compatibility or end-to-end latency.

1. Record transmitter model, EdgeTX/OpenTX version, OS/browser version, USB mode
   and configured channel order. Use the USB joystick/HID mode.
2. With motors disarmed, select the transmitter explicitly. Verify roll, pitch,
   yaw, throttle endpoints, center, inversion and deadzone for every axis.
3. Save calibration, reload and verify it remains correct. Enable the axis 4
   mode channel only if that axis exists; test all six calibrated slots.
   Mode-slot PWM values do not assign ArduPilot flight modes by themselves.
4. Start the demo at zero throttle. Confirm arming above 5% is rejected. Arm
   explicitly at zero, then increase throttle and observe the demo response.
5. Unplug, replug, switch the selected device and replace a device at the same
   index. Every identity change must disarm and require explicit rearming.
6. Change calibration while armed. Verify immediate disarm. Supply an invalid
   axis/endpoint or remove the enabled mode axis; no previous stick may persist.
7. Record sampled/input publication times and downstream responses with an
   external timing reference before claiming latency. Software timestamps alone
   cannot establish zero input lag.

Save device/version, calibration JSON, measured timings and observed failures
in the acceptance record. Missing hardware remains NOT_RUN; the demo is not
an ArduPilot closed-loop acceptance test. See
[engine contracts](../SPECS_SIMULATION_ENGINES.md).
