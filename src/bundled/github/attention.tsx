// How a pull request watch looks in Agent Attention.
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import type { AttentionSource } from "../../features/agents/attention-sources";
import type { Navigation } from "../../features/navigation/controller";
import { pullOf } from "./watch";

/** Names the pull request a watch follows, and opens the settings for whose
 * feedback wakes agents. */
export function presentPull(
  navigation: Pick<Navigation, "open">,
): NonNullable<AttentionSource["present"]> {
  const Authors = () => (
    <Button
      variant="link"
      size="inline"
      type="button"
      onClick={() =>
        void navigation.open({
          version: 1,
          kind: "settings",
          section: "buzz.github/authors",
        })
      }
    >
      Choose who can wake agents
    </Button>
  );
  return (watch, title) => {
    const pull =
      typeof watch.config.pr === "string" ? pullOf(watch.config.pr) : undefined;
    if (!pull) return { type: "GitHub PR", icon: GitPullRequestIcon };
    return {
      type: "GitHub PR",
      icon: GitPullRequestIcon,
      target: `${pull.name}#${pull.number}`,
      subtitle: title.replace(/^(?:PR\s+\d+:?\s*|[^ ]*#\d+\s*)/i, ""),
      link: { href: pull.url, title: "Open on GitHub" },
      details: Authors,
    };
  };
}
