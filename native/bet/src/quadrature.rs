//! Fixed-capacity normalized azimuth quadrature.
/// Precomputed azimuth directions; initialized once, max 64 samples.
#[derive(Clone, Copy, Debug)]
pub struct AzimuthGrid {
    count: usize,
    nodes: [(f64, f64); 64],
}
impl AzimuthGrid {
    /// Constructs the periodic trapezoidal rule. Returns None outside 1..64.
    pub fn new(count: usize) -> Option<Self> {
        if count == 0 || count > 64 {
            return None;
        }
        let mut grid = Self {
            count,
            nodes: [(0.0, 0.0); 64],
        };
        for j in 0..count {
            let (s, c) = (std::f64::consts::TAU * j as f64 / count as f64).sin_cos();
            grid.nodes[j] = (c, s);
        }
        Some(grid)
    }
    /// Count of active samples.
    pub fn len(&self) -> usize {
        self.count
    }
    /// A constructed grid is never empty.
    pub fn is_empty(&self) -> bool {
        false
    }
    /// Checked cosine/sine access.
    pub fn sample(&self, j: usize) -> Option<(f64, f64)> {
        if j < self.count {
            Some(self.nodes[j])
        } else {
            None
        }
    }
}
