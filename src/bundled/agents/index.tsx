import { createPage } from "./attention/Page";
import type { PluginModule } from "../../plugins/api";
import { registerAttention } from "../../features/agents/attention-command";
import { registerDiscovery } from "../../features/agents/attention-discovery";
import { AgentsPage } from "./AgentsPage";
import { availableAgentProviderRoute } from "./routes";
import { developerMode } from "../../features/developer/mode";
import { withImportScenario } from "../../features/developer/agent-import-scenario";

export const inject = [
  "pages",
  "agents",
  "relay",
  "navigation",
  "communityReader",
  "host",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerAttention(ctx);
  registerDiscovery(ctx.agents);
  const { relay, navigation: navigator } = ctx;
  const agents = developerMode ? withImportScenario(ctx.agents) : ctx.agents;
  ctx.pages.register({
    id: "attention",
    title: "Watching",
    layout: "workspace",
    primary: true,
    component: createPage({
      agents,
      relay,
      navigation: navigator,
    }),
  });
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        agents={agents}
        relay={relay}
        communities={ctx.communityReader}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
