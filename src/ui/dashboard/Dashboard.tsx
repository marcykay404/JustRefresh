import type { ComponentType } from "react";
import { useApi, useHashRoute } from "../shared/hooks";
import { TabsView } from "./TabsView";
import { RulesView } from "./RulesView";
import { ExclusionsView } from "./ExclusionsView";
import { HistoryView } from "./HistoryView";
import { AgentsView } from "./AgentsView";
import { SettingsView } from "./SettingsView";
import { RuleBuilder } from "../rule-builder/RuleBuilder";
import { TemplatesView } from "./TemplatesView";
import { WelcomeView } from "./WelcomeView";

const NAV = [
  { path: "/tabs", label: "Tabs" },
  { path: "/rules", label: "Rules" },
  { path: "/templates", label: "Templates" },
  { path: "/builder", label: "Rule Builder" },
  { path: "/exclusions", label: "Exclusions" },
  { path: "/history", label: "History" },
  { path: "/agents", label: "Agent Integrations" },
  { path: "/settings", label: "Settings" },
];

type OverviewData = { pendingApprovals: number; pendingAgents: number; settings: { paused: boolean; enabled: boolean } };

/** Sections without parameters; anything unknown shows the Tabs view. */
const VIEWS: Record<string, ComponentType> = {
  tabs: TabsView,
  rules: RulesView,
  templates: TemplatesView,
  exclusions: ExclusionsView,
  history: HistoryView,
  agents: AgentsView,
  settings: SettingsView,
};

function SectionView({ section, arg, params }: { section?: string; arg?: string; params: URLSearchParams }) {
  if (section === "builder") {
    return (
      <RuleBuilder
        key={arg ?? params.get("url") ?? params.get("draft") ?? "new"}
        ruleId={arg}
        initialUrl={params.get("url") ?? undefined}
        fromTemplate={params.get("draft") === "template"}
      />
    );
  }
  const View = section && Object.hasOwn(VIEWS, section) ? VIEWS[section]! : TabsView;
  return <View />;
}

function Sidebar({ section, overview }: { section?: string; overview: OverviewData | null }) {
  const pending = (overview?.pendingApprovals ?? 0) + (overview?.pendingAgents ?? 0);
  const current = `/${section ?? "tabs"}`;
  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="brand">
        <img src="icons/icon48.png" alt="" /> JustRefresh
      </div>
      {NAV.map((n) => (
        <a key={n.path} href={`#${n.path}`} className={current === n.path ? "active" : ""}>
          {n.label}
          {n.path === "/agents" && pending > 0 && <span className="badge">{pending}</span>}
        </a>
      ))}
      <div className="spacer" />
      {overview?.settings.paused && <span className="pill pill-warn">All refreshing paused</span>}
      {overview && !overview.settings.enabled && <span className="pill pill-muted">Extension disabled</span>}
    </nav>
  );
}

export function Dashboard() {
  const [route] = useHashRoute();
  const overview = useApi<OverviewData>("getOverview", undefined, { live: ["config"] });
  const [pathPart, query = ""] = route.split("?");
  const [, section, arg] = pathPart.split("/");

  // The first-run page stands alone, without the dashboard's navigation.
  if (section === "welcome") return <WelcomeView />;

  return (
    <div className="layout">
      <Sidebar section={section} overview={overview.data} />
      <main className="main">
        <SectionView section={section} arg={arg} params={new URLSearchParams(query)} />
      </main>
    </div>
  );
}
