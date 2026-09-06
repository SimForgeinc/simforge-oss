/**
 * Logical-anchor vocabulary and the matcher's output documents.
 *
 * Matching itself (`logical anchor × derived map index → ranked concrete
 * sites`) runs in the native compiler (`simforge-compiler::anchor`), reached
 * through `matchSites` / `findSite` on the Node entry. It is a pure function of
 * `(anchor, derivedIndex)` — no clock, no RNG — so a `siteId` produced today is
 * the same one produced on another machine next month, provided the map digest
 * and the match-semantics version are unchanged.
 *
 * @packageDocumentation
 */

export { MATCH_SEMANTICS_VERSION, DERIVED_INDEX_CONTRACT_VERSION } from './version.js';

export {
  LogicalAnchorSchema,
  AnchorFeatureSchema,
  CorridorSchema,
  JunctionPredicateSchema,
  CrossingPredicateSchema,
  ParkingPredicateSchema,
  MatchPolicySchema,
  RangeSchema,
  EssentialitySchema,
  JunctionControlSchema,
  TurnSchema,
  ApproachRelationSchema,
  AdjacentKindSchema,
  SideSchema,
  FeatureKindSchema,
  ToleranceOverridesSchema,
  DEFAULT_POLICY,
  DEFAULT_WEIGHTS,
  parseLogicalAnchor,
  resolvePolicy,
  originFeature,
  clauseWeight,
  type LogicalAnchor,
  type AnchorFeature,
  type Corridor,
  type JunctionPredicate,
  type CrossingPredicate,
  type ParkingPredicate,
  type MatchPolicy,
  type Clause,
  type Essentiality,
  type Range,
  type JunctionControl,
  type Turn,
  type ApproachRelation,
  type AdjacentKind,
  type Side,
  type FeatureKind,
  type ToleranceOverrides,
} from './types/anchor.js';

export {
  RoleBindingSchema,
  OnMissingSchema,
  parseRoleBindings,
  type RoleBinding,
  type RoleBindingKind,
  type OnMissing,
} from './types/roles.js';

export type {
  AdjacentLaneRef,
  ConflictPair,
  DerivedGate,
  DerivedLane,
  DerivedMapIndex,
  FactIndex,
  IndexCapabilities,
  JunctionApproach,
  JunctionDescriptor,
  LaneChangePermission,
  LaneRsl,
  Point2,
  PointFeature,
  Segment,
  SegmentProfileSample,
  WidthSample,
} from './types/map-index.js';

export type {
  AnchorFrame,
  ClauseResult,
  DegradationReport,
  FeatureBinding,
  FramePose,
  MatchReport,
  MatchStats,
  MatchedSite,
  ReferenceSpan,
  Repair,
  Verdict,
} from './types/site.js';
