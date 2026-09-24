# Licences and attributions

- The SDK (the CLI, the renderer, the engine crates, the gym) is
  **Apache-2.0**; see `LICENSE` and `NOTICE`.
- The Rust crates linked into the binary are listed, with their licence texts,
  in `THIRD_PARTY_NOTICES.md` (in every archive and the container image, and
  generated with `cargo about`). Only permissive licences are allowed
  (`deny.toml`, checked on every change and every release).
- **ffmpeg** (and x264) are GPL. The CLI never links or bundles them: it runs
  a system `ffmpeg` as a separate program when you ask for video. The
  container image installs Ubuntu's `ffmpeg` package as a separate program.
- **3D models** are not in the repository or the binary. `simforge assets
  pull` downloads them by digest together with an `ATTRIBUTION.json`: the
  CARLA vehicle and pedestrian models are © CARLA contributors and CVC/UAB
  under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), converted
  for SimForge (each entry lists the changes). If you publish renders that
  show them, credit them as CC BY 4.0 asks.
- **Sky plates** are NASA imagery (public domain).
- **Maps:** the public registry carries `richmond-field-station` only.
