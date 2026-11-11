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
          <p className="muted" style={{ margin: 0 }}>Everything stays on this computer: no account, no tracking.</p>
        </header>

        <ol className="welcome-steps">
          <li className="card col">
            <span className="step-number" aria-hidden>1</span>
            <h2>Pin it to your toolbar</h2>
            <p>Click the puzzle-piece icon next to the address bar, then the pin beside JustRefresh.</p>
            <p>
              Then, on any page, click the JustRefresh icon, tap an interval and press <strong>Start</strong>.
            </p>
          </li>
          <li className="card col">
            <span className="step-number" aria-hidden>2</span>
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
            <span className="step-number" aria-hidden>3</span>
            <h2>Wait for something to happen</h2>
            <div className="welcome-example">Refreshing every 1 min until “In stock” appears, then notify me</div>
            <p>
              In the popup, <strong>More → Refresh until something appears</strong> stops and notifies you, with a sound, when a word shows up.
            </p>
            <p>Or start from a template: restocks, order status, failed builds, dashboards during work hours.</p>
          </li>
        </ol>

        <div className="row" style={{ gap: 12 }}>
          <a className="btn primary big-link" href="#/templates">Browse templates</a>
          <a className="btn big-link" href="#/tabs">Open the dashboard</a>
          <button className="link" onClick={closeThisTab}>Close this page</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>You can open this page again from Settings → Help.</p>
      </main>
    </div>
  );
}
