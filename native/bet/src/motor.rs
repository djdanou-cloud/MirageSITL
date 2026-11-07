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
#[derive(Clone, Copy, Debug, Default)]
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
    /// The terminal power at a bus voltage, as [`DriveMotor::electrical`] gives it, and its slope with
    /// that voltage: `(d/R)·(2·i·R + k_e·Ω)` inside the current limits, and flat at a limit (TASK-197).
    pub fn load(&self, duty: f64, voltage: f64, omega: f64, power_cut: bool) -> Result<(f64, f64), MotorError> {
        let point = self.electrical(duty, voltage, omega, power_cut)?;
        let free = (duty * voltage - self.torque_constant * omega) / self.resistance_ohm;
        let flat = power_cut || voltage == 0.0 || free > self.current_limit_a || free < -self.brake_current_limit_a;
        let slope = if flat { 0.0 } else { duty / self.resistance_ohm * (2.0 * point.current_a * self.resistance_ohm + self.torque_constant * omega) };
        Ok((point.terminal_power_w, slope))
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

// ---------------------------------------------------------------------------------------------
// Motor v2 (TASK-105): the winding's inductance, its temperature, and the motor's heat.

/// Annealed copper's resistance temperature coefficient at 20 °C, 1/K (IEC 60028): R(T) = R₂₀·(1 + α·(T − 20 °C)).
pub const COPPER_COEFFICIENT_PER_K: f64 = 0.00393;
/// A sintered NdFeB magnet's reversible remanence coefficient, 1/K: about −0.12 %/K for common grades (manufacturers'
/// datasheets, for example Arnold Magnetic Technologies' N42), which scales the torque constant k(T) = k₂₀·(1 + β·(T − 20 °C)).
pub const NDFEB_COEFFICIENT_PER_K: f64 = -0.0012;

/// The winding resistance at a temperature, ohm.
pub fn winding_resistance_ohm(resistance_20c_ohm: f64, winding_c: f64) -> f64 {
    resistance_20c_ohm * (1.0 + COPPER_COEFFICIENT_PER_K * (winding_c - 20.0))
}
/// The torque constant at a magnet temperature, Nm/A.
pub fn torque_constant_at(torque_constant_20c: f64, coefficient_per_k: f64, magnet_c: f64) -> f64 {
    torque_constant_20c * (1.0 + coefficient_per_k * (magnet_c - 20.0))
}

/// A brushless motor with its winding inductance: L·di/dt = v − R(T_w)·i − k_e(T_m)·Ω, the applied voltage v (duty times
/// the bus voltage) and Ω held over a step and the current integrated exactly. The ESC's current limits bound the current;
/// below the back-EMF it brakes, down to the brake limit. The no-load current I₀ is the iron and bearing loss, a torque k·I₀.
#[derive(Clone, Copy, Debug)]
pub struct InductiveMotor {
    resistance_20c_ohm: f64,
    torque_constant_20c: f64,
    inductance_h: f64,
    current_limit_a: f64,
    brake_current_limit_a: f64,
    no_load_current_a: f64,
    magnet_coefficient_per_k: f64,
}
/// One step of an [`InductiveMotor`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InductiveStep {
    /// The winding current at the end of the step, A.
    pub current_a: f64,
    /// Its mean over the step, A: the electromagnetic torque is k·mean.
    pub mean_current_a: f64,
    /// Mean electromagnetic torque less the no-load torque, Nm.
    pub torque_nm: f64,
    /// Mean copper loss R·⟨i²⟩, W, which heats the winding.
    pub copper_loss_w: f64,
    /// No-load loss k·I₀·Ω, W, which heats the stator and housing.
    pub iron_loss_w: f64,
    /// Mean electrical power drawn, v·⟨i⟩, W.
    pub input_power_w: f64,
    /// The current sat at a limit at the end of the step.
    pub current_limited: bool,
}
impl InductiveMotor {
    /// Validates once, outside the step.
    pub fn new(resistance_20c_ohm: f64, torque_constant_20c: f64, inductance_h: f64, current_limit_a: f64, brake_current_limit_a: f64,
        no_load_current_a: f64, magnet_coefficient_per_k: f64) -> Result<Self, MotorError> {
        let values = [resistance_20c_ohm, torque_constant_20c, inductance_h, current_limit_a, brake_current_limit_a, no_load_current_a, magnet_coefficient_per_k];
        if !values.iter().all(|v| v.is_finite()) || resistance_20c_ohm <= 0.0 || torque_constant_20c <= 0.0 || inductance_h <= 0.0
            || current_limit_a <= 0.0 || brake_current_limit_a < 0.0 || no_load_current_a < 0.0 || !(-0.01..=0.0).contains(&magnet_coefficient_per_k) {
            return Err(MotorError);
        }
        Ok(Self { resistance_20c_ohm, torque_constant_20c, inductance_h, current_limit_a, brake_current_limit_a, no_load_current_a, magnet_coefficient_per_k })
    }
    /// One step from `current_a`: with τ = L/R and i∞ = (v − k·Ω)/R, i(t) = i∞ + (i₀ − i∞)·e^(−t/τ), whose mean over dt is
    /// i∞ + (i₀ − i∞)·(τ/dt)·(1 − e^(−dt/τ)) and mean square follows the same way. i∞ is bounded by the current limits,
    /// as the ESC holds the current at a limit by its duty.
    pub fn step(&self, current_a: f64, applied_v: f64, omega: f64, winding_c: f64, magnet_c: f64, dt: f64) -> Result<InductiveStep, MotorError> {
        if ![current_a, applied_v, omega, winding_c, magnet_c, dt].iter().all(|v| v.is_finite()) || applied_v < 0.0 || omega < 0.0
            || dt <= 0.0 || dt > 0.01 || !(-60.0..=250.0).contains(&winding_c) || !(-60.0..=250.0).contains(&magnet_c) {
            return Err(MotorError);
        }
        let r = winding_resistance_ohm(self.resistance_20c_ohm, winding_c);
        let k = torque_constant_at(self.torque_constant_20c, self.magnet_coefficient_per_k, magnet_c);
        let free = (applied_v - k * omega) / r;
        let target = free.clamp(-self.brake_current_limit_a, self.current_limit_a);
        let tau = self.inductance_h / r;
        let decay = (-dt / tau).exp();
        let (a, b) = (target, current_a - target);
        let end = a + b * decay;
        let mean = a + b * (tau / dt) * (1.0 - decay);
        let mean_square = a * a + 2.0 * a * b * (tau / dt) * (1.0 - decay) + b * b * (tau / (2.0 * dt)) * (1.0 - decay * decay);
        let no_load_torque = k * self.no_load_current_a;
        let torque = k * mean - if omega > 0.0 { no_load_torque } else { 0.0 };
        let out = InductiveStep {
            current_a: end, mean_current_a: mean, torque_nm: torque, copper_loss_w: r * mean_square,
            iron_loss_w: no_load_torque * omega, input_power_w: applied_v * mean, current_limited: target != free,
        };
        if ![out.current_a, out.mean_current_a, out.torque_nm, out.copper_loss_w, out.iron_loss_w, out.input_power_w].iter().all(|v| v.is_finite()) {
            return Err(MotorError);
        }
        Ok(out)
    }
}

/// A two-node thermal network of a motor: the winding (capacity C_w) heated by its copper loss, linked through R_wh to the
/// stator and housing (C_h) heated by the iron loss, which the air cools through R_ha/(1 + c·V), V the airspeed past it
/// (the rotor's wash). The linear system dx/dt = A·x + b with constant losses over a step is integrated exactly with the
/// closed-form exponential of its 2×2 matrix.
#[derive(Clone, Copy, Debug)]
pub struct MotorThermal {
    winding_capacity_j_per_k: f64,
    housing_capacity_j_per_k: f64,
    winding_to_housing_k_per_w: f64,
    housing_to_air_k_per_w: f64,
    airflow_per_mps: f64,
}
impl MotorThermal {
    /// Validates once, outside the step.
    pub fn new(winding_capacity_j_per_k: f64, housing_capacity_j_per_k: f64, winding_to_housing_k_per_w: f64, housing_to_air_k_per_w: f64,
        airflow_per_mps: f64) -> Result<Self, MotorError> {
        let values = [winding_capacity_j_per_k, housing_capacity_j_per_k, winding_to_housing_k_per_w, housing_to_air_k_per_w, airflow_per_mps];
        if !values.iter().all(|v| v.is_finite() && *v > 0.0) && !(values[..4].iter().all(|v| v.is_finite() && *v > 0.0) && airflow_per_mps == 0.0) {
            return Err(MotorError);
        }
        Ok(Self { winding_capacity_j_per_k, housing_capacity_j_per_k, winding_to_housing_k_per_w, housing_to_air_k_per_w, airflow_per_mps })
    }
    /// The temperatures [winding, housing] °C after `dt` from `temperatures`, with the losses W, the air temperature °C
    /// and the airspeed m/s held over the step.
    pub fn step(&self, temperatures: [f64; 2], winding_loss_w: f64, housing_loss_w: f64, air_c: f64, airspeed_mps: f64, dt: f64) -> Result<[f64; 2], MotorError> {
        if ![temperatures[0], temperatures[1], winding_loss_w, housing_loss_w, air_c, airspeed_mps, dt].iter().all(|v| v.is_finite())
            || winding_loss_w < 0.0 || housing_loss_w < 0.0 || airspeed_mps < 0.0 || dt <= 0.0 {
            return Err(MotorError);
        }
        let (cw, ch) = (self.winding_capacity_j_per_k, self.housing_capacity_j_per_k);
        let g1 = 1.0 / self.winding_to_housing_k_per_w;
        let g2 = (1.0 + self.airflow_per_mps * airspeed_mps) / self.housing_to_air_k_per_w;
        let (a11, a12, a21, a22) = (-g1 / cw, g1 / cw, g1 / ch, -(g1 + g2) / ch);
        // Steady state: the housing sheds every loss to the air, the winding sits above it by its own loss times R_wh.
        let housing_ss = air_c + (winding_loss_w + housing_loss_w) / g2;
        let winding_ss = housing_ss + winding_loss_w / g1;
        let (x1, x2) = (temperatures[0] - winding_ss, temperatures[1] - housing_ss);
        // e^(A·t) = (e^(λ₁t)·(A − λ₂I) − e^(λ₂t)·(A − λ₁I)) / (λ₁ − λ₂); A is similar to a symmetric matrix, so λ are real and distinct.
        let (trace, det) = (a11 + a22, a11 * a22 - a12 * a21);
        let root = (trace * trace / 4.0 - det).sqrt();
        let (l1, l2) = (trace / 2.0 + root, trace / 2.0 - root);
        let (e1, e2) = ((l1 * dt).exp(), (l2 * dt).exp());
        let s = 1.0 / (l1 - l2);
        let (m11, m12) = (s * (e1 * (a11 - l2) - e2 * (a11 - l1)), s * (e1 - e2) * a12);
        let (m21, m22) = (s * (e1 - e2) * a21, s * (e1 * (a22 - l2) - e2 * (a22 - l1)));
        let out = [winding_ss + m11 * x1 + m12 * x2, housing_ss + m21 * x1 + m22 * x2];
        if !out.iter().all(|v| v.is_finite()) {
            return Err(MotorError);
        }
        Ok(out)
    }
}
