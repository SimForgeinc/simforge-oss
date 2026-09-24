import numpy as np
from simforge_render.observation import dense_pinhole_depth, ftheta_depth, lidar_targets, lidar_to_policy


def test_sparse_ftheta_uses_lidar_optical_z_and_off_axis_polynomial():
    calibration={'resolution':[400,200],'principal_point':[200,100],
                 'angle_to_pixeldist_poly':[0,100],'max_angle':1.5}
    # Same optical ray at two distances: nearest Z wins. 45 degrees maps to
    # u=278.54 (quarter cell69), not pinhole u=300 (quarter cell75).
    depth,mask=ftheta_depth(np.array([[10,0,10],[20,0,20],[0,0,-10],[0,0,121.]]),np.eye(4),calibration)
    assert depth[25,69]==10 and mask[25,69]
    assert np.count_nonzero(mask)==1
    assert not mask[25,75]


def test_dense_reverse_z_reduction_preserves_invalid_mask_and_foreground():
    raw=np.zeros((4,8),np.float32)
    raw[0,0]=.5/100
    raw[3,3]=.5/2
    raw[1,5]=.5/.75
    raw[2,6]=.5/5  # Invalid foreground must not expose valid background.
    depth,mask=dense_pinhole_depth(raw)
    np.testing.assert_array_equal(depth,[[2,0]])
    np.testing.assert_array_equal(mask,[[True,False]])


def test_yawed_lidar_occupies_left_cell_not_range_equivalent_right_cell():
    # Positive source mount yaw aims right; policy y is LEFT.
    matrix=[[0,0,-1,0],[-1,0,0,-2],[0,1,0,1],[0,0,0,1]]
    points,origin=lidar_to_policy(np.array([[10.,0.,0.]]),matrix)
    np.testing.assert_allclose(points,[[0,-12,1]],atol=1e-10)
    targets=lidar_targets(points,origin,4.67,1.8)
    assert targets['occupancy'][100,76]==1
    assert targets['occupancy'][100,124]==0
    assert targets['free_space_bins'][450]==10
    assert not targets['ground_plane_fitted']
    assert targets['free_space_bins'][0]==0
