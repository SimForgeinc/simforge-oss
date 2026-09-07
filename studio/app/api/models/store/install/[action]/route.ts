import { NextResponse } from "next/server";
import {
  cancelInstall,
  pauseInstall,
  resumeInstall,
  InstallControlSchema,
} from "@simforge-oss/model-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ action: string }> };

const ACTIONS = ["pause", "resume", "cancel"] as const;

/**
 * Install control: `pause`, `resume`, `cancel`.
 *
 * Pause aborts the in-flight transfer but leaves every `.part` file and the
 * install record on disk, which is what makes resume cheap. Cancel does the
 * same unless `discardPartials` is set, because discarding 20 GB of verified
 * bytes should be an explicit act rather than the default reading of "stop".
 */
export async function POST(request: Request, context: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const { action } = await context.params;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: "unknown_install_action", detail: { action, expected: ACTIONS } },
      { status: 404 },
    );
  }

  const parsed = InstallControlSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_install_control", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const family = parsed.data.family;
  try {
    if (action === "pause") {
      return NextResponse.json({ family, state: await pauseInstall(family) });
    }
    if (action === "resume") {
      if (!parsed.data.quant) {
        return NextResponse.json(
          { error: "quant_required", detail: { message: "resume needs the quant to load" } },
          { status: 400 },
        );
      }
      const state = await resumeInstall(family, parsed.data.quant);
      return NextResponse.json({ family, state }, { status: 202 });
    }
    const state = await cancelInstall(family, parsed.data.discardPartials ?? false);
    return NextResponse.json({ family, state });
  } catch (error) {
    return NextResponse.json(
      { error: "install_control_failed", message: (error as Error).message },
      { status: 500 },
    );
  }
}
