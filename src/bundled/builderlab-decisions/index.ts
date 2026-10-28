// Offers Builderlab in Settings > Decisions API. The Builderlab plugin owns
// the sign-in and the calls; this plugin only registers its provider, while
// both plugins run.
import type { PluginModule } from "../../plugins/api";
import type {} from "../builderlab/decisions";

export const inject = ["decisions"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.inject(["builderlabDecisions"], (scope) =>
    scope.decisions.registerProvider(scope.builderlabDecisions),
  );
};
