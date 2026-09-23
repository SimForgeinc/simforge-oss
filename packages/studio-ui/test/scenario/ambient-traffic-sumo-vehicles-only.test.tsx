// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultAmbientTrafficProfile, profileForPreset, SUMO_VEHICLES_ONLY_NOTE } from "@simforge-oss/playback/traffic";

import { AmbientTrafficPanel } from "../../src/lib/scenario/ambient/AmbientTrafficPanel";

afterEach(cleanup);

test("under SUMO the panel says it generates vehicles only and a density choice records zero road-user shares", () => {
  const onChange = vi.fn();
  const clean = { ...defaultAmbientTrafficProfile(), pedestrianShare: 0, cyclistShare: 0 };
  render(<AmbientTrafficPanel alwaysOpen profile={clean} provenance={null} provider="sumo" onChange={onChange} />);
  expect(screen.getByTestId("sumo-vehicles-only").textContent).toContain(SUMO_VEHICLES_ONLY_NOTE);
  expect(screen.queryByTestId("sumo-road-user-share-conflict")).toBeNull();
  fireEvent.change(screen.getByTestId("ambient-traffic-preset"), { target: { value: "light" } });
  expect(onChange).toHaveBeenCalledWith({ ...profileForPreset("light", clean), pedestrianShare: 0, cyclistShare: 0 });
});

test("a SUMO scenario that still asks for pedestrians or cyclists is flagged with an explicit fix", () => {
  const onChange = vi.fn();
  const city = defaultAmbientTrafficProfile();
  expect(city.pedestrianShare + city.cyclistShare).toBeGreaterThan(0);
  render(<AmbientTrafficPanel alwaysOpen profile={city} provenance={null} provider="sumo" onChange={onChange} />);
  expect(screen.getByTestId("sumo-road-user-share-conflict").textContent).toContain("server simulation refuses it");
  fireEvent.click(screen.getByTestId("sumo-use-vehicles-only"));
  expect(onChange).toHaveBeenCalledWith({ ...city, pedestrianShare: 0, cyclistShare: 0 });
});

test("native traffic keeps the preset's road users and shows no SUMO note", () => {
  const onChange = vi.fn();
  const city = defaultAmbientTrafficProfile();
  render(<AmbientTrafficPanel alwaysOpen profile={city} provenance={null} provider="native" onChange={onChange} />);
  expect(screen.queryByTestId("sumo-vehicles-only")).toBeNull();
  fireEvent.change(screen.getByTestId("ambient-traffic-preset"), { target: { value: "light" } });
  expect(onChange).toHaveBeenCalledWith(profileForPreset("light", city));
});
