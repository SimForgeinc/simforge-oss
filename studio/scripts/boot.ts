import { localHostConfig, runLocalHost, workspaceHostPlan } from "./local-host";

const config = localHostConfig();
process.exit(await runLocalHost(workspaceHostPlan("dev", config), config));
