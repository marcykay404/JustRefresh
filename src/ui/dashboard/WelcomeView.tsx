/**
 * First-run welcome page: opened once in a new tab after install (never on
 * updates), and again from Settings → Help. Three short steps instead of a
 * click-through tour.
 */
function closeThisTab() {
  void chrome.tabs.getCurrent().then((t) => (t?.id !== undefined ? chrome.tabs.remove(t.id) : window.close()));
}

export function WelcomeView() {
  return (
    <div className="welcome">
      <main className="welcome-inner">
        <header className="col" style={{ gap: 10, maxWidth: 720 }}>
          <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
            <img src="icons/icon48.png" alt="" width={40} height={40} />
            <h1 style={{ margin: 0, fontSize: 30 }}>Welcome to JustRefresh</h1>
          </div>
          <p className="welcome-lead">Refresh tabs on a timer, or until something appears, without losing what you're typing.</p>
          <p className="muted" style={{ margin: 0 }}>
            Everything stays on this computer: no account, no tracking.
          </p>
        </header>

        <ol className="welcome-steps">
          <li className="card col">
            <span className="step-number" aria-hidden>
              1
            </span>
            <h2>Pin it to your toolbar</h2>
            <ToolbarPicture />
            <p>Click the puzzle-piece icon next to the address bar, then the pin beside JustRefresh.</p>
            <p>
              Then, on any page, click the JustRefresh icon, tap an interval and press <strong>Start</strong>.
            </p>
          </li>
          <li className="card col">
            <span className="step-number" aria-hidden>
              2
            </span>
            <h2>It won't refresh over your work</h2>
            <div className="welcome-example">
              <span className="ok-line">✓</span> Protected: waits while you're typing
            </div>
            <p>Before each refresh it checks that you aren't typing or halfway through a form, and waits if you are.</p>
            <p>
              To see that, Chrome asks you once per site. JustRefresh notices <em>that</em> you typed, never <em>what</em> you typed.
            </p>
          </li>
          <li className="card col">
            <span className="step-number" aria-hidden>
              3
            </span>
            <h2>Wait for something to happen</h2>
            <div className="welcome-example">Refreshing every 1 min until “In stock” appears, then notify me</div>
            <p>
              In the popup, <strong>More → Refresh until something appears</strong> stops and notifies you, with a sound, when a word shows up.
            </p>
            <p>Or start from a template: restocks, delivery or application status, failed builds, dashboards during work hours.</p>
          </li>
        </ol>

        <div className="row" style={{ gap: 12 }}>
          <a className="btn primary big-link" href="#/templates">
            Browse templates
          </a>
          <a className="btn big-link" href="#/tabs">
            Open the dashboard
          </a>
          <button className="link" onClick={closeThisTab}>
            Close this page
          </button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          You can open this page again from Settings → Help.
        </p>
      </main>
    </div>
  );
}

/** A sketch of Chrome's toolbar: the address bar, the Extensions (puzzle) button, and JustRefresh pinned. */
function ToolbarPicture() {
  return (
    <div className="welcome-example toolbar-picture" aria-hidden>
      <span className="toolbar-address" />
      {/* Puzzle piece: Lucide "puzzle" icon (ISC licence). */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="muted"
      >
        <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
      </svg>
      <img src="icons/icon32.png" alt="" width={24} height={24} />
    </div>
  );
}
