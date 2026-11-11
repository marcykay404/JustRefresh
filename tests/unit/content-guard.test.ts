// @vitest-environment jsdom
/** The content script sets a page up once per version: a second copy of the same version does nothing, a newer one takes over. */
let version = "1.0.0";
const addListener = vi.fn();
(globalThis as { chrome?: unknown }).chrome = { runtime: { id: "ext", getManifest: () => ({ version }), onMessage: { addListener } } };

const inject = async () => {
  vi.resetModules();
  await import("@/content/index");
};

it("sets up once per version", async () => {
  await inject();
  await inject();
  expect(addListener).toHaveBeenCalledTimes(1);
  // After an update the old copy is cut off but its flag remains: the new version still sets up.
  version = "1.0.1";
  await inject();
  expect(addListener).toHaveBeenCalledTimes(2);
});
