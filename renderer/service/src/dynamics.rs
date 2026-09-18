//! Planar no-slip bicycle reference-point model in scene-yup coordinates.
//! Positive heading is about +Y: forward = [cos(yaw), 0, -sin(yaw)].
//! Wheelbase is an explicit assumption, not inferred from bounding-box length.
#[derive(Clone, Copy, Debug)]
pub struct Bicycle {
    pub x: f64,
    pub z: f64,
    pub yaw: f64,
    pub speed: f64,
}

impl Bicycle {
    /// Exact constant-curvature arc, with constant longitudinal acceleration.
    /// The reference point is the authored actor origin; no calibrated axle
    /// offset, tyre slip, suspension, load transfer, grade or steering lag.
    pub fn integrate(&mut self, acceleration: f64, steering: f64, wheelbase: f64, dt: f64) -> Result<(), String> {
        if ![self.x,self.z,self.yaw,self.speed,acceleration,steering,wheelbase,dt].iter().all(|v| v.is_finite())
            || self.speed < 0.0 || wheelbase <= 0.0 || dt <= 0.0
            || !(-10.0..=5.0).contains(&acceleration) || steering.abs() > 0.7 {
            return Err("bicycle requires finite state, positive wheelbase/dt, speed>=0, acceleration [-10,5] m/s² and steering [-0.7,0.7] rad".into());
        }
        let moving_dt = if acceleration < 0.0 { dt.min(self.speed / -acceleration) } else { dt };
        let distance = self.speed * moving_dt + 0.5 * acceleration * moving_dt * moving_dt;
        let curvature = steering.tan() / wheelbase;
        let turn = distance * curvature;
        // sinc(midpoint) avoids cancellation for straight/near-straight arcs.
        let half = turn * 0.5;
        let sinc = if half.abs() < 1e-6 { 1.0 - half*half/6.0 } else { half.sin()/half };
        self.x += distance * sinc * (self.yaw + half).cos();
        self.z -= distance * sinc * (self.yaw + half).sin();
        self.yaw = (self.yaw + turn).sin().atan2((self.yaw + turn).cos());
        self.speed = (self.speed + acceleration * dt).max(0.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authored_yale_trajectory_as_actions_reconstructs_world_path() {
        // Actual compiled Yale ego, 1001 samples at 50 Hz. Columns x,z,yaw,v.
        let rows: Vec<Vec<f64>> = include_str!("../testdata/yale-ego.csv").lines()
            .filter(|s| !s.starts_with('#')).map(|s| s.split(',').map(|n| n.parse().unwrap()).collect()).collect();
        let mut state = Bicycle { x:rows[0][0], z:rows[0][1], yaw:rows[0][2], speed:rows[0][3] };
        let mut max_error: f64 = 0.0;
        let mut sum_squared = 0.0;
        for pair in rows.windows(2) {
            let (a,b)=(&pair[0],&pair[1]);
            let turn=(b[2]-a[2]).sin().atan2((b[2]-a[2]).cos());
            let distance=(a[3]+b[3])*0.01;
            let steering=if distance>1e-12 { (2.7*turn/distance).atan() } else { 0.0 };
            state.integrate((b[3]-a[3])/0.02,steering,2.7,0.02).unwrap();
            let error=(state.x-b[0]).hypot(state.z-b[1]);
            max_error=max_error.max(error); sum_squared+=error*error;
        }
        println!("Yale 1000 transitions: max={max_error:.9}m RMS={:.9}m",(sum_squared/1000.0).sqrt());
        assert!(max_error < 0.02, "world path error {max_error} exceeds 2 cm");
    }

    #[test]
    fn fixed_arc_and_braking_have_observable_direction_and_distance() {
        let mut state=Bicycle {x:0.0,z:0.0,yaw:0.0,speed:4.0};
        state.integrate(0.0,(2.7_f64/10.0).atan(),2.7,0.5).unwrap();
        assert!((state.x-10.0*0.2_f64.sin()).abs()<1e-10);
        assert!((state.z-10.0*(0.2_f64.cos()-1.0)).abs()<1e-10);
        let mut braking=Bicycle {x:0.0,z:0.0,yaw:0.0,speed:1.0};
        braking.integrate(-4.0,0.0,2.7,0.5).unwrap();
        assert!((braking.x-0.125).abs()<1e-12);
        assert_eq!(braking.speed,0.0);
    }
}
