//! Quasi-static shared battery bus. Each motor's requested bus power is counted once.
/// Invalid parameters/load/state or overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatteryError;
/// Validated linear Voc(SOC), ohmic loss and charge capacity; no temperature model.
#[derive(Clone, Copy, Debug)]
pub struct Battery {
    full: f64,
    empty: f64,
    resistance: f64,
    capacity_c: f64,
    current_limit: f64,
}
/// One step's shared bus and charge state.
#[derive(Clone, Copy, Debug)]
pub struct BatteryOutput {
    /// Updated SOC [0,1].
    pub soc: f64,
    /// Loaded bus voltage V (zero after hard depleted cutoff).
    pub voltage_v: f64,
    /// Total discharge A.
    pub current_a: f64,
    /// Available delivered W for this requested load.
    pub delivered_power_w: f64,
    /// Ohmic loss W.
    pub internal_loss_w: f64,
    /// Instantaneous electrochemical source W at held Voc.
    pub source_power_w: f64,
    /// Demand exceeded voltage/current/charge domain.
    pub power_limited: bool,
}
impl Battery {
    /// Voc endpoints V, nonnegative resistance ohm, capacity coulomb, current limit A.
    pub fn new(
        full: f64,
        empty: f64,
        resistance: f64,
        capacity_c: f64,
        current_limit: f64,
    ) -> Result<Self, BatteryError> {
        if ![full, empty, resistance, capacity_c, current_limit]
            .iter()
            .all(|v| v.is_finite())
            || full <= 0.0
            || empty <= 0.0
            || full < empty
            || resistance < 0.0
            || capacity_c <= 0.0
            || current_limit <= 0.0
        {
            return Err(BatteryError);
        }
        Ok(Self {
            full,
            empty,
            resistance,
            capacity_c,
            current_limit,
        })
    }
    /// Stable low-current quadratic root. Motors <=32, house load counted separately.
    pub fn step(
        &self,
        soc: f64,
        motor_power_w: &[f64],
        house_power_w: f64,
        dt: f64,
    ) -> Result<BatteryOutput, BatteryError> {
        if ![soc, house_power_w, dt].iter().all(|v| v.is_finite())
            || !(0.0..=1.0).contains(&soc)
            || house_power_w < 0.0
            || dt <= 0.0
            || dt > 0.01
            || motor_power_w.len() > 32
        {
            return Err(BatteryError);
        }
        let mut demand = house_power_w;
        for power in motor_power_w {
            if !power.is_finite() || *power < 0.0 {
                return Err(BatteryError);
            }
            demand += power;
        }
        if !demand.is_finite() {
            return Err(BatteryError);
        }
        if soc == 0.0 {
            return Ok(BatteryOutput {
                soc: 0.0,
                voltage_v: 0.0,
                current_a: 0.0,
                delivered_power_w: 0.0,
                internal_loss_w: 0.0,
                source_power_w: 0.0,
                power_limited: demand > 0.0,
            });
        }
        let voc = self.empty + (self.full - self.empty) * soc;
        let max_i =
            self.current_limit
                .min(soc * self.capacity_c / dt)
                .min(if self.resistance > 0.0 {
                    voc / (2.0 * self.resistance)
                } else {
                    f64::INFINITY
                });
        let max_power = max_i * (voc - max_i * self.resistance);
        let requested = demand.min(max_power);
        let current = if self.resistance == 0.0 {
            requested / voc
        } else {
            2.0 * requested
                / (voc
                    + (voc * voc - 4.0 * self.resistance * requested)
                        .max(0.0)
                        .sqrt())
        };
        let voltage = voc - current * self.resistance;
        let delivered = voltage * current;
        let loss = current * current * self.resistance;
        let source = voc * current;
        let next = (soc - current * dt / self.capacity_c).max(0.0);
        if ![max_power, current, voltage, delivered, loss, source, next]
            .iter()
            .all(|v| v.is_finite())
            || voltage < 0.0
        {
            return Err(BatteryError);
        }
        Ok(BatteryOutput {
            soc: next,
            voltage_v: voltage,
            current_a: current,
            delivered_power_w: delivered,
            internal_loss_w: loss,
            source_power_w: source,
            power_limited: demand > max_power,
        })
    }
}
