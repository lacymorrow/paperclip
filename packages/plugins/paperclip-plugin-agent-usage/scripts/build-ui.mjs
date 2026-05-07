import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

// Bundle worker — self-contained so it doesn't rely on workspace TS sources at runtime
await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/worker.ts")],
  outfile: path.join(packageRoot, "dist/worker.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  sourcemap: true,
  external: [],
  banner: { js: "// @paperclipai/plugin-agent-usage worker (bundled)" },
  logLevel: "info",
});

// Bundle manifest
await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/manifest.ts")],
  outfile: path.join(packageRoot, "dist/manifest.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  sourcemap: true,
  external: [],
  logLevel: "info",
});

// Bundle UI
await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});
