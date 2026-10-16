//! Fixed-size SI vector/quaternion and positive-definite inertia helpers.
use crate::Vec3;
/// Finite vector predicate.
pub fn finite(v: Vec3) -> bool {
    v.x.is_finite() && v.y.is_finite() && v.z.is_finite()
}
/// Normalize finite, nonzero wxyz quaternion.
pub fn normalize(q: [f64; 4]) -> Option<[f64; 4]> {
    let n = q[0].hypot(q[1]).hypot(q[2]).hypot(q[3]);
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    Some([q[0] / n, q[1] / n, q[2] / n, q[3] / n])
}
/// Rotate a vector by a unit wxyz quaternion.
pub fn rotate(q: [f64; 4], v: Vec3) -> Vec3 {
    let t = Vec3::new(q[1], q[2], q[3]).cross(v).scale(2.0);
    v.add(t.scale(q[0]))
        .add(Vec3::new(q[1], q[2], q[3]).cross(t))
}
/// Row-major 3x3 matrix-vector product.
pub fn multiply(m: [f64; 9], v: Vec3) -> Vec3 {
    Vec3::new(
        m[0] * v.x + m[1] * v.y + m[2] * v.z,
        m[3] * v.x + m[4] * v.y + m[5] * v.z,
        m[6] * v.x + m[7] * v.y + m[8] * v.z,
    )
}
/// Cholesky inverse, rejects non-symmetric/non-SPD inertia without repair.
pub fn inverse_spd(m: [f64; 9]) -> Option<[f64; 9]> {
    if !m.iter().all(|v| v.is_finite()) {
        return None;
    }
    let mut l = [0.0; 9];
    for r in 0..3 {
        for c in 0..=r {
            if m[r * 3 + c] != m[c * 3 + r] {
                return None;
            }
            let mut x = m[r * 3 + c];
            for k in 0..c {
                x -= l[r * 3 + k] * l[c * 3 + k];
            }
            if r == c {
                if x <= 0.0 || !x.is_finite() {
                    return None;
                }
                l[r * 3 + c] = x.sqrt();
            } else {
                l[r * 3 + c] = x / l[c * 3 + c];
            }
        }
    }
    let mut inv = [0.0; 9];
    for axis in 0..3 {
        let mut y = [0.0; 3];
        for r in 0..3 {
            let mut x = if r == axis { 1.0 } else { 0.0 };
            for k in 0..r {
                x -= l[r * 3 + k] * y[k];
            }
            y[r] = x / l[r * 3 + r];
        }
        let mut x = [0.0; 3];
        for r in (0..3).rev() {
            let mut v = y[r];
            for k in r + 1..3 {
                v -= l[k * 3 + r] * x[k];
            }
            x[r] = v / l[r * 3 + r];
            inv[r * 3 + axis] = x[r];
        }
    }
    if inv.iter().all(|v| v.is_finite()) {
        Some(inv)
    } else {
        None
    }
}
