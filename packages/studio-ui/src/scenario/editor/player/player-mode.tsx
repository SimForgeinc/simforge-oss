"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the simulation player owns the viewport.
 *
 * While the simulation plays the editor shows nothing but the scene and the
 * player's own controls: no inspector, no rails, no configuration panes. Panels
 * read this to step aside (see `playerChrome.hidden`) while staying mounted,
 * which is what brings them back exactly as they were when the player exits.
 * A hidden panel must also stop answering its keyboard shortcuts: Delete on a
 * panel nobody can see must not delete the actor it describes.
 */
const EditorPlayerModeContext = createContext(false);

export function EditorPlayerModeProvider({
  playing,
  children,
}: {
  playing: boolean;
  children: ReactNode;
}) {
  return (
    <EditorPlayerModeContext.Provider value={playing}>
      {children}
    </EditorPlayerModeContext.Provider>
  );
}

/** True while the simulation player owns the viewport. */
export function useEditorPlayerMode(): boolean {
  return useContext(EditorPlayerModeContext);
}
