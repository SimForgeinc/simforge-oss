//! Return-derived BEV in host forward/left/up coordinates, including a fitted
//! ground plane. The numeric contract matches Stage-S; RANSAC sampling uses a
//! named deterministic LCG, not NumPy's PCG64, so byte parity is not claimed.
use bevy::math::{DVec3, Quat, Vec3};
use crate::lidar::LidarPoint;
use std::path::Path;

struct Bev {
    occupancy:Vec<u8>, free:Vec<u8>, low:Vec<f32>, high:Vec<f32>, limit:Vec<f32>,
    plane:[f64;4], fitted:bool,
}

fn ground_plane(points:&[Vec3])->([f64;4],bool) {
    let candidates:Vec<DVec3>=points.iter().filter(|p|p.x.abs()<40.0 && p.y.abs()<40.0 && p.z> -1.5 && p.z<0.6)
        .map(|p|p.as_dvec3()).collect();
    if candidates.len()<200 {return ([0.0,0.0,1.0,0.0],false);}
    let mut state=0u64;
    let mut draw=|| {state=state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);(state>>16) as usize%candidates.len()};
    let mut normal=DVec3::Z;let mut offset=0.0;let mut best=0;
    for _ in 0..60 {
        let (a,b,c)=(candidates[draw()],candidates[draw()],candidates[draw()]);
        let cross=(b-a).cross(c-a);
        if cross.length()<1e-6 {continue;}
        let mut n=cross.normalize();if n.z<0.0 {n= -n;}
        if n.z<0.9 {continue;}
        let d= -n.dot(a);
        let count=candidates.iter().filter(|p|(n.dot(**p)+d).abs()<0.2).count();
        if count>best {best=count;normal=n;offset=d;}
    }
    let inliers:Vec<_>=candidates.iter().filter(|p|(normal.dot(**p)+offset).abs()<0.2).copied().collect();
    if inliers.len()>=3 {
        let center=inliers.iter().copied().sum::<DVec3>()/inliers.len() as f64;
        let mut covariance=[[0.0f64;3];3];
        for point in &inliers {
            let p=(*point-center).to_array();
            for i in 0..3 {for j in 0..3 {covariance[i][j]+=p[i]*p[j];}}
        }
        // Symmetric Jacobi eigensolver: the least-variance axis is the plane
        // normal. Avoids introducing a linear algebra crate solely for 3x3.
        let mut axes=[[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]];
        for _ in 0..24 {
            let (p,q)=[(0,1),(0,2),(1,2)].into_iter().max_by(|&(a,b),&(c,d)|
                covariance[a][b].abs().total_cmp(&covariance[c][d].abs())).unwrap();
            let pq=covariance[p][q];if pq.abs()<1e-12 {break;}
            let tau=(covariance[q][q]-covariance[p][p])/(2.0*pq);
            let t=if tau>=0.0 {1.0}else{-1.0}/(tau.abs()+(1.0+tau*tau).sqrt());
            let c=1.0/(1.0+t*t).sqrt();let s=t*c;
            for k in 0..3 {
                if k!=p && k!=q {
                    let (a,b)=(covariance[k][p],covariance[k][q]);
                    covariance[k][p]=c*a-s*b;covariance[p][k]=covariance[k][p];
                    covariance[k][q]=s*a+c*b;covariance[q][k]=covariance[k][q];
                }
                let (a,b)=(axes[k][p],axes[k][q]);axes[k][p]=c*a-s*b;axes[k][q]=s*a+c*b;
            }
            covariance[p][p]-=t*pq;covariance[q][q]+=t*pq;covariance[p][q]=0.0;covariance[q][p]=0.0;
        }
        let index=(0..3).min_by(|&a,&b|covariance[a][a].total_cmp(&covariance[b][b])).unwrap();
        let mut n=DVec3::new(axes[0][index],axes[1][index],axes[2][index]).normalize();
        if n.z<0.0 {n= -n;}
        if n.z>=0.9 {normal=n;offset= -normal.dot(center);}
    }
    ([normal.x,normal.y,normal.z,offset],best>=3)
}

fn derive(points:&[Vec3],origin:Vec3,host_length:f32,host_width:f32)->Bev {
    let (plane,fitted)=ground_plane(points);
    let normal=DVec3::new(plane[0],plane[1],plane[2]);
    let mut occupancy=vec![0u8;40000];let mut low=vec![f32::INFINITY;40000];let mut high=vec![0.0f32;40000];
    let mut first=[f32::INFINITY;1800];let mut farthest=[0.0f32;1800];
    let az_bin=|x:f32,y:f32| (((y.atan2(x)+std::f32::consts::PI)/std::f32::consts::TAU*1800.0).floor() as usize)%1800;
    for p in points {
        let (x,y,z)=(p.x,p.y,p.z);
        if z<=-3.0 || z>=4.0 || (x.abs()<(host_length+0.6)*0.5 && y.abs()<(host_width+0.4)*0.5) {continue;}
        let height=(normal.dot(p.as_dvec3())+plane[3]) as f32;
        let obstacle=height>0.25 && height<3.5;
        let dx=x-origin.x;let dy=y-origin.y;let bin=az_bin(dx,dy);let range=dx.hypot(dy);
        farthest[bin]=farthest[bin].max(range);if obstacle {first[bin]=first[bin].min(range);}
        let i=((x+50.0)/0.5).floor() as i32;let j=((y+50.0)/0.5).floor() as i32;
        if obstacle && (0..200).contains(&i) && (0..200).contains(&j) {
            let cell=(i*200+j) as usize;occupancy[cell]=1;low[cell]=low[cell].min(height);high[cell]=high[cell].max(height);
        }
    }
    let limit:Vec<f32>=first.iter().zip(farthest).map(|(a,b)|a.min(b)).collect();let mut free=vec![0u8;40000];
    for i in 0..200 {for j in 0..200 {
        let x=-50.0+(i as f32+0.5)*0.5-origin.x;let y=-50.0+(j as f32+0.5)*0.5-origin.y;
        free[i*200+j]=u8::from(x.hypot(y)+0.25<limit[az_bin(x,y)]);
    }}
    Bev {occupancy,free,low,high,limit,plane,fitted}
}

pub fn write(dir:&Path,tick:u32,points:&[LidarPoint],sensor_origin:Vec3,sensor_rotation:Quat,
             host_origin:Vec3,host_rotation:Quat,host_length:f32,host_width:f32) -> std::io::Result<()> {
    use render_core::coordinates::SensorFrame;
    let matrix=SensorFrame::from_bevy_pose(sensor_origin,sensor_rotation)
        .policy_relative_to(SensorFrame::from_bevy_pose(host_origin,host_rotation));
    let origin=matrix.point(Vec3::ZERO);
    let points:Vec<Vec3>=points.iter().map(|p|matrix.point(Vec3::new(p.x,p.y,p.z)))
        .filter(|p|p.is_finite()).collect();
    let bev=derive(&points,origin,host_length,host_width);
    let half=|v:Vec<f32>|v.into_iter().flat_map(|n|crate::capture::f32_to_f16_bits(if n.is_finite(){n}else{0.0}).to_le_bytes()).collect::<Vec<_>>();
    std::fs::write(dir.join(format!("{tick:08}.occupancy.u8.bin")),bev.occupancy)?;
    std::fs::write(dir.join(format!("{tick:08}.free-space.u8.bin")),bev.free)?;
    std::fs::write(dir.join(format!("{tick:08}.free-space-bins.f32.bin")),bev.limit.iter().flat_map(|n|n.to_le_bytes()).collect::<Vec<_>>())?;
    std::fs::write(dir.join(format!("{tick:08}.height-min.f16.bin")),half(bev.low))?;
    std::fs::write(dir.join(format!("{tick:08}.height-max.f16.bin")),half(bev.high))?;
    std::fs::write(dir.join(format!("{tick:08}.bev.json")),serde_json::to_vec_pretty(&serde_json::json!({
        "schema":"simforge.return-bev.v1","shape":[200,200],"cellMetres":0.5,"boundsMetres":[-50,50],
        "axes":"index0 forward, index1 left; host actor origin, not calibrated rear axle",
        "groundPlane":bev.plane,"groundPlaneFitted":bev.fitted,
        "groundModel":"60-draw LCG64 RANSAC + least-squares plane; seed0; horizontal fallback explicitly flagged if fewer than200 candidates",
        "obstacleHeightRangeMetres":[0.25,3.5],"freeSpaceBins":1800,"unknownBinRange":0,
        "hostLengthMetres":host_length,"hostWidthMetres":host_width
    }))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sloped_road_is_ground_but_a_raised_return_is_occupied() {
        let mut points=Vec::new();
        for i in 0..40 {for j in 0..40 {
            let x=-9.75+i as f32*0.5;let y=-9.75+j as f32*0.5;
            points.push(Vec3::new(x,y,0.04*x));
        }}
        points.push(Vec3::new(8.25,8.25,0.04*8.25+1.0));
        let bev=derive(&points,Vec3::new(0.0,0.0,2.0),4.67,1.8);
        assert_eq!(bev.occupancy[118*200+118],0,"a 4% road grade is not an obstacle");
        assert_eq!(bev.occupancy[116*200+116],1);
        assert!((bev.high[116*200+116]-1.0).abs()<0.01);
        assert!(bev.fitted);
    }
}
