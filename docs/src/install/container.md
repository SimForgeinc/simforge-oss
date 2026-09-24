# Container image (CPU and GPU)

`ghcr.io/simforgeinc/simforge:<version>` holds the released Linux binary,
Mesa lavapipe, the Vulkan loader and ffmpeg. The image is signed with Sigstore
and carries SLSA provenance and a CycloneDX SBOM
([Verify a download](verify.md)).

## CPU (lavapipe)

```sh
docker run --rm -v "$PWD:/work" ghcr.io/simforgeinc/simforge:0.2.0 doctor
```

With no GPU mounted, the image renders on the CPU with lavapipe and says so on
stderr (`rendering on the CPU (Mesa lavapipe)`). Set `SIMFORGE_DEVICE=cpu` to
choose the CPU on purpose (for example to match the lavapipe golden images);
the message then goes away.

## GPU variant (NVIDIA)

The same image renders on an NVIDIA GPU when the driver is mounted by the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
through the `nvidia` runtime:

```sh
docker run --rm --runtime nvidia \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e SIMFORGE_DEVICE=gpu \
  -v "$PWD:/work" ghcr.io/simforgeinc/simforge:0.2.0 doctor
```

The image already sets `NVIDIA_DRIVER_CAPABILITIES=compute,graphics,utility`
(`graphics` is what mounts the driver's Vulkan library). Use the `nvidia`
runtime as above: with `--gpus all` the toolkit mounted the driver libraries
but the Vulkan driver did not initialise in our tests (Docker 29.1, driver
595.84), and `doctor` reports no GPU adapter. `SIMFORGE_DEVICE=gpu` makes a
missing GPU a hard error (exit 2) instead of a CPU render, which is what you
want on a GPU fleet. The adapter a render used is recorded in its
`results.json` either way.

| `SIMFORGE_DEVICE` | Behaviour |
|---|---|
| `auto` (default) | NVIDIA if the driver is mounted, else lavapipe with a notice on stderr |
| `gpu` | NVIDIA or exit 2 |
| `cpu` | lavapipe, even with a GPU mounted |

## Data

The image runs as uid 10001. Maps and asset closures are cached under
`/data` (`XDG_DATA_HOME`); mount a volume there to keep them between runs.
