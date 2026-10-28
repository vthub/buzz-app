import {
  AlarmIcon,
  BellIcon,
  BestieIcon,
  BrowserIcon,
  ChartBarIcon,
  ChatsCircleIcon,
  EyeIcon,
  NoteIcon,
  GearIcon,
  LightningIcon,
  RobotIcon,
} from "../../shared/design-system/icons/index";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  settings: { label: "Settings", icon: GearIcon, tone: "lavender" },
  channels: { label: "Messages", icon: ChatsCircleIcon, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
const bundledOrder = [
  "buzz.channels/channels",
  "buzz.inbox/inbox",
  "buzz.agents/attention",
  "buzz.reminders/reminders",
  "buzz.bestie/bestie",
];
export function orderPages(pages: readonly RegisteredPage[]) {
  const rank = (page: RegisteredPage) => {
    const slot = bundledOrder.indexOf(page.key);
    return slot === -1 ? bundledOrder.length : slot;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

const bundledIcons = new Map<string, typeof BrowserIcon>([
  ["buzz.inbox/inbox", BellIcon],
  ["buzz.reminders/reminders", AlarmIcon],
  ["buzz.bestie/bestie", BestieIcon],
  ["buzz.agents/agents", RobotIcon],
  ["buzz.agents/attention", EyeIcon],
  ["buzz.workflows/workflows", LightningIcon],
  ["buzz.relay-notes/notes", NoteIcon],
  ["buzz.usage/usage", ChartBarIcon],
]);
/** Resolve host navigation policy once, independently of icons and registrations. */
export function pagePlacement(page: RegisteredPage) {
  if (!page.primary) return undefined;
  switch (page.key) {
    case "buzz.channels/channels":
    case "buzz.reminders/reminders":
    case "buzz.agents/agents":
    case "buzz.workflows/workflows":
      return "topbar";
    default:
      return page.placement ?? "sidebar";
  }
}

type PagePresentation = Readonly<{
  label: string;
  icon: typeof BrowserIcon;
  tone: string;
  image?: string;
}>;
export function pagePresentation(page: RegisteredPage): PagePresentation {
  if (page.key === "buzz.channels/channels") return shellPresentation.channels;
  const tone = page.layout === "workspace" ? "lime" : "sky";
  const bundledIcon = bundledIcons.get(page.key);
  if (bundledIcon) return { label: page.title, icon: bundledIcon, tone };
  return {
    label: page.title,
    icon: BrowserIcon,
    tone,
    ...(page.icon === undefined ? {} : { image: page.icon }),
  };
}

// Header selection describes the area; sidebar selection and routes stay exact.
export function headerPageSelection(
  pages: readonly RegisteredPage[],
  selected: string,
): string {
  const page = pages.find((page) => page.key === selected);
  const placement = page && pagePlacement(page);
  const messages = pages.find((page) => page.key === "buzz.channels/channels");
  return page &&
    (placement === undefined || placement === "sidebar") &&
    messages &&
    pagePlacement(messages) === "topbar"
    ? messages.key
    : selected;
}
