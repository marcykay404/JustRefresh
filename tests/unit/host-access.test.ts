/** Content-script registration follows granted sites, and drops registrations this version doesn't use. */
import { CONTENT_SCRIPT_ID, syncContentScripts } from "@/background/host-access";

let origins: string[] = [];
let registered: { id: string; matches?: string[] }[] = [];
const scripting = {
  getRegisteredContentScripts: vi.fn(async () => registered.map((s) => ({ ...s }))),
  unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => void (registered = registered.filter((s) => !ids.includes(s.id)))),
  registerContentScripts: vi.fn(async (list: { id: string; matches: string[] }[]) => void registered.push(...list)),
  updateContentScripts: vi.fn(async (list: { id: string; matches: string[] }[]) => {
    for (const s of list) registered = registered.map((r) => (r.id === s.id ? s : r));
  }),
};
(globalThis as { chrome?: unknown }).chrome = { scripting, permissions: { getAll: async () => ({ origins }) } };

beforeEach(() => {
  origins = [];
  registered = [];
  vi.clearAllMocks();
});

it("registers for the granted sites, updates, and unregisters when none are left", async () => {
  origins = ["https://a.com/*"];
  await syncContentScripts();
  expect(registered).toMatchObject([{ id: CONTENT_SCRIPT_ID, matches: ["https://a.com/*"] }]);
  origins = ["https://a.com/*", "https://b.com/*"];
  await syncContentScripts();
  expect(scripting.updateContentScripts).toHaveBeenCalledTimes(1);
  expect(registered).toMatchObject([{ id: CONTENT_SCRIPT_ID, matches: ["https://a.com/*", "https://b.com/*"] }]);
  origins = [];
  await syncContentScripts();
  expect(registered).toEqual([]);
});

it("after an update, drops a registration under an id this version doesn't use", async () => {
  registered = [{ id: "old-content", matches: ["https://a.com/*"] }];
  origins = ["https://a.com/*"];
  await syncContentScripts();
  expect(registered.map((s) => s.id)).toEqual([CONTENT_SCRIPT_ID]);
  // Also when no site is granted any more.
  registered = [{ id: "old-content" }];
  origins = [];
  await syncContentScripts();
  expect(registered).toEqual([]);
});
