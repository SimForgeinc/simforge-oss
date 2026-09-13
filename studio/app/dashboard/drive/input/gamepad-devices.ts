/**
 * Thin, defensive wrapper over the Gamepad API. Chromium only exposes a
 * gamepad after the user interacts with it, secure-context and permissions
 * policy can block the API entirely, and `getGamepads()` may throw. Every call
 * site here reports what the browser actually says, nothing more.
 */

export interface GamepadSupport {
  supported: boolean;
  reason: string | null;
}

export interface GamepadDeviceInfo {
  /** Gamepad `id` string; stable identity used for profiles. */
  key: string;
  /** Runtime slot; may change across reconnects. */
  index: number;
  axes: number;
  buttons: number;
  mapping: string;
}

export function detectGamepadSupport(): GamepadSupport {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return { supported: false, reason: "This browser does not expose the Gamepad API." };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { supported: false, reason: "The Gamepad API requires a secure context (https or localhost)." };
  }
  try {
    navigator.getGamepads();
  } catch (error) {
    return { supported: false, reason: `Gamepad access is blocked: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { supported: true, reason: null };
}

/** Snapshot of connected pads; returns null when the API refused the call. */
export function readGamepads(): (Gamepad | null)[] | null {
  try {
    return navigator.getGamepads();
  } catch {
    return null;
  }
}

/** Build the device list, allocating only when the connected set changed. */
export function syncDeviceList(pads: (Gamepad | null)[], previous: GamepadDeviceInfo[]): GamepadDeviceInfo[] {
  let count = 0;
  let changed = false;
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    const known = previous[count];
    if (
      !known || known.key !== pad.id || known.index !== pad.index
      || known.axes !== pad.axes.length || known.buttons !== pad.buttons.length || known.mapping !== pad.mapping
    ) {
      changed = true;
    }
    count += 1;
  }
  if (!changed && count === previous.length) return previous;
  const next: GamepadDeviceInfo[] = [];
  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    next.push({ key: pad.id, index: pad.index, axes: pad.axes.length, buttons: pad.buttons.length, mapping: pad.mapping });
  }
  return next;
}

/** Copy a pad's axes and button values into reusable arrays. */
export function samplePad(pad: Gamepad, axes: number[], buttons: number[]): void {
  axes.length = pad.axes.length;
  for (let index = 0; index < pad.axes.length; index += 1) axes[index] = pad.axes[index]!;
  buttons.length = pad.buttons.length;
  for (let index = 0; index < pad.buttons.length; index += 1) {
    const button = pad.buttons[index]!;
    buttons[index] = typeof button.value === "number" ? button.value : button.pressed ? 1 : 0;
  }
}
