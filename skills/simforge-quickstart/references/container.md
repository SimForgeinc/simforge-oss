# The container image: CPU (lavapipe) and GPU (NVIDIA)

`ghcr.io/simforgeinc/simforge:<version>` (linux/amd64 and linux/arm64) holds the
released binary, Mesa lavapipe, the Vulkan loader and ffmpeg. It runs as uid
10001; maps and asset closures cache under `/data`, so mount a volume there.

CPU:

```sh
docker run --rm -v "$PWD:/work" -v simforge-data:/data ghcr.io/simforgeinc/simforge:0.2.0 doctor
docker run --rm -e SIMFORGE_DEVICE=cpu -v "$PWD:/work" -v simforge-data:/data \
  ghcr.io/simforgeinc/simforge:0.2.0 render ws --preset training --rig rig.json --out out --allow-software-adapter
```

NVIDIA (the NVIDIA Container Toolkit's `nvidia` runtime; `--gpus all` alone
mounted the libraries but gave no Vulkan device in our tests):

```sh
docker run --rm --runtime nvidia -e NVIDIA_VISIBLE_DEVICES=all -e SIMFORGE_DEVICE=gpu \
  -v "$PWD:/work" -v simforge-data:/data ghcr.io/simforgeinc/simforge:0.2.0 doctor
```

| `SIMFORGE_DEVICE` | Behaviour |
|---|---|
| `auto` (default) | NVIDIA if the driver is mounted, else lavapipe, announced on stderr |
| `gpu` | NVIDIA, or exit 2 (never a quiet CPU render) |
| `cpu` | lavapipe even with a GPU mounted (matches the CPU golden images) |

A CPU render still needs `--allow-software-adapter` on `render`/`env serve`:
the image selects the driver, the CLI still refuses a software adapter unless asked.
