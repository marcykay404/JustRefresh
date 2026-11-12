/** Settings → Support JustRefresh: a plain link to the developer's Buy Me a Coffee page. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SOURCE_URL, SUPPORT_URL, SupportCard } from "@/ui/dashboard/SettingsView";

describe("support link", () => {
  it("opens the Buy Me a Coffee page in a new tab, telling that page nothing about where it came from", () => {
    const html = renderToStaticMarkup(createElement(SupportCard));
    expect(SUPPORT_URL).toBe("https://buymeacoffee.com/marcykaycod");
    expect(html).toContain(`href="${SUPPORT_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Screen readers say where it goes.
    expect(html).toContain('aria-describedby="support-link-note"');
    expect(html).toContain('id="support-link-note"');
    // The source code, the same way.
    expect(SOURCE_URL).toBe("https://github.com/marcykay404/JustRefresh");
    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    // Links only: no script, image or frame from their sites.
    expect(html).not.toMatch(/<(script|img|iframe)/);
  });
});
