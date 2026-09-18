export type ViewTransitionResult = {
  finished?: Promise<void>;
  ready?: Promise<void>;
};

function isExpectedViewTransitionAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/**
 * Observe both browser View Transition promises. A superseded transition
 * rejects `ready` with AbortError even when its DOM mutation and `finished`
 * succeed. Every rejection still needs an owner; real failures stay visible.
 */
export function observeViewTransitionCompletion(
  transition: ViewTransitionResult | undefined,
  label: string,
): void {
  const onError = (error: unknown) => {
    if (isExpectedViewTransitionAbort(error)) return;
    console.error(`${label} view transition failed`, error);
  };
  void transition?.ready?.catch(onError);
  void transition?.finished?.catch(onError);
}
