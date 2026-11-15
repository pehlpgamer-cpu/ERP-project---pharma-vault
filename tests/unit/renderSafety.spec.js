import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@japa/runner";

// The hbs view engine has a known, unpatched file-disclosure weakness (GHSL-2021-020): it mixes the data
// given to res.render with the engine's own options, so request-controlled keys at the top level of
// that data could overwrite them. Nothing here does that; this test keeps it that way.
const CONTROLLERS = join(import.meta.dirname, "../../app/http/controllers");

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? sources(path) : [path];
  });
}

test("no controller hands request data to res.render as its options", ({ expect }) => {
  const offenders = [];

  for (const file of sources(CONTROLLERS)) {
    // every res.render( ... ) call, up to its closing line
    const calls = readFileSync(file, "utf8").match(/res\.render\([\s\S]*?\n\s*\}?\);/g) ?? [];

    for (const call of calls) {
      if (/\.\.\.\s*req\.|render\([^,]+,\s*req\.(body|query|params)/.test(call)) {
        offenders.push(file);
      }
    }
  }

  expect(offenders).toEqual([]);
});
