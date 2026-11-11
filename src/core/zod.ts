/**
 * zod for the service worker: the tree-shakable "mini" build (a third of the
 * size of the full one), with English error messages, which the full build
 * would have configured on import.
 */
import * as z from "zod/mini";

z.config(z.locales.en());

export { z };
