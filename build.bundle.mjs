// Builds js/editor.js (+ node_modules deps) → js/cm.bundle.js
// Run via: npm run build:bundle
// This regenerates the editor bundle so editor.js edits take effect.
// Without this step, the committed cm.bundle.js drifts from editor.js (Q1).
import * as esbuild from "esbuild";

const entry = "js/editor.js";
const outfile = "js/cm.bundle.js";

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
  logLevel: "info",
});

console.log(`✓ bundled ${entry} → ${outfile}`);
