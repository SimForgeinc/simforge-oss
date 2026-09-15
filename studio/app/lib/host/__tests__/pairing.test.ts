import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPairingStore, formatPairingCode, normalizePairingCode, PAIRING_CODE_LIFETIME_MS } from "../pairing";

describe("pairing codes", () => {
  it("are claimed once, in any spelling, and never again", () => {
    const store = createPairingStore();
    const minted = store.mint(1_000);
    assert.ok(minted);
    assert.equal(minted.code.length, 8);
    assert.match(minted.code, /^[A-HJ-NP-Z2-9]+$/, "no 0/O or 1/I");
    assert.equal(normalizePairingCode(formatPairingCode(minted.code).toLowerCase()), minted.code);
    assert.equal(store.claim(formatPairingCode(minted.code).toLowerCase(), 2_000), true);
    assert.equal(store.claim(minted.code, 2_000), false);
  });

  it("expire", () => {
    const store = createPairingStore();
    const minted = store.mint(0);
    assert.ok(minted);
    assert.equal(store.claim(minted.code, PAIRING_CODE_LIFETIME_MS), false);
  });

  it("a burst of wrong guesses wipes every outstanding code", () => {
    const store = createPairingStore();
    const live = store.mint(0);
    assert.ok(live);
    for (let i = 0; i < 5; i += 1) assert.equal(store.claim("NOPENOPE", 1), false);
    assert.equal(store.size(1), 0);
    assert.equal(store.claim(live.code, 1), false);
  });

  it("caps the outstanding codes", () => {
    const store = createPairingStore();
    for (let i = 0; i < 8; i += 1) assert.ok(store.mint(0));
    assert.equal(store.mint(0), null);
    assert.ok(store.mint(PAIRING_CODE_LIFETIME_MS), "expired codes make room");
  });
});
