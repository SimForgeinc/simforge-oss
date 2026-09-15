import type { NativeRenderInstall } from "@simforge-oss/studio-host";

const PATH = "/api/simforge/host/native-render";

/** Whether this machine can run native renders, read from the host. */
export async function readNativeRenderInstall(signal?: AbortSignal): Promise<NativeRenderInstall> {
  const response = await fetch(PATH, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Native render status could not be read (${response.status}).`);
  return (await response.json()) as NativeRenderInstall;
}

/** Asks the host to install the native render runtime; returns the status to poll. */
export async function startNativeRenderInstall(signal?: AbortSignal): Promise<NativeRenderInstall> {
  const response = await fetch(PATH, { method: "POST", cache: "no-store", signal });
  if (!response.ok) throw new Error(`Native render install could not start (${response.status}).`);
  return (await response.json()) as NativeRenderInstall;
}
