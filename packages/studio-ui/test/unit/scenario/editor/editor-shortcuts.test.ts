// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorShortcutRegistry,
shortcutComboFromEvent, } from "../../../../src/scenario/editor/editor-shortcuts"

describe("shortcutComboFromEvent", () => {
  it("normalises modifiers into mod/alt/shift order", () => {
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe("mod+c");
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "V", metaKey: true }))).toBe("mod+v");
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+z");
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "Escape" }))).toBe("escape");
  });

  it("ignores bare modifier presses", () => {
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
    expect(shortcutComboFromEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBeNull();
  });
});

describe("EditorShortcutRegistry", () => {
  it("dispatches a registered combo and consumes the event when handled", () => {
    const registry = new EditorShortcutRegistry();
    const handler = vi.fn(() => true);
    registry.register({ combo: "mod+c", handler });
    const detach = registry.attach(window);
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    detach();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser the key when the handler declines", () => {
    const registry = new EditorShortcutRegistry();
    registry.register({ combo: "mod+c", handler: () => false });
    const detach = registry.attach(window);
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    detach();
  });

  it("never fires while a text input has focus", () => {
    const registry = new EditorShortcutRegistry();
    const handler = vi.fn(() => true);
    registry.register({ combo: "mod+c", handler });
    const detach = registry.attach(window);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true });
    input.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
    detach();
    input.remove();
  });

  it("rejects duplicate combos outright", () => {
    const registry = new EditorShortcutRegistry();
    registry.register({ combo: "mod+v", handler: () => true });
    expect(() => registry.register({ combo: "mod+v", handler: () => true })).toThrow(/already bound/);
  });
});
