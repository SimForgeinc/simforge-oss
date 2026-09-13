"""simforge_splat — the NuRec splat backend of the native render lane (`simforge.splat-backend/v1`).

One rendering core (`backend`) behind two hosts of the V5 render-service contract:

* `service`  — separate-process host path: the native msgpack Unix-socket wire (protocol 5) and
  the shm bundle ring written byte-for-byte like `renderer/service/src/shm.rs`, so every existing
  ring reader works unchanged. Declared host copy (`hello.transport == "host-shm"`).
* `tensor`   — in-process path: leased CUDA tensors handed to a PyTorch consumer with explicit
  ready/release stream ordering and no host staging.

Backgrounds are NuRec reconstructions; actors are the reconstruction's own Gaussians (recorded)
or catalog meshes rasterized under the same f-theta lens (injected); composition is by depth.
"""
__version__ = "0.1.0rc62"
