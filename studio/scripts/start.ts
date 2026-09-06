import { localHostConfig, runLocalHost, workspaceHostPlan } from "./local-host";

// Production boot: same migrations and seed as `dev`, then serve `next build` output.
const config = localHostConfig();
process.exit(await runLocalHost(workspaceHostPlan("start", config), config));
