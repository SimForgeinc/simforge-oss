"""Measured Qwen-Drive layout, without mislabelling pinhole data as PAI f-theta.

Policy frame: x forward, y left, z up, origin at the simulation actor origin.
A measured actor-to-rear-axle calibration is REQUIRED to claim PAI frame parity.
All scans here are instantaneous; no invented per-return motion compensation.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from io import BytesIO
import math
import zlib
import numpy as np
from PIL import Image


def transform(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def ftheta_depth(points_rig: np.ndarray, camera_to_rig: np.ndarray, calibration: dict) -> tuple[np.ndarray, np.ndarray]:
    """Sparse lidar axial-Z, z-buffered through supplied angle-to-pixel polynomial.

    Exact Stage-S projection convention, not a conversion of a dense depth map.
    Calibration resolution is the physical camera grid before consumer resizing.
    """
    required = {'resolution', 'principal_point', 'angle_to_pixeldist_poly', 'max_angle'}
    if not required <= calibration.keys():
        raise ValueError(f'f-theta needs measured calibration fields {sorted(required)}')
    width, height = map(int, calibration['resolution'])
    if width < 4 or height < 4:
        raise ValueError('f-theta camera resolution must be at least 4x4')
    camera_to_rig = np.asarray(camera_to_rig, dtype=np.float64)
    if camera_to_rig.shape != (4, 4) or not np.isfinite(camera_to_rig).all():
        raise ValueError('camera_to_rig must be a finite 4x4 transform')
    cam = transform(np.asarray(points_rig, dtype=np.float64), np.linalg.inv(camera_to_rig))
    cam = cam[np.isfinite(cam).all(axis=1) & (cam[:, 2] >= 1) & (cam[:, 2] <= 120)]
    xy, z = cam[:, :2], cam[:, 2]
    radius = np.linalg.norm(xy, axis=1)
    theta = np.arctan2(radius, z)
    rho = np.polynomial.polynomial.polyval(theta, calibration['angle_to_pixeldist_poly'])
    scale = np.divide(rho, radius, out=np.zeros_like(rho), where=radius > 1e-9)
    c, d, e = calibration.get('linear_cde') or [1, 0, 0]
    pixels = (xy * scale[:, None]) @ np.array([[c, d], [e, 1.0]]).T + calibration['principal_point']
    valid = (theta <= calibration['max_angle']) & np.isfinite(pixels).all(axis=1)
    valid &= (pixels[:, 0] >= 0) & (pixels[:, 0] < width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < height)
    px = np.floor(pixels[valid] / 4).astype(np.int64)
    gw, gh = width // 4, height // 4
    keep = (px[:, 0] < gw) & (px[:, 1] < gh)
    depth = np.full((gh, gw), np.inf, np.float32)
    np.minimum.at(depth.reshape(-1), px[keep, 1] * gw + px[keep, 0], z[valid][keep].astype(np.float32))
    mask = np.isfinite(depth)
    depth[~mask] = 0
    return depth.astype('<f2'), mask


def dense_pinhole_depth(reverse_z: np.ndarray, near_m: float = 0.5, scale: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Foreground-min of Bevy infinite reverse-Z; separate from f-theta."""
    h, w = reverse_z.shape
    if not 1<=scale<=16 or h % scale or w % scale or not math.isfinite(near_m) or near_m <= 0:
        raise ValueError('metric depth requires positive near plane and dimensions divisible by reduction scale')
    # Match depth_reduce.wgsl: select the foreground BEFORE range validity.
    # Filtering first would reveal a farther surface behind an invalid near hit.
    nearest=reverse_z.reshape(h // scale,scale,w // scale,scale).max(axis=(1,3))
    depth=np.divide(near_m,nearest,out=np.full_like(nearest,np.inf),where=nearest>0)
    valid=np.isfinite(depth) & (depth>=1) & (depth<=120)
    depth[~valid] = 0
    return depth.astype('<f2'), valid


def fit_ground(points: np.ndarray) -> tuple[np.ndarray, bool]:
    """Stage-S deterministic 60-draw RANSAC + least-squares refinement.

    Unlike the consumer's silent fallback, insufficient support is exposed.
    """
    cand = points[(abs(points[:, 0]) < 40) & (abs(points[:, 1]) < 40) & (points[:, 2] > -1.5) & (points[:, 2] < .6)]
    if len(cand) < 200:
        return np.array([0., 0., 1., 0.]), False
    if len(cand) > 40000:
        cand = cand[np.random.default_rng(0).choice(len(cand), 40000, replace=False)]
    rng = np.random.default_rng(0)
    best, best_count = np.array([0., 0., 1., 0.]), 0
    for _ in range(60):
        p = cand[rng.choice(len(cand), 3, replace=False)]
        normal = np.cross(p[1] - p[0], p[2] - p[0])
        norm = np.linalg.norm(normal)
        if norm < 1e-6:
            continue
        normal /= norm
        if normal[2] < 0:
            normal = -normal
        if normal[2] < .9:
            continue
        d = -normal @ p[0]
        count = int(np.count_nonzero(abs(cand @ normal + d) < .2))
        if count > best_count:
            best, best_count = np.array([*normal, d]), count
    inliers = cand[abs(cand @ best[:3] + best[3]) < .2]
    if len(inliers) >= 3:
        centroid = inliers.mean(axis=0)
        _, _, vt = np.linalg.svd(inliers - centroid, full_matrices=False)
        normal = vt[-1]
        if normal[2] < 0:
            normal = -normal
        if normal[2] >= .9:
            best = np.array([*normal, -normal @ centroid])
    return best, best_count >= 3


def lidar_targets(points: np.ndarray, sensor_xy: np.ndarray, length: float, width: float,
                  center_x: float = 0.) -> dict:
    """Return-derived occupancy and free-space; unknown bins remain unknown (0).

    Indices [i,j] mean forward/left over [-50,50) metres, not an image x/y.
    Ego box is centered at actor origin unless calibrated center_x is supplied.
    """
    points = np.asarray(points, dtype=np.float64)
    points = points[np.isfinite(points).all(axis=1)]
    plane, fitted = fit_ground(points)
    height = points @ plane[:3] + plane[3]
    on_ego = (abs(points[:, 0] - center_x) < (length + .6) / 2) & (abs(points[:, 1]) < (width + .4) / 2)
    band = (points[:, 2] > -3) & (points[:, 2] < 4) & ~on_ego
    obstacle = band & (height > .25) & (height < 3.5)
    ground = band & (height <= .25) & (height > -1)
    cells = np.floor((points[:, :2] + 50) / .5).astype(np.int64)
    inside = (cells >= 0).all(axis=1) & (cells < 200).all(axis=1)
    flat = cells[:, 0] * 200 + cells[:, 1]
    count = np.zeros(40000, np.uint32)
    low = np.full(40000, np.inf, np.float32)
    high = np.zeros(40000, np.float32)
    ground_z = np.full(40000, np.inf, np.float32)
    sel = obstacle & inside
    np.add.at(count, flat[sel], 1)
    np.minimum.at(low, flat[sel], height[sel])
    np.maximum.at(high, flat[sel], height[sel])
    low[count == 0] = 0
    sel = ground & inside
    np.minimum.at(ground_z, flat[sel], points[sel, 2])
    ground_z[~np.isfinite(ground_z)] = np.nan
    delta = points[band, :2] - sensor_xy
    ranges = np.linalg.norm(delta, axis=1)
    bins = (np.floor((np.arctan2(delta[:, 1], delta[:, 0]) + np.pi) / (2 * np.pi) * 1800).astype(int) % 1800)
    first, farthest = np.full(1800, np.inf, np.float32), np.zeros(1800, np.float32)
    np.minimum.at(first, bins[obstacle[band]], ranges[obstacle[band]])
    np.maximum.at(farthest, bins, ranges)
    limit = np.minimum(first, farthest)
    axis = -50 + (np.arange(200) + .5) * .5
    x, y = np.meshgrid(axis - sensor_xy[0], axis - sensor_xy[1], indexing='ij')
    cell_bins = (np.floor((np.arctan2(y, x) + np.pi) / (2*np.pi)*1800).astype(int) % 1800)
    free = (np.hypot(x, y) + .25 < limit[cell_bins]).astype(np.uint8)
    return {'occupancy': (count > 0).astype(np.uint8).reshape(200,200), 'free_space': free,
            'free_space_bins': limit, 'height_min': low.astype('<f2').reshape(200,200),
            'height_max': high.astype('<f2').reshape(200,200), 'ground_z': ground_z.astype('<f2').reshape(200,200),
            'count': np.minimum(count,65535).astype('<u2').reshape(200,200),
            'ground_plane': plane, 'ground_plane_fitted': fitted}


def lidar_to_policy(points: np.ndarray, sensor_to_policy: list) -> tuple[np.ndarray, np.ndarray]:
    """Apply the producer's canonical row-major extrinsic; never re-lower angles."""
    matrix=np.asarray(sensor_to_policy,dtype=np.float64)
    if matrix.shape!=(4,4) or not np.isfinite(matrix).all():
        raise ValueError('renderer must supply a finite sensor-to-policy 4x4 matrix')
    return transform(points,matrix),matrix[:2,3]


@dataclass
class PolicyObservation:
    time_seconds: float
    camera_history: dict[str, list[bytes | None]]
    dense_pinhole: dict[str, tuple[np.ndarray, np.ndarray]]
    sparse_ftheta: dict[str, tuple[np.ndarray, np.ndarray]]
    lidar: dict[str, dict]
    ego_history: dict
    metadata: dict


class ObservationAdapter:
    def __init__(self, cameras: list[dict], lidars: list[dict], vehicle: dict,
                 ftheta: dict | None = None):
        self.cameras = {x['sensorId']:dict(x) for x in cameras}
        self.lidars = {x['sensorId']:x for x in lidars}
        self.vehicle, self.ftheta = vehicle, ftheta or {}
        self.images = {name:deque(maxlen=4) for name in self.cameras}

    def reset(self):
        for history in self.images.values(): history.clear()

    def adapt(self, client, response: dict) -> PolicyObservation:
        if not response.get('ok'):
            raise RuntimeError(response)
        state = response['observation']
        stamp = state['timeSeconds']
        consumer=response['consumer']
        count=consumer['cameraHistoryFrames']
        for name,items in self.images.items():
            if items.maxlen!=count:self.images[name]=deque(items,maxlen=count)
        dense, sparse, lidars, points_all = {}, {}, {}, []
        captures=[*response.get('history',[]),{'timeSeconds':stamp,'frames':response['frames']}]
        records=((capture['timeSeconds'],record) for capture in captures for record in capture['frames'])
        for camera in self.cameras.values():
            camera['width'],camera['height']=consumer['width'],consumer['height']
        for record_stamp,record in records:
            payload = client.read_record(record)
            if f'{zlib.crc32(payload):08x}' != record['digest']:
                raise RuntimeError('observation ring record overwritten or corrupt')
            name, kind = record['sensorId'], record['pass']
            w, h = record['width'], record['height']
            if kind == 'rgb':
                stride = (w*4+255)//256*256
                rgba = np.frombuffer(payload,np.uint8).reshape(h,stride)[:,:w*4].reshape(h,w,4)
                buf=BytesIO()
                rgb=consumer['rgb']
                if rgb['kind']=='jpeg':
                    Image.fromarray(rgba[:,:,:3]).save(buf,format='JPEG',quality=rgb['quality'],subsampling=0)
                elif rgb['kind']=='png':
                    Image.fromarray(rgba[:,:,:3]).save(buf,format='PNG')
                else:raise ValueError('policy image windows cannot use video containers')
                self.images[name].append((record_stamp,buf.getvalue()))
            elif kind == 'depth':
                if record['format'] != 'depth32f': raise ValueError('expected raw infinite reverse-Z, not packed CARLA depth')
                stride=(w*4+255)//256*256//4
                depth=np.frombuffer(payload,'<f4').reshape(h,stride)[:,:w]
                dense[name]=dense_pinhole_depth(depth,response['near_m'],consumer['depth']['scale'])
            elif kind == 'lidar':
                header, raw = bytes(payload).split(b'end_header\n',1)
                if b'format ascii' in header:
                    rows=np.fromstring(raw.decode(),sep=' ').reshape(-1,5)
                    points=rows[:,:3]
                elif b'format binary_little_endian' in header:
                    points=np.frombuffer(raw,dtype=[('xyz','<f4',(3,)),('intensity','<f4'),('id','<u4')])['xyz']
                else: raise ValueError('unknown lidar representation')
                points, origin=lidar_to_policy(points,response['sensor_to_policy'][name])
                points_all.append(points)
                if consumer['occupancy']:
                    lidars[name]=lidar_targets(points,origin,self.vehicle['l'],self.vehicle['w'])
        if self.ftheta and consumer['lidar'] is not None:
            if not points_all:raise ValueError('sparse f-theta depth requires actual lidar returns')
            for name, cal in self.ftheta.items():
                if cal['intrinsics']['resolution']!=[consumer['width'],consumer['height']]:
                    raise ValueError('f-theta calibration resolution must match the declared consumer raster')
                sparse[name]=ftheta_depth(np.concatenate(points_all),np.asarray(cal['cameraToRig']),cal['intrinsics'])
        offsets=[(i+1-count)/consumer['cameraHz'] for i in range(count)]
        history={name:[next((data for t,data in items if abs(t-(stamp+offset))<1e-7),None)
                       for offset in offsets] for name,items in self.images.items()}
        return PolicyObservation(stamp,history,dense,sparse,lidars,state['egoHistory'],
            {'schema':'simforge.policy-observation.v1','cameraProjection':'pinhole','consumer':consumer,
             'cameras':self.cameras,'lidars':self.lidars,'nearMetres':response['near_m'],
             'sensorToPolicy':response['sensor_to_policy'],
             'sparseDepthAvailable':bool(sparse),
             'sparseDepthUnavailableReason':None if sparse else 'No calibrated lidar/f-theta target requested or supplied',
             'sparseDepthAlignedToRgb':False,
             'depthMeasurements':{'dense_pinhole':'raster axial Z, 4x4 minimum','sparse_ftheta':'lidar axial Z, supplied calibration only'},
             'frame':'actor-origin x-forward/y-left/z-up; not calibrated PAI rear axle',
             'missingImageHistoryIsNone':True,'trafficMode':state['trafficMode'],'replayValid':state['replayValid']})
