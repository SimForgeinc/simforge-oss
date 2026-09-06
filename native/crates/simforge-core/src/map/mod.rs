//! Map geometry: decoded topology, the directed lane graph, routes and timed
//! keyframe tracks.
//!
//! Everything is expressed in xodr-local metres (`x` east, `y` north, headings
//! CCW from `+x`). The scene frame is flipped exactly once at the document
//! boundary via [`crate::math::local_from_scene`].
//!
//! Ownership of geometry is layered so per-tick work never allocates:
//!
//! - [`TopologyIndex`] is the decoded sidecar (parsed once).
//! - [`LaneGraph`] interns lanes to [`LaneId`], precomputes arc lengths,
//!   headings, directed successors and gates; it is immutable and shared by
//!   `Arc` across every world that uses the map.
//! - [`Route`] is an immutable arc-length parameterisation bound to a graph;
//!   [`RouteSnapshot`] is its persisted form.
//! - [`TimedRoute`] owns pose by absolute time for `timedPolyline` actors.

pub mod lane_graph;
pub mod route;
pub mod timed;
pub mod topology;

pub use lane_graph::{
    DirectedLane, Endpoints, Gate, GateId, LaneGeometry, LaneGraph, LaneId, LateralNeighbour,
    NearestLane, NearestLaneQuery, PathSample, Polyline, PolylineProjection, DEFAULT_LANE_WIDTH_M,
    DEFAULT_SPEED_LIMIT_MPS, ENDPOINT_TOL_M,
};
pub use route::{
    build_default_placement_route, build_follow_route, build_lane_path_route, build_route,
    point_to_polyline, retarget_to_lane, retarget_to_neighbour, FollowRouteOptions, LaneRetarget,
    NeighbourRetarget, PlacementRoute, PlacementRouteOptions, RetargetOptions, Route,
    RouteBuildDetail, RouteBuildError, RouteLeg, RouteLegSnapshot, RoutePose, RouteProjection,
    RouteResult, RouteSnapshot,
};
pub use timed::{
    SegmentPeak, TimedKeyframe, TimedKinematics, TimedRoute, TimedRouteExtrema, TimedSample,
    TIMED_ROUTE_RELEASE_RUNWAY_M,
};
pub use topology::{
    LaneRsl, LaneSide, TopologyAdjacentLane, TopologyAdjacentLanes, TopologyGate, TopologyIndex,
    TopologyJunction, TopologyLane, TopologyLaneChangePermission, TopologySource,
    TopologyWidthSample,
};
