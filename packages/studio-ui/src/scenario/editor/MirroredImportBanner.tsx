"use client";

import { useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";

import { hairline, surface, textLayout, typography } from "../../stylex/recipes.stylex";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Dot } from "../../components/ui/dot";
import {
  applyMirroredImportRepair,
  mirroredImportBannerModel,
  type RepairableDocument,
} from "./mirrored-import-repair";
import { styles } from "./MirroredImportBanner.stylex";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * OWNS: the one-time offer to repair a document the pre-b79130bb OpenSCENARIO
 * importer wrote with every actor mirrored north <-> south (F-01).
 *
 * Shown only while the open document still needs it
 * (`mirroredImportBannerModel`). Nothing moves until the author confirms; the
 * repair is then one undoable edit that the editor's normal autosave writes as
 * the document's next draft version. After it lands the document carries
 * `extensions.openScenarioImport.mirrorFix` and the banner stops appearing; an
 * undo removes the marker with the fix, so the offer comes back with it.
 */
export function MirroredImportBanner({ document }: { document: RepairableDocument | null }) {
  const data = document?.data ?? null;
  const model = useMemo(() => mirroredImportBannerModel(data), [data]);
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (!document || !model || dismissed) return null;

  const count = model.roleIds.length;
  const positions = plural(count, "position", "positions");
  const confirm = () => {
    applyMirroredImportRepair(document);
    setConfirming(false);
  };

  return (
    <section
      {...stylex.props(surface.raised, hairline.all, styles.banner)}
      aria-labelledby="mirrored-import-banner-title"
      data-testid="mirrored-import-banner"
    >
      <Dot tone="warning" size="md" />
      <div {...stylex.props(styles.text)}>
        <h2 id="mirrored-import-banner-title" {...stylex.props(typography.label, styles.heading)}>
          Imported actors are mirrored
        </h2>
        <p {...stylex.props(typography.bodySm, styles.body)}>
          This scenario was imported from OpenSCENARIO by an older importer that placed actors mirrored
          across the map&apos;s east-west axis.
        </p>
      </div>
      <div {...stylex.props(styles.actions)}>
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          Not now
        </Button>
        <Button variant="accent" size="sm" onClick={() => setConfirming(true)} data-testid="mirrored-import-fix">
          Fix {positions}
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent size="sm" data-testid="mirrored-import-confirm">
          <DialogHeader>
            <DialogTitle>Fix {plural(count, "imported actor position", "imported actor positions")}?</DialogTitle>
            <DialogDescription>
              Each actor moves to where the OpenSCENARIO file placed it, with north and south swapped back.
              Headings are unchanged. The change is saved as a new draft version and can be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul {...stylex.props(styles.roleList)} aria-label="Actors that move">
              {model.roleIds.map((id) => (
                <li key={id} {...stylex.props(typography.meta, textLayout.truncate)}>{id}</li>
              ))}
            </ul>
            {model.keptEdited.length > 0 ? (
              <p {...stylex.props(typography.bodySm, styles.body)}>
                {plural(model.keptEdited.length, "actor", "actors")} you changed after importing stay where{" "}
                {model.keptEdited.length === 1 ? "it is" : "they are"}: {model.keptEdited.map((role) => role.id).join(", ")}.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">Cancel</Button>
            </DialogClose>
            <Button variant="accent" size="sm" onClick={confirm} data-testid="mirrored-import-confirm-fix">
              Fix positions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
