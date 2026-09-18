"use client";

import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./CloudSmoke.stylex";

/** The authored cloud shader, baked by studio/scripts/bake-cloud-backdrop.mjs.
 * Alpha keeps the same composition over the shared plate, without allocating
 * another WebGL context beside the world. The shell supplies its file asset root.
 */
export function CloudSmoke({ animated, assetBase = "/clouds" }: { animated: boolean; assetBase?: string }) {
  const [motion, setMotion] = useState(false);
  const [decode, setDecode] = useState<"loading" | "alpha" | "unavailable">("loading");
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setMotion(!query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const poster = `${assetBase}/smoke.png`;
  const playing = animated && motion && decode === "alpha";
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- shared with the file:// desktop shell */}
      <img alt="" aria-hidden="true" src={poster} {...stylex.props(styles.layer, playing && styles.hidden)} />
      {animated && motion && decode !== "unavailable" ? (
        <video
          aria-hidden="true"
          data-testid="cloud-smoke-video"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster={poster}
          src={`${assetBase}/smoke.webm`}
          onError={() => setDecode("unavailable")}
          onLoadedData={(event) => {
            // canPlayType(VP9) does not promise alpha (notably on Safari).
            // Keep the exact still visible until a decoded pixel proves it.
            const video = event.currentTarget;
            const probe = document.createElement("canvas");
            probe.width = probe.height = 1;
            try {
              const context = probe.getContext("2d");
              if (!context) { setDecode("unavailable"); return; }
              context.drawImage(video, video.videoWidth / 2, video.videoHeight / 2, 1, 1, 0, 0, 1, 1);
              setDecode(context.getImageData(0, 0, 1, 1).data[3]! < 255 ? "alpha" : "unavailable");
            } catch { setDecode("unavailable"); }
          }}
          {...stylex.props(styles.layer, !playing && styles.hidden)}
        />
      ) : null}
    </>
  );
}
