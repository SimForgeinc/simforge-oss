# Native viewport IPC v1

The interactive viewport is separate from the headless sensor `render_bundle` service.
Transport: newline-delimited JSON on stdin/stdout for the prototype; Electron owns the
child process and treats stdout events as authoritative. The map identity is immutable
and must match the daemon descriptor.

## Host → viewport commands

```json
{"command":"load-map","mapRoot":"/absolute/native/profile","mapVersionId":"...","releaseDigest":"..."}
{"command":"camera","position":[0,25,45],"target":[0,0,0]}
{"command":"pointer-ray","origin":[0,1,2],"direction":[0,-1,0],"layers":["actors","ground","map-static"],"maxHits":8}
{"command":"pointer-button","button":"primary","state":"pressed","x":0.2,"y":-0.1}
{"command":"key","key":"Escape","state":"pressed","modifiers":[]}
{"command":"selection","ids":["actor:1"]}
{"command":"gizmo","operation":"translate","space":"world","ids":["actor:1"],"delta":[1,0,0]}
{"command":"overlay","id":"coverage","visible":true,"payload":{"points":[],"lines":[]}}
{"command":"resize","width":1600,"height":1000,"pixelRatio":1}
{"command":"quit"}
```

Commands are versioned by the enclosing process contract and use renderer-neutral
scene coordinates. Pointer coordinates are normalized device coordinates; gizmo
operations return the resulting selection state rather than scene-graph objects.

## Viewport → host events

```json
{"event":"manifest-ready","mapVersionId":"...","releaseDigest":"..."}
{"event":"coarse-ready","mapVersionId":"..."}
{"event":"interactive","mapVersionId":"...","elapsedMs":232}
{"event":"picked","hits":[{"layer":"ground","id":null,"distanceM":3.2,"point":[0,0,0]}]}
{"event":"selection-changed","ids":["actor:1"]}
{"event":"gizmo-changed","ids":["actor:1"],"operation":"translate","transforms":[]}
{"event":"overlay-state","id":"coverage","visible":true}
{"event":"device-lost","reason":"...","recoverable":true}
{"event":"error","code":"native_viewport_failed","message":"..."}
{"event":"closed","code":0}
```

`PickResult.hits` carries the full renderer contract layers: `actors`, `ground`,
and `map-static`; each hit has a nullable stable id, world point, distance, and
optional semantic classification. Overlay payloads are opaque JSON owned by the
React editor; native code must preserve and echo the overlay id/state without
inventing a second domain schema.

## Fallback

`auto` starts this backend only when the executable and native profile are
available. Startup failure, device loss, or protocol failure emits `error` or
`device-lost`; the Electron adapter then disposes the process and switches to
the existing WebGL adapter. Explicit `native` reports the same failure to the
editor instead of silently falling back.
