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
