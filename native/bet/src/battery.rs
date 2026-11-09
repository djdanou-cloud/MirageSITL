//! Quasi-static shared battery bus. Each motor's requested bus power is counted once.
//! A negative total demand (regeneration, TASK-092) charges the pack within the
//! same current limit; the charge never exceeds 1.
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
    /// The TASK-104 dynamic pack; `None` keeps TASK-092's.
    model: Option<PackModel>,
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
    /// Regeneration met a full pack: the charge stayed at 1 and the excess was not stored.
    pub charge_limited: bool,
}
/// What the pack can do over one step at a charge: the numbers [`Battery::step`] limits a demand by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BusLimits {
    /// Open-circuit voltage at this charge, V.
    pub open_circuit_v: f64,
    /// Internal resistance, ohm.
    pub resistance_ohm: f64,
    /// Largest discharge current, A.
    pub max_discharge_a: f64,
    /// Largest charging current, A.
    pub max_charge_a: f64,
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
            model: None,
        })
    }
    /// The limits of a step at a charge.
    pub fn limits(&self, soc: f64, house_power_w: f64, dt: f64) -> Result<BusLimits, BatteryError> {
        if ![soc, house_power_w, dt].iter().all(|v| v.is_finite())
            || !(0.0..=1.0).contains(&soc)
            || house_power_w < 0.0
            || dt <= 0.0
            || dt > 0.01
        {
            return Err(BatteryError);
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
        Ok(BusLimits { open_circuit_v: voc, resistance_ohm: self.resistance, max_discharge_a: max_i, max_charge_a: self.current_limit })
    }
    /// Stable low-current quadratic root. Motors <=32, house load counted separately.
    /// A motor's power is negative while it regenerates.
    pub fn step(
        &self,
        soc: f64,
        motor_power_w: &[f64],
        house_power_w: f64,
        dt: f64,
    ) -> Result<BatteryOutput, BatteryError> {
        let BusLimits { open_circuit_v: voc, max_discharge_a: max_i, .. } = self.limits(soc, house_power_w, dt)?;
        if motor_power_w.len() > 32 {
            return Err(BatteryError);
        }
        let mut demand = house_power_w;
        for power in motor_power_w {
            if !power.is_finite() {
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
                charge_limited: false,
            });
        }
        if demand < 0.0 {
            return self.charge(soc, voc, demand, dt);
        }
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
            charge_limited: false,
        })
    }
    /// Charging by regeneration: the same quadratic root with a negative power,
    /// the current limit in both directions, and the charge capped at 1.
    fn charge(&self, soc: f64, voc: f64, demand: f64, dt: f64) -> Result<BatteryOutput, BatteryError> {
        let max_i = self.current_limit;
        let min_power = -max_i * (voc + max_i * self.resistance);
        let requested = demand.max(min_power);
        let current = 2.0 * requested / (voc + (voc * voc - 4.0 * self.resistance * requested).sqrt());
        let voltage = voc - current * self.resistance;
        let delivered = voltage * current;
        let loss = current * current * self.resistance;
        let source = voc * current;
        let raw = soc - current * dt / self.capacity_c;
        let next = raw.min(1.0);
        if ![min_power, current, voltage, delivered, loss, source, next].iter().all(|v| v.is_finite()) {
            return Err(BatteryError);
        }
        Ok(BatteryOutput {
            soc: next,
            voltage_v: voltage,
            current_a: current,
            delivered_power_w: delivered,
            internal_loss_w: loss,
            source_power_w: source,
            power_limited: demand < min_power,
            charge_limited: raw > 1.0,
        })
    }
}

/// Points of the open-circuit table, at charges 0, 0.05, ..., 1 (TASK-104).
pub const TABLE_POINTS: usize = 21;
/// Temperatures a pack and its air may take, K.
const TEMPERATURE_RANGE_K: (f64, f64) = (173.15, 473.15);

/// What a second-order Thevenin pack adds to [`Battery`] (TASK-104): a tabulated open-circuit
/// voltage, two RC branches, Arrhenius series resistance, a lumped heat balance and a state of health.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PackModel {
    /// Pack open-circuit voltage V at the reference temperature, at charges 0, 0.05, ..., 1.
    pub table_v: [f64; TABLE_POINTS],
    /// Branch resistances ohm (0: no branch) and capacitances F (0 exactly when the resistance is 0).
    pub branch_ohm: [f64; 2],
    /// Branch capacitances F.
    pub branch_f: [f64; 2],
    /// Arrhenius activation temperature of the series resistance, E_a/R_gas, K.
    pub activation_k: f64,
    /// Temperature the resistances and the table are given at, K.
    pub reference_k: f64,
    /// Heat capacity m*c_p, J/K; 0 holds the temperature.
    pub heat_capacity_j_per_k: f64,
    /// Conductance to the air in still air, W/K.
    pub still_air_w_per_k: f64,
    /// Forced conductance at 1 m/s, W/K, scaled by the square root of the airspeed.
    pub airflow_w_per_k: f64,
    /// Entropic coefficient dU/dT of the pack, V/K.
    pub entropic_v_per_k: f64,
    /// Share of the rated capacity the pack still holds, (0, 1].
    pub capacity_retention: f64,
    /// Growth of every resistance, at least 1.
    pub resistance_growth: f64,
}
/// The state a dynamic pack carries between steps.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PackState {
    /// Charge [0, 1].
    pub soc: f64,
    /// Branch voltages V.
    pub branch_v: [f64; 2],
    /// Pack temperature K.
    pub temperature_k: f64,
}
/// What the pack's surroundings give over a step.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PackAir {
    /// Air temperature K.
    pub temperature_k: f64,
    /// Airspeed past the pack m/s.
    pub speed_mps: f64,
}
/// One dynamic step: the TASK-092 output and the pack's new state.
#[derive(Clone, Copy, Debug)]
pub struct PackStep {
    /// The bus output; `soc` equals `state.soc`.
    pub output: BatteryOutput,
    /// The state after the step.
    pub state: PackState,
    /// Heat generated over the step, W.
    pub heat_w: f64,
    /// Open-circuit voltage at the step's start state, V.
    pub open_circuit_v: f64,
}

fn finite(values: &[f64]) -> bool { values.iter().all(|v| v.is_finite()) }
fn in_temperature_range(t: f64) -> bool { (TEMPERATURE_RANGE_K.0..=TEMPERATURE_RANGE_K.1).contains(&t) }

impl PackModel {
    /// Open-circuit voltage at a charge and temperature, V.
    pub fn open_circuit_v(&self, soc: f64, temperature_k: f64) -> f64 {
        let x = soc * (TABLE_POINTS - 1) as f64;
        let i = (x as usize).min(TABLE_POINTS - 2);
        let (low, high) = (self.table_v[i], self.table_v[i + 1]);
        low + (high - low) * (x - i as f64) + (temperature_k - self.reference_k) * self.entropic_v_per_k
    }
    /// Series resistance at a temperature, from its value at the reference, ohm.
    pub fn series_ohm(&self, reference_ohm: f64, temperature_k: f64) -> f64 {
        let arrhenius = if self.activation_k == 0.0 { 1.0 } else { (self.activation_k * (1.0 / temperature_k - 1.0 / self.reference_k)).exp() };
        reference_ohm * self.resistance_growth * arrhenius
    }
}

impl Battery {
    /// This pack with a dynamic model; the table's ends must be the empty and full voltages.
    pub fn with_model(mut self, model: PackModel) -> Result<Self, BatteryError> {
        let m = &model;
        let scalars = [m.activation_k, m.reference_k, m.heat_capacity_j_per_k, m.still_air_w_per_k, m.airflow_w_per_k,
            m.entropic_v_per_k, m.capacity_retention, m.resistance_growth];
        if !finite(&m.table_v) || !finite(&m.branch_ohm) || !finite(&m.branch_f) || !finite(&scalars)
            || m.table_v[0] != self.empty || m.table_v[TABLE_POINTS - 1] != self.full
            || m.table_v[0] <= 0.0 || m.table_v.windows(2).any(|w| w[1] < w[0])
            || (0..2).any(|k| m.branch_ohm[k] < 0.0 || (m.branch_ohm[k] > 0.0) != (m.branch_f[k] > 0.0) || m.branch_f[k] < 0.0)
            || m.activation_k < 0.0 || !in_temperature_range(m.reference_k)
            || m.heat_capacity_j_per_k < 0.0 || m.still_air_w_per_k < 0.0 || m.airflow_w_per_k < 0.0
            || !(m.capacity_retention > 0.0 && m.capacity_retention <= 1.0) || m.resistance_growth < 1.0
        {
            return Err(BatteryError);
        }
        self.model = Some(model);
        Ok(self)
    }
    /// The dynamic model, if any.
    pub fn model(&self) -> Option<&PackModel> { self.model.as_ref() }

    fn check_state(&self, state: &PackState, air: &PackAir) -> Result<(), BatteryError> {
        if !finite(&[state.soc, state.branch_v[0], state.branch_v[1], state.temperature_k, air.temperature_k, air.speed_mps])
            || !(0.0..=1.0).contains(&state.soc) || !in_temperature_range(state.temperature_k)
            || !in_temperature_range(air.temperature_k) || air.speed_mps < 0.0
        {
            return Err(BatteryError);
        }
        Ok(())
    }

    /// The linear pack this one is over a step from `state`: open-circuit voltage less the decaying
    /// branch voltages, and the series resistance plus each branch's share; and the decay factors.
    fn linearized(&self, model: &PackModel, state: &PackState, dt: f64) -> (f64, f64, [f64; 2], f64) {
        let open = model.open_circuit_v(state.soc, state.temperature_k);
        let series = model.series_ohm(self.resistance, state.temperature_k);
        let (mut u, mut r, mut decay) = (open, series, [1.0; 2]);
        for k in 0..2 {
            if model.branch_ohm[k] == 0.0 { continue; }
            let rk = model.branch_ohm[k] * model.resistance_growth;
            let a = (-dt / (rk * model.branch_f[k])).exp();
            decay[k] = a;
            u -= a * state.branch_v[k];
            r += (1.0 - a) * rk;
        }
        (u, r, decay, open)
    }

    /// The limits of a step from a state; for a pack without a model, those of [`Battery::limits`].
    pub fn limits_at(&self, state: &PackState, air: &PackAir, house_power_w: f64, dt: f64) -> Result<BusLimits, BatteryError> {
        let Some(model) = self.model else { return self.limits(state.soc, house_power_w, dt) };
        self.check_state(state, air)?;
        if !finite(&[house_power_w, dt]) || house_power_w < 0.0 || dt <= 0.0 || dt > 0.01 { return Err(BatteryError); }
        let (u, r, _, _) = self.linearized(&model, state, dt);
        if !(u > 0.0) || !r.is_finite() { return Err(BatteryError); }
        let capacity = self.capacity_c * model.capacity_retention;
        let max_i = self.current_limit.min(state.soc * capacity / dt).min(if r > 0.0 { u / (2.0 * r) } else { f64::INFINITY });
        Ok(BusLimits { open_circuit_v: u, resistance_ohm: r, max_discharge_a: max_i, max_charge_a: self.current_limit })
    }

    /// Advances a dynamic pack over one step at a known current (positive discharging): exact branches,
    /// charge, and the temperature with the step's heat held. Changes nothing for a pack without a model.
    pub fn advance(&self, state: &PackState, air: &PackAir, current_a: f64, dt: f64) -> Result<PackStep, BatteryError> {
        let Some(model) = self.model else { return Err(BatteryError) };
        self.check_state(state, air)?;
        if !finite(&[current_a, dt]) || dt <= 0.0 { return Err(BatteryError); }
        let (u, r, decay, open) = self.linearized(&model, state, dt);
        let voltage = if state.soc == 0.0 && current_a == 0.0 { 0.0 } else { u - current_a * r };
        let series = model.series_ohm(self.resistance, state.temperature_k);
        let mut branch_v = state.branch_v;
        let mut heat = current_a * current_a * series - current_a * state.temperature_k * model.entropic_v_per_k;
        for k in 0..2 {
            if model.branch_ohm[k] == 0.0 { continue; }
            let rk = model.branch_ohm[k] * model.resistance_growth;
            branch_v[k] = decay[k] * state.branch_v[k] + (1.0 - decay[k]) * rk * current_a;
            heat += branch_v[k] * branch_v[k] / rk;
        }
        let capacity = self.capacity_c * model.capacity_retention;
        let raw = state.soc - current_a * dt / capacity;
        let soc = raw.clamp(0.0, 1.0);
        let c = model.heat_capacity_j_per_k;
        let g = model.still_air_w_per_k + model.airflow_w_per_k * air.speed_mps.sqrt();
        let temperature = if c == 0.0 {
            state.temperature_k
        } else if g == 0.0 {
            state.temperature_k + heat * dt / c
        } else {
            let settled = air.temperature_k + heat / g;
            settled + (state.temperature_k - settled) * (-dt * g / c).exp()
        };
        let delivered = voltage * current_a;
        let output = BatteryOutput {
            soc,
            voltage_v: voltage,
            current_a,
            delivered_power_w: delivered,
            internal_loss_w: open * current_a - delivered,
            source_power_w: open * current_a,
            power_limited: false,
            charge_limited: raw > 1.0,
        };
        let next = PackState { soc, branch_v, temperature_k: temperature };
        if !finite(&[voltage, delivered, heat, temperature, branch_v[0], branch_v[1]]) || !in_temperature_range(temperature) {
            return Err(BatteryError);
        }
        Ok(PackStep { output, state: next, heat_w: heat, open_circuit_v: open })
    }

    /// One bus step of a dynamic pack from a state, as [`Battery::step`] does for the linear one: the
    /// stable root on the step's linear pack, the same limits, then [`Battery::advance`].
    pub fn step_at(&self, state: &PackState, air: &PackAir, motor_power_w: &[f64], house_power_w: f64, dt: f64) -> Result<PackStep, BatteryError> {
        if self.model.is_none() { return Err(BatteryError); }
        let BusLimits { open_circuit_v: u, resistance_ohm: r, max_discharge_a: max_i, max_charge_a } = self.limits_at(state, air, house_power_w, dt)?;
        if motor_power_w.len() > 32 { return Err(BatteryError); }
        let mut demand = house_power_w;
        for power in motor_power_w {
            if !power.is_finite() { return Err(BatteryError); }
            demand += power;
        }
        if !demand.is_finite() { return Err(BatteryError); }
        if state.soc == 0.0 {
            let mut step = self.advance(state, air, 0.0, dt)?;
            step.output.power_limited = demand > 0.0;
            return Ok(step);
        }
        let (current, limited) = if demand < 0.0 {
            let min_power = -max_charge_a * (u + max_charge_a * r);
            let requested = demand.max(min_power);
            (2.0 * requested / (u + (u * u - 4.0 * r * requested).sqrt()), demand < min_power)
        } else {
            let max_power = max_i * (u - max_i * r);
            let requested = demand.min(max_power);
            let current = if r == 0.0 { requested / u } else { 2.0 * requested / (u + (u * u - 4.0 * r * requested).max(0.0).sqrt()) };
            (current, demand > max_power)
        };
        let mut step = self.advance(state, air, current, dt)?;
        step.output.power_limited = limited;
        if step.output.voltage_v < 0.0 { return Err(BatteryError); }
        Ok(step)
    }
}
