"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkManualDriveTake,
  competingMotionInteractions,
  decodeManualDriveTakeGuard,
  encodeManualDriveTakeGuard,
  isManualDrive,
  isUnrecordedManualDrive,
  manualDriveTakeGuard,
  type EditorDocument,
  type ManualDriveInteraction,
  type ManualDriveTakeCheck,
  type ScenarioMapEntry,
} from "@simforge-oss/editor";
import type { Interaction, ManualDriveRecording } from "@simforge-oss/scenario";

import { notifyScenario } from "../status";
import {
  clearManualDriveTake,
  openManualDriveTake,
  pendingManualDriveTakeId,
  readManualDriveTakeRequest,
  readManualDriveTakeResult,
  subscribeManualDriveTakeResult,
  type ManualDriveTakeResult,
} from "./take-handoff";

/** A recorder tab is open (or was, before this editor reloaded) for one interaction. */
export interface ManualDriveTakeInFlight {
  readonly takeId: string;
  readonly interactionId: string;
  readonly actorRoleId: string;
}

/** A finished take waiting for the author's decision. Nothing is in the document yet. */
export interface ManualDriveTakeReview {
  readonly takeId: string;
  readonly interactionId: string;
  readonly actorRoleId: string;
  readonly recording: ManualDriveRecording;
  /** Evaluated against the document as it is now; re-evaluated again on Save. */
  readonly check: ManualDriveTakeCheck;
  /** What the document currently holds for the actor and what Save will replace. */
  readonly replaces: {
    readonly current: ManualDriveInteraction | null;
    readonly otherMotion: readonly Interaction[];
  };
}

export interface ManualDriveRecorder {
  readonly inFlight: ManualDriveTakeInFlight | null;
  readonly review: ManualDriveTakeReview | null;
  /** Open the simulator for this Manual drive. Returns a message when it cannot. */
  startTake(interactionId: string): string | null;
  /** Stop waiting on a recorder that will not report back. The document is untouched. */
  abandonTake(): void;
  /** Commit the reviewed take as one transaction. Returns a message when refused. */
  saveReview(): string | null;
  discardReview(): void;
  /** Discard the reviewed take and open the recorder again for the same drive. */
  rerecord(): string | null;
}

/**
 * The editor half of a take. It issues the guard, opens the recorder, waits on
 * the mailbox, and turns a delivered take into exactly one document transaction
 * after the author has seen what it replaces. Every other outcome — cancel,
 * refusal, an editor that reloaded mid-take — leaves the document as it was.
 */
export function useManualDriveRecorder({
  document,
  documentId,
  datasetId,
  map,
  actorLabel,
}: {
  document: EditorDocument | null;
  documentId: string | null;
  datasetId: string | null;
  map: ScenarioMapEntry;
  actorLabel: (actorId: string) => string;
}): ManualDriveRecorder {
  const [inFlight, setInFlight] = useState<ManualDriveTakeInFlight | null>(null);
  const [delivered, setDelivered] = useState<{
    takeId: string;
    interactionId: string;
    actorRoleId: string;
    recording: ManualDriveRecording;
    revision: string;
  } | null>(null);
  const [revisionTick, setRevisionTick] = useState(0);
  const documentRef = useRef(document);
  documentRef.current = document;

  // The review re-evaluates against the live document, so it must re-render on
  // every document change, not only on its own state.
  useEffect(() => {
    if (!document) return;
    return document.subscribe(() => setRevisionTick((tick) => tick + 1));
  }, [document]);

  const acceptResult = useCallback((take: ManualDriveTakeInFlight, result: ManualDriveTakeResult) => {
    if (result.kind === "cancelled") {
      if (documentId) clearManualDriveTake(take.takeId, documentId);
      setInFlight(null);
      notifyScenario({
        severity: "info",
        source: "authoring",
        message: "Manual drive take cancelled",
        detail: `${actorLabel(take.actorRoleId)} keeps the motion it had.`,
      });
      return;
    }
    setInFlight(null);
    setDelivered({
      takeId: take.takeId,
      interactionId: take.interactionId,
      actorRoleId: take.actorRoleId,
      recording: result.recording,
      revision: result.revision,
    });
  }, [actorLabel, documentId]);

  // An editor that reloaded while its recorder was open (the same-tab fallback,
  // or a plain refresh) finds the take it was waiting on and resumes waiting or
  // reviewing. A request with neither recorder nor result is simply forgotten.
  useEffect(() => {
    if (!documentId || inFlight || delivered) return;
    const takeId = pendingManualDriveTakeId(documentId);
    if (!takeId) return;
    const request = readManualDriveTakeRequest(takeId);
    if (!request || request.documentId !== documentId) {
      clearManualDriveTake(takeId, documentId);
      return;
    }
    const take = { takeId, interactionId: request.interactionId, actorRoleId: request.actorRoleId };
    const result = readManualDriveTakeResult(takeId);
    if (result) acceptResult(take, result);
    else setInFlight(take);
  }, [acceptResult, delivered, documentId, inFlight]);

  useEffect(() => {
    if (!inFlight) return;
    return subscribeManualDriveTakeResult(inFlight.takeId, (result) => acceptResult(inFlight, result));
  }, [acceptResult, inFlight]);

  const startTake = useCallback((interactionId: string): string | null => {
    const current = documentRef.current;
    if (!current) return "The editor is still loading.";
    if (!documentId || !datasetId) return "The scenario has not been saved yet. Wait a moment for autosave, then try again.";
    if (inFlight) return "A recorder is already open for this scenario. Finish or cancel that take first.";
    const interaction = current.data.choreography.interactions.find((candidate) => candidate.id === interactionId);
    if (!interaction || !isManualDrive(interaction)) return "That interaction is not a Manual drive.";
    const actor = current.actor(interaction.actor);
    if (!actor) return "The driven actor has no resolved pose.";
    if (actor.static) return "Static / parked actors cannot be driven.";
    const guard = manualDriveTakeGuard({
      documentId,
      mapVersionId: map.versionId,
      interaction,
      template: current.data,
    });
    const opened = openManualDriveTake({
      datasetId,
      documentId,
      mapVersionId: map.versionId,
      interactionId: interaction.id,
      actorRoleId: interaction.actor,
      clipSeconds: current.data.choreography.clipSeconds,
      revision: encodeManualDriveTakeGuard(guard),
      content: current.data,
      returnHref: window.location.href,
    });
    if ("error" in opened) return opened.error;
    setInFlight({ takeId: opened.takeId, interactionId: interaction.id, actorRoleId: interaction.actor });
    // A second tab keeps this editor, its undo history and its unsaved edits
    // alive while the take is driven. When pop-ups are blocked the recorder
    // takes over this tab and returns via the request's `returnHref`; the
    // pending-take pointer lets the remounted editor pick the result up.
    const tab = window.open(opened.href, "_blank");
    if (!tab) window.location.assign(opened.href);
    return null;
  }, [datasetId, documentId, inFlight, map.versionId]);

  const abandonTake = useCallback(() => {
    if (!inFlight) return;
    if (documentId) clearManualDriveTake(inFlight.takeId, documentId);
    setInFlight(null);
  }, [documentId, inFlight]);

  const review = useMemo<ManualDriveTakeReview | null>(() => {
    if (!delivered || !document) return null;
    const guard = decodeManualDriveTakeGuard(delivered.revision);
    const check: ManualDriveTakeCheck = guard
      ? checkManualDriveTake({
          template: document.data,
          documentId,
          mapVersionId: map.versionId,
          actor: document.actor(delivered.actorRoleId),
          guard,
          recording: delivered.recording,
        })
      : { ok: false, reason: "The recorder returned a take without a valid editor guard." };
    const current = document.data.choreography.interactions.find(
      (candidate): candidate is ManualDriveInteraction => candidate.id === delivered.interactionId && isManualDrive(candidate),
    ) ?? null;
    return {
      takeId: delivered.takeId,
      interactionId: delivered.interactionId,
      actorRoleId: delivered.actorRoleId,
      recording: delivered.recording,
      check,
      replaces: {
        current,
        otherMotion: competingMotionInteractions(
          document.data.choreography.interactions,
          delivered.actorRoleId,
          delivered.interactionId,
        ),
      },
    };
    // `revisionTick` is the document change signal, not a value the review reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivered, document, documentId, map.versionId, revisionTick]);

  const discardReview = useCallback(() => {
    if (!delivered) return;
    if (documentId) clearManualDriveTake(delivered.takeId, documentId);
    setDelivered(null);
  }, [delivered, documentId]);

  const saveReview = useCallback((): string | null => {
    const current = documentRef.current;
    if (!delivered || !current) return "There is no take to save.";
    // Decide against the document at the moment of the click, never against a
    // review computed before an edit landed.
    const guard = decodeManualDriveTakeGuard(delivered.revision);
    const check: ManualDriveTakeCheck = guard
      ? checkManualDriveTake({
          template: current.data,
          documentId,
          mapVersionId: map.versionId,
          actor: current.actor(delivered.actorRoleId),
          guard,
          recording: delivered.recording,
        })
      : { ok: false, reason: "The recorder returned a take without a valid editor guard." };
    if (!check.ok) return check.reason;
    const replaced = current.data.choreography.interactions.find((candidate) => candidate.id === delivered.interactionId);
    current.replaceActorMotion(check.interaction);
    if (documentId) clearManualDriveTake(delivered.takeId, documentId);
    setDelivered(null);
    notifyScenario({
      severity: "success",
      source: "authoring",
      message: replaced && !isUnrecordedManualDrive(replaced) ? "Manual drive re-recorded" : "Manual drive recorded",
      detail: `${actorLabel(delivered.actorRoleId)} now follows the take for the whole ${delivered.recording.clipSeconds}s clip. Undo restores the previous motion.`,
    });
    return null;
  }, [actorLabel, delivered, documentId, map.versionId]);

  const rerecord = useCallback((): string | null => {
    if (!delivered) return "There is no take to record again.";
    const { interactionId } = delivered;
    discardReview();
    return startTake(interactionId);
  }, [delivered, discardReview, startTake]);

  return useMemo(
    () => ({ inFlight, review, startTake, abandonTake, saveReview, discardReview, rerecord }),
    [abandonTake, discardReview, inFlight, rerecord, review, saveReview, startTake],
  );
}
