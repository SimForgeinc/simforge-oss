// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, renderHook, act } from "@testing-library/react";

afterEach(cleanup);

import { useJobResult } from "../src/evaluation/useJobResult";
import type { EvaluationGateway } from "@simforge-oss/evaluation/client";
test("failed run retrieval retries the request without leaving the workspace", async () => {
  const getJob = vi.fn().mockRejectedValueOnce(new Error("gateway unavailable")).mockResolvedValueOnce({ id: "run-one", status: "queued", result: null });
  const gateway = { getJob } as unknown as EvaluationGateway;
  const { result } = renderHook(() => useJobResult(gateway, "run-one"));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.job).toBeNull();
  expect(result.current.problems.join(" ")).toContain("gateway unavailable");
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.job?.id).toBe("run-one"));
  expect(result.current.problems).toEqual([]);
});

import { JobHistory } from "../src/evaluation/components/JobHistory";
test("job history stops loading on failure and retry can reach genuine empty", async () => {
  const listJobs = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ jobs: [], nextCursor: null });
  const gateway = { listJobs } as unknown as EvaluationGateway;
  render(<JobHistory gateway={gateway} onOpenJob={() => {}} />);
  await screen.findByText("Could not load runs");
  expect(screen.queryByText("No runs yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No runs yet");
});
