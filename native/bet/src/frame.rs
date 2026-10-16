//! Stable-ID rotor wrench aggregation; transmitted moment already includes drive reaction.
use crate::{
    math::{finite, normalize, rotate},
    Vec3,
};
/// Bad frame, input, duplicate ID or overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameError;
/// One validated rotor-to-body transform.
#[derive(Clone, Copy, Debug)]
pub struct RotorMount {
    id: u32,
    position: Vec3,
    quaternion: [f64; 4],
}
impl RotorMount {
    /// Stable rotor ID 0..31, body lever arm m, unit hub-to-body wxyz quaternion.
    pub fn new(id: u32, position: Vec3, q: [f64; 4]) -> Result<Self, FrameError> {
        let unit = normalize(q).ok_or(FrameError)?;
        let norm = q.iter().map(|x| x * x).sum::<f64>().sqrt();
        if id > 31 || !finite(position) || (norm - 1.0).abs() > 1e-6 {
            return Err(FrameError);
        }
        Ok(Self {
            id,
            position,
            quaternion: unit,
        })
    }
}
/// Already transmitted hub wrench, NOT raw aerodynamic torque plus motor reaction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wrench {
    /// Force N.
    pub force: Vec3,
    /// Moment Nm.
    pub moment: Vec3,
}
/// Sum <=32 mounts once, rejecting mismatched counts and duplicate stable IDs.
pub fn aggregate(mounts: &[RotorMount], hub: &[Wrench]) -> Result<Wrench, FrameError> {
    if mounts.len() != hub.len() || mounts.len() > 32 {
        return Err(FrameError);
    }
    let mut mask = 0_u32;
    let z = Vec3::new(0.0, 0.0, 0.0);
    let mut out = Wrench {
        force: z,
        moment: z,
    };
    for i in 0..mounts.len() {
        let m = mounts[i];
        if mask & (1 << m.id) != 0 || !finite(hub[i].force) || !finite(hub[i].moment) {
            return Err(FrameError);
        }
        mask |= 1 << m.id;
        let f = rotate(m.quaternion, hub[i].force);
        out.force = out.force.add(f);
        out.moment = out
            .moment
            .add(m.position.cross(f))
            .add(rotate(m.quaternion, hub[i].moment));
    }
    if !finite(out.force) || !finite(out.moment) {
        return Err(FrameError);
    }
    Ok(out)
}
