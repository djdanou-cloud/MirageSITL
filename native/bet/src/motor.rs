//! Torque-driven ESC: exact command lag and quasi-static back-EMF/current limits.
//! Shaft inertia is integrated only by shaft::Shaft; no second RPM governor.
/// Invalid configuration/input or numerical overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MotorError;
/// Explicit SI motor/ESC parameters; regeneration is disabled.
#[derive(Clone, Copy, Debug)]
pub struct Motor {
    /// Winding resistance ohm.
    resistance_ohm: f64,
    /// SI torque/back-EMF constant Nm/A = V/(rad/s).
    torque_constant: f64,
    /// Current limit A.
    current_limit_a: f64,
    /// Command lag time constant s.
    command_tau_s: f64,
}
/// Output includes the next command state; caller owns state storage.
#[derive(Clone, Copy, Debug)]
pub struct MotorOutput {
    /// Filtered duty [0,1].
    pub duty: f64,
    /// Winding current A, nonnegative (no regeneration).
    pub current_a: f64,
    /// Average bus current A, ideal PWM.
    pub bus_current_a: f64,
    /// Shaft drive torque Nm.
    pub torque_nm: f64,
    /// Copper loss W.
    pub copper_loss_w: f64,
    /// Bus input W; ideal PWM reduces applied duty at current saturation.
    pub input_power_w: f64,
}
impl Motor {
    /// Validate once outside the step. SI identity k_t=k_e enforces power signs.
    pub fn new(
        resistance_ohm: f64,
        torque_constant: f64,
        current_limit_a: f64,
        command_tau_s: f64,
    ) -> Result<Self, MotorError> {
        if ![
            resistance_ohm,
            torque_constant,
            current_limit_a,
            command_tau_s,
        ]
        .iter()
        .all(|v| v.is_finite())
            || resistance_ohm <= 0.0
            || torque_constant <= 0.0
            || current_limit_a <= 0.0
            || command_tau_s <= 0.0
        {
            return Err(MotorError);
        }
        Ok(Self {
            resistance_ohm,
            torque_constant,
            current_limit_a,
            command_tau_s,
        })
    }
    /// Held voltage/speed over dt; power-cut bypasses command lag and provides
    /// zero drive torque while the caller continues passive shaft integration.
    pub fn step(
        &self,
        previous_duty: f64,
        target_duty: f64,
        voltage: f64,
        omega: f64,
        power_cut: bool,
        dt: f64,
    ) -> Result<MotorOutput, MotorError> {
        if ![previous_duty, target_duty, voltage, omega, dt]
            .iter()
            .all(|v| v.is_finite())
            || !(0.0..=1.0).contains(&previous_duty)
            || !(0.0..=1.0).contains(&target_duty)
            || voltage < 0.0
            || omega < 0.0
            || dt <= 0.0
            || dt > 0.01
        {
            return Err(MotorError);
        }
        let duty = if power_cut {
            0.0
        } else {
            target_duty + (previous_duty - target_duty) * (-dt / self.command_tau_s).exp()
        };
        let drive = duty * voltage;
        let current = ((drive - self.torque_constant * omega) / self.resistance_ohm)
            .clamp(0.0, self.current_limit_a);
        let bus_current = if voltage > 0.0 && current > 0.0 {
            current * (self.torque_constant * omega + current * self.resistance_ohm) / voltage
        } else {
            0.0
        };
        let torque = self.torque_constant * current;
        let copper = current * current * self.resistance_ohm;
        let power = voltage * bus_current;
        if ![duty, current, bus_current, torque, copper, power]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err(MotorError);
        }
        Ok(MotorOutput {
            duty,
            current_a: current,
            bus_current_a: bus_current,
            torque_nm: torque,
            copper_loss_w: copper,
            input_power_w: power,
        })
    }
}

/// Production voltage-driven motor behind an ESC (TASK-092). Unlike [`Motor`],
/// the winding current is signed: below the back-EMF the ESC brakes, down to
/// `-brake_current_limit_a`. A Coulomb no-load torque opposes rotation.
#[derive(Clone, Copy, Debug)]
pub struct DriveMotor {
    resistance_ohm: f64,
    torque_constant: f64,
    current_limit_a: f64,
    brake_current_limit_a: f64,
    no_load_torque_nm: f64,
    command_tau_s: f64,
    update_period_s: f64,
}
/// ESC command state the caller stores between steps.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EscState {
    /// Filtered duty [0,1] applied to the bridge.
    pub duty: f64,
    /// Target duty held since the last ESC update.
    pub held: f64,
    /// Seconds until the ESC samples its target again; 0 samples on the next step.
    pub countdown_s: f64,
}
/// Torque the motor applies to the shaft over one step:
/// `constant_nm - damping * omega`, plus the Coulomb `friction_nm`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DriveTorque {
    /// Speed-independent electromagnetic torque, signed, Nm.
    pub constant_nm: f64,
    /// Back-EMF damping k_t²/R inside the current limits, else 0, Nm/(rad/s).
    pub damping: f64,
    /// Coulomb no-load torque magnitude, Nm.
    pub friction_nm: f64,
    /// The winding current sits at a limit for this step.
    pub current_limited: bool,
}
/// Electrical operating point at one shaft speed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DriveElectrical {
    /// Signed winding current A.
    pub current_a: f64,
    /// Terminal power i·(i·R + k_e·Ω), W; negative while regenerating.
    pub terminal_power_w: f64,
    /// Copper loss i²·R, W.
    pub copper_loss_w: f64,
    /// Electromagnetic torque k_t·i, Nm.
    pub torque_nm: f64,
}
impl DriveMotor {
    /// Validates once outside the step; k_t = k_e in SI. A zero update period
    /// updates the ESC every step.
    pub fn new(
        resistance_ohm: f64,
        torque_constant: f64,
        current_limit_a: f64,
        brake_current_limit_a: f64,
        no_load_torque_nm: f64,
        command_tau_s: f64,
        update_period_s: f64,
    ) -> Result<Self, MotorError> {
        let values = [resistance_ohm, torque_constant, current_limit_a, brake_current_limit_a,
            no_load_torque_nm, command_tau_s, update_period_s];
        if !values.iter().all(|v| v.is_finite()) || resistance_ohm <= 0.0 || torque_constant <= 0.0
            || current_limit_a <= 0.0 || brake_current_limit_a < 0.0 || no_load_torque_nm < 0.0
            || command_tau_s <= 0.0 || update_period_s < 0.0 || update_period_s > 1.0 {
            return Err(MotorError);
        }
        Ok(Self { resistance_ohm, torque_constant, current_limit_a, brake_current_limit_a,
            no_load_torque_nm, command_tau_s, update_period_s })
    }
    /// Advances the ESC over one step: the target is sampled when the countdown
    /// has run out and held until the next sample, then the duty follows it with
    /// the first-order command lag. A power cut zeroes the duty and the held
    /// target and resamples on the first step after it.
    pub fn command(&self, state: EscState, target: f64, power_cut: bool, dt: f64) -> Result<EscState, MotorError> {
        if ![state.duty, state.held, state.countdown_s, target, dt].iter().all(|v| v.is_finite())
            || !(0.0..=1.0).contains(&state.duty) || !(0.0..=1.0).contains(&state.held)
            || state.countdown_s < 0.0 || !(0.0..=1.0).contains(&target) || dt <= 0.0 || dt > 0.01 {
            return Err(MotorError);
        }
        if power_cut {
            return Ok(EscState::default());
        }
        // A countdown within rounding of zero has run out.
        let (held, countdown) = if state.countdown_s <= dt * 1e-9 {
            (target, self.update_period_s)
        } else {
            (state.held, state.countdown_s)
        };
        let duty = held + (state.duty - held) * (-dt / self.command_tau_s).exp();
        // The countdown keeps its phase; a period shorter than the step samples every step.
        let countdown_s = (countdown - dt).max(0.0);
        Ok(EscState { duty: duty.clamp(0.0, 1.0), held, countdown_s })
    }
    /// The torque law for a step that starts at speed `omega`. Inside the
    /// current limits the back-EMF is a damping term; at a limit the current,
    /// and so the torque, is constant over the step.
    pub fn torque(&self, duty: f64, voltage: f64, omega: f64, power_cut: bool) -> Result<DriveTorque, MotorError> {
        if ![duty, voltage, omega].iter().all(|v| v.is_finite()) || !(0.0..=1.0).contains(&duty)
            || voltage < 0.0 || omega < 0.0 {
            return Err(MotorError);
        }
        let friction_nm = self.no_load_torque_nm;
        // An unpowered bridge, by a cut or a dead bus, neither drives nor brakes.
        if power_cut || voltage == 0.0 {
            return Ok(DriveTorque { constant_nm: 0.0, damping: 0.0, friction_nm, current_limited: false });
        }
        let current = (duty * voltage - self.torque_constant * omega) / self.resistance_ohm;
        if current > self.current_limit_a || current < -self.brake_current_limit_a {
            let limited = current.clamp(-self.brake_current_limit_a, self.current_limit_a);
            return Ok(DriveTorque { constant_nm: self.torque_constant * limited, damping: 0.0, friction_nm, current_limited: true });
        }
        Ok(DriveTorque {
            constant_nm: self.torque_constant * duty * voltage / self.resistance_ohm,
            damping: self.torque_constant * self.torque_constant / self.resistance_ohm,
            friction_nm,
            current_limited: false,
        })
    }
    /// The electrical operating point at speed `omega`; an unpowered bridge draws nothing.
    pub fn electrical(&self, duty: f64, voltage: f64, omega: f64, power_cut: bool) -> Result<DriveElectrical, MotorError> {
        if ![duty, voltage, omega].iter().all(|v| v.is_finite()) || !(0.0..=1.0).contains(&duty)
            || voltage < 0.0 || omega < 0.0 {
            return Err(MotorError);
        }
        if power_cut || voltage == 0.0 {
            return Ok(DriveElectrical { current_a: 0.0, terminal_power_w: 0.0, copper_loss_w: 0.0, torque_nm: 0.0 });
        }
        let current = ((duty * voltage - self.torque_constant * omega) / self.resistance_ohm)
            .clamp(-self.brake_current_limit_a, self.current_limit_a);
        let copper = current * current * self.resistance_ohm;
        let terminal = current * (current * self.resistance_ohm + self.torque_constant * omega);
        let torque = self.torque_constant * current;
        if ![current, copper, terminal, torque].iter().all(|v| v.is_finite()) {
            return Err(MotorError);
        }
        Ok(DriveElectrical { current_a: current, terminal_power_w: terminal, copper_loss_w: copper, torque_nm: torque })
    }
}
