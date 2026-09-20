"use client";

import { Cloud } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { AppStage } from "@/app/components/AppStage";
import { plate } from "@/app/components/AppStage.stylex";

/**
 * SimCloud, on a host that IS SimCloud.
 *
 * The surface exists to connect this installation to a SimCloud organization
 * and move datasets and artifacts across that boundary. On a hosted
 * installation there is no boundary: the account you signed in with is the
 * account, and the datasets are already where the transfers would put them.
 *
 * The route says so rather than 404ing. It is reachable from a bookmark, a
 * link in the docs, or a desktop install's muscle memory, and "not found" for
 * a page that exists on the product's other host teaches the wrong thing.
 */
export function SimCloudNotApplicable({ hostLabel }: { hostLabel: string }) {
  return (
    <AppStage
      eyebrow="SimCloud"
      title="SimCloud"
      description="Not applicable on this installation."
      testId="simcloud-not-applicable"
    >
      <section {...stylex.props(plate.root)} data-testid="simcloud-hosted-notice">
        <div {...stylex.props(plate.row)}>
          <Cloud {...stylex.props(plate.icon)} aria-hidden="true" />
          <p {...stylex.props(plate.eyebrow)}>You are on SimCloud</p>
        </div>
        <p {...stylex.props(plate.copy)}>
          This page connects a Studio installation on your own computer to a SimCloud
          organization, and copies datasets and artifacts between the two. This installation is
          hosted on {hostLabel}: your account, your
          datasets and your artifacts are already here, so there is nothing to connect and nothing
          to transfer.
        </p>
        <p {...stylex.props(plate.copy)}>
          Install Studio on your own machine to work offline, render on your own GPU, and use this
          page to move work between the two.
        </p>
      </section>
    </AppStage>
  );
}
