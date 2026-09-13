/**
 * Best-effort localStorage persistence for driving input preferences. Every
 * read validates through `parseWheelProfile` so a corrupt or hand-edited entry
 * degrades to defaults instead of producing an unsafe binding.
 */
import { parseInputMode, parseWheelProfile, type InputMode, type WheelProfile } from "./driving-input";

const MODE_KEY = "simcloud.drive.inputMode";
const DEVICE_KEY = "simcloud.drive.wheelDevice";
const PROFILES_KEY = "simcloud.drive.wheelProfiles";
const PROFILES_VERSION = 1;

interface ProfileStore {
  version: number;
  profiles: Record<string, unknown>;
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore (private mode / quota)
  }
}

function readStore(): ProfileStore {
  const raw = readRaw(PROFILES_KEY);
  if (!raw) return { version: PROFILES_VERSION, profiles: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" && parsed !== null
      && "version" in parsed && parsed.version === PROFILES_VERSION
      && "profiles" in parsed && typeof parsed.profiles === "object" && parsed.profiles !== null
    ) {
      return { version: PROFILES_VERSION, profiles: parsed.profiles as Record<string, unknown> };
    }
  } catch {
    // fall through to an empty store
  }
  return { version: PROFILES_VERSION, profiles: {} };
}

export function loadInputMode(): InputMode {
  return parseInputMode(readRaw(MODE_KEY));
}

export function persistInputMode(mode: InputMode): void {
  writeRaw(MODE_KEY, mode);
}

export function loadPreferredDeviceKey(): string | null {
  return readRaw(DEVICE_KEY);
}

export function persistPreferredDeviceKey(deviceKey: string | null): void {
  writeRaw(DEVICE_KEY, deviceKey);
}

export function loadWheelProfile(deviceKey: string): WheelProfile {
  return parseWheelProfile(readStore().profiles[deviceKey], deviceKey);
}

export function persistWheelProfile(profile: WheelProfile): void {
  const store = readStore();
  store.profiles[profile.deviceKey] = profile;
  writeRaw(PROFILES_KEY, JSON.stringify(store));
}
