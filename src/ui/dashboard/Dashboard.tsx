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

export function Dashboard() {
  const [route] = useHashRoute();
  const overview = useApi<{ pendingApprovals: number; pendingAgents: number; settings: { paused: boolean; enabled: boolean } }>("getOverview", undefined, { pollMs: 5000 });
  const [pathPart, query = ""] = route.split("?");
  const [, section, arg] = pathPart.split("/");
  const params = new URLSearchParams(query);
  const pending = (overview.data?.pendingApprovals ?? 0) + (overview.data?.pendingAgents ?? 0);

  let view;
  switch (section) {
    case "rules":
      view = <RulesView />;
      break;
    case "builder":
      view = (
        <RuleBuilder
          key={arg ?? params.get("url") ?? params.get("draft") ?? "new"}
          ruleId={arg}
          initialUrl={params.get("url") ?? undefined}
          fromTemplate={params.get("draft") === "template"}
        />
      );
      break;
    case "templates":
      view = <TemplatesView />;
      break;
    case "exclusions":
      view = <ExclusionsView />;
      break;
    case "history":
      view = <HistoryView />;
      break;
    case "agents":
      view = <AgentsView />;
      break;
    case "settings":
      view = <SettingsView />;
      break;
    default:
      view = <TabsView />;
  }

  // The first-run page stands alone, without the dashboard's navigation.
  if (section === "welcome") return <WelcomeView />;

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Sections">
        <div className="brand">
          <img src="icons/icon48.png" alt="" /> JustRefresh
        </div>
        {NAV.map((n) => (
          <a key={n.path} href={`#${n.path}`} className={`/${section ?? "tabs"}` === n.path ? "active" : ""}>
            {n.label}
            {n.path === "/agents" && pending > 0 && <span className="badge">{pending}</span>}
          </a>
        ))}
        <div className="spacer" />
        {overview.data?.settings.paused && <span className="pill pill-warn">All refreshing paused</span>}
        {overview.data && !overview.data.settings.enabled && <span className="pill pill-muted">Extension disabled</span>}
      </nav>
      <main className="main">{view}</main>
    </div>
  );
}
