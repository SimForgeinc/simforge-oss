# Reproducibility

What is byte-identical, and where:

| Artifact | Identical |
|---|---|
| Trace, render timeline | everywhere (the engine's maths does not depend on the CPU, OS or compiler; see the golden-trace corpus) |
| Rendered passes on lavapipe (CPU) | run to run and machine to machine with the same lavapipe build and CPU model |
| Rendered passes on a GPU | per GPU model and driver; NVIDIA drivers are not bit-stable run to run in a few pixels |

The release's golden images are recorded on the CPU with lavapipe; see
[Golden images and lavapipe](../reference/goldens.md). A package can pin a
render (`render/pin.json`): reproducing it exactly then needs the pinned CLI
version and the same GPU fingerprint.
