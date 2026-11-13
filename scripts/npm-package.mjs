// The npm package's package.json (scripts/build-npm.mjs), kept apart so tests can check it without a build.
/** package.json for npm: one file to run, nothing to install alongside it. */
export function npmPackage(version) {
  return {
    name: "justrefresh",
    version,
    description: "Local MCP bridge for the JustRefresh Chrome extension: AI apps on your computer can set up auto-refresh rules, with your approval.",
    keywords: ["mcp", "model-context-protocol", "chrome-extension", "auto-refresh", "justrefresh"],
    homepage: "https://github.com/marcykay404/JustRefresh/blob/main/bridge/README.md",
    repository: { type: "git", url: "git+https://github.com/marcykay404/JustRefresh.git", directory: "bridge" },
    bugs: { url: "https://github.com/marcykay404/JustRefresh/issues" },
    license: "MIT",
    type: "module",
    bin: { justrefresh: "justrefresh-bridge.mjs" },
    files: ["justrefresh-bridge.mjs", "README.md", "LICENSE"],
    engines: { node: ">=18" },
  };
}
