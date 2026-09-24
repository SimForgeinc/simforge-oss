# simforge doctor

`simforge doctor` inspects the machine and prints one JSON document:

| Check | Passes when |
|---|---|
| Vulkan / Metal adapter | an adapter supports what the renderer needs; the adapter's name, driver and whether it is a CPU (lavapipe) device are reported |
| ffmpeg | `ffmpeg` is on `PATH` (needed only for videos) |
| Disk | the cache root has room for a map release |
| Cache roots | `$XDG_DATA_HOME/simforge` is writable |
| Registries | the public map and asset registries answer |

Exit `0` when everything needed for rendering is present, `1` otherwise. It
never switches anything on your behalf: if the only adapter is lavapipe, it
says so, and renders will use it only because that is what you have.

In the container image, the entrypoint's device choice is exported as
`SIMFORGE_CONTAINER_DEVICE` and shows up in the report.
