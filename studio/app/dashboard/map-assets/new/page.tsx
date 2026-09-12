import * as stylex from "@stylexjs/stylex";
import { styles } from "../map-assets.stylex";
import { Suspense } from "react";
import { connection } from "next/server";
import { requireAppContext } from "@/app/lib/db/app-context";
import AddMapForm from "./AddMapForm";

/**
 * Authenticate for ourselves instead of inheriting the gate in
 * `app/dashboard/layout.tsx`. The form is a client component that reads nothing
 * server-side, so this is defence in depth rather than a fix.
 */
async function AddMapFormGate() {
  await connection();
  await requireAppContext("/dashboard/map-assets/new");
  return <AddMapForm />;
}

export default function AddMapPage() {
  // The heading strip stays outside the boundary so it prerenders into the shell.
  return (
    <div className={stylex.props(styles.s_353).className}>
      <div className={stylex.props(styles.s_354).className}>
        <h1 className={stylex.props(styles.s_355).className}>Add new map</h1>
      </div>
      <div className={stylex.props(styles.s_356).className}>
        <Suspense fallback={null}>
          <AddMapFormGate />
        </Suspense>
      </div>
    </div>
  );
}
