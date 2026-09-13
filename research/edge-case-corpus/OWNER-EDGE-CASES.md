# Owner-provided edge-case reference list (2026-08-16)

Verbatim from the owner. Reference for scenario coverage; group labels added by lead for triage only.

## Negotiation / right-of-way
- Unprotected left turn across dense traffic
- Four-way stops with hesitant or aggressive drivers
- Drivers waving you through against right-of-way
- Pedestrian will-they-won't-they crossing mid-block
- Double-parked vehicles forcing informal lane negotiation
- Narrow residential streets with parked cars on both sides
- Highway zipper merge where drivers refuse to cooperate
- School bus loading or unloading with unpredictable kids
- Driver backing out of driveway without clear visibility
- Funeral processions or police escorts ignoring normal rules

## Occlusion / visibility
- Large SUV blocking view of crosswalk
- Box truck blocking right turn sight line
- Blind crest of hill with stopped traffic beyond
- Construction barriers creating visual tunnels
- Parked cars hiding a running child
- Dense rain fog or glare at sunset
- Snowbanks narrowing the roadway
- Flashing emergency lights overwhelming camera exposure

## Control anomalies
- Police manually directing traffic against a signal
- Construction worker using hand signals
- Flashing yellow arrows changing turn logic
- Reversible commuter lanes
- Detours with unclear signage
- Stoplight blackout becoming an implicit four-way stop
- Snow-covered lane markings

## Unstructured spaces
- Gas stations with cars moving in all directions
- Drive-thru lanes crossing pedestrian walkways
- Drop-off zones at airports
- RV campgrounds
- Private roads with non-standard markings
- Dirt or gravel lots with no lane markings
- Event overflow parking on grass fields

## Sudden hazards
- Tire debris in lane
- Mattress or ladder falling off a truck
- Animal darting into the freeway
- Person chasing a dog into the road
- Car doing an illegal U-turn in an intersection
- Driver reversing on a freeway shoulder
- Rolling runaway shopping cart

## Erratic behavior
- Motorcycle lane splitting at high speed
- Driver exiting a vehicle into a traffic lane
- Aggressive tailgating
- Road rage behavior
- Driver drifting across a lane while texting
- Cyclist swerving unpredictably
- Scooter weaving between cars
- Pedestrian walking while staring at a phone
- Elderly pedestrian moving slowly mid-intersection

## Map divergence
- Newly painted lanes not reflected in the HD map
- Temporary road widening
- Faded lane markings
- Misaligned lane reflectors
- Private driveway mistaken for a road

## Adversarial / multi-agent
- Human drivers testing an AV by cutting in aggressively
- Other AVs behaving hyper-cautiously
- Human intentionally confusing an AV
- Ride-share curb chaos
- Robot delivery carts crossing the street

## Weather / physics
- Hydroplaning onset
- Black ice
- Sudden crosswinds
- Flash flooding
- Snow accumulation altering road geometry
- Fog causing sensor disagreement

## Dense contexts
- School arrival and departure areas
- Parking lot navigation with heavy traffic
- Accident or construction blocking normal path

## Owner directives recorded with the list
- Keep improving the base UniScenarios repo as functionality expands: add actors, add functionality, optimize renderers, "whatever".
- Implement a footage-review pass for all agents; Codex CLI compute is plentiful — throw a lot of videos through it for scene review.
