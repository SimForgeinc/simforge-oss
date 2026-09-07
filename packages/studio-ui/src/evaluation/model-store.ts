/**
 * The desktop model store surface.
 *
 * Kept off the `./evaluation` barrel on purpose: these routes exist only on the
 * host that owns the weights, the isolated runtime environments and the OS
 * credential vault, so the web portal has no business importing them.
 */

export * from "./model-store-client";
export { ModelStorePanel } from "./components/ModelStorePanel";
