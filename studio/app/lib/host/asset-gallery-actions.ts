import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { GalleryAssetSummary } from "@simforge-oss/studio-ui/lib/asset-gallery/contracts";

/**
 * What a host action's dialog is given. The gallery mounts the dialog only
 * while it is open, so a dialog that polls or holds uploads does not exist on
 * a page the visitor is only browsing.
 */
export type AssetGalleryHostDialogProps = {
  onClose: () => void;
  /** An asset the action published: the gallery adds it to the grid and selects it. */
  onPublished: (asset: GalleryAssetSummary) => void;
};

/** One way a host adds models to the gallery besides importing a GLB. */
export type AssetGalleryHostAction = {
  id: string;
  /** Button label in the gallery header and in the empty library. */
  label: string;
  icon?: LucideIcon;
  Dialog: ComponentType<AssetGalleryHostDialogProps>;
};

/**
 * Actions a host adds to the model gallery, beside "Import model". A local
 * installation adds none: its library is what the user imports. A hosted
 * deployment replaces this module (the same seam as `host/kind.ts` and
 * `host/evaluation-links.ts`) to offer services it runs itself.
 */
export const ASSET_GALLERY_HOST_ACTIONS: readonly AssetGalleryHostAction[] = [];
