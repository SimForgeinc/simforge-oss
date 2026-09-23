import { redirect } from "next/navigation";

/**
 * Map Downloads (the map library, "Map availability") is no longer a page: it
 * is a view of the app switcher, like Render Settings. Links and bookmarks to
 * the old route open that view.
 */
export default function MapLibraryPage(): never {
  redirect("/dashboard/apps?view=map-downloads");
}
