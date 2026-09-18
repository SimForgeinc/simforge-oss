//! Replay is not reactive traffic. Fail closed when the ego footprint leaves
//! its declared replay tube; this cannot establish counterfactual behavior.
#[derive(Clone, Copy, Debug)]
pub struct Footprint {
    pub x: f64, pub z: f64, pub yaw: f64, pub length: f64, pub width: f64,
}
impl Footprint {
    pub fn corners(self) -> [[f64; 2]; 4] {
        let (s,c)=self.yaw.sin_cos();
        [(-1.0,-1.0),(-1.0,1.0),(1.0,-1.0),(1.0,1.0)].map(|(a,b)| {
            let x=a*self.length*0.5; let z=b*self.width*0.5;
            [self.x+c*x+s*z,self.z-s*x+c*z]
        })
    }
    /// SAT separating margin. Positive is separated; zero/touch is collision.
    pub fn separation(self, other: Self) -> f64 {
        let axes=|yaw:f64| { let (s,c)=yaw.sin_cos(); [[c,-s],[s,c]] };
        let a=axes(self.yaw); let b=axes(other.yaw);
        let dot=|v:[f64;2],u:[f64;2]| v[0]*u[0]+v[1]*u[1];
        let d=[other.x-self.x,other.z-self.z];
        a.into_iter().chain(b).map(|u| dot(d,u).abs()-0.5*(
            self.length*dot(a[0],u).abs()+self.width*dot(a[1],u).abs()
            +other.length*dot(b[0],u).abs()+other.width*dot(b[1],u).abs()))
            .fold(f64::NEG_INFINITY,f64::max)
    }
    /// Translation alone misses a turning long vehicle's displaced corners.
    pub fn divergence(self, authored: Self) -> f64 {
        self.corners().into_iter().zip(authored.corners()).map(|(a,b)|
            (a[0]-b[0]).hypot(a[1]-b[1])).fold(0.0,f64::max)
    }
}

/// Conservative qualification tube, not a measured human reaction threshold.
/// Production scenario perturbation sweeps must report their own artifact onset.
pub const REPLAY_TUBE_M: f64 = 0.5;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_can_invalidate_replay_without_changing_center_or_range() {
        let original=Footprint {x:0.0,z:0.0,yaw:0.0,length:4.67,width:1.8};
        let turned=Footprint {yaw:0.3,..original};
        assert!(turned.divergence(original)>REPLAY_TUBE_M);
        let other=Footprint {x:0.0,z:2.0,..original};
        assert!(original.separation(other)>0.0);
        assert!(turned.separation(other)<0.0);
    }
}
