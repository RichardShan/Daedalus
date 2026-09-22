import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

await mkdir("dist", { recursive: true });
await mkdir("dist/media", { recursive: true });

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/mcp-server.ts"],
    outfile: "dist/mcp-server.cjs",
    format: "cjs",
  },
];

await Promise.all([
  copyFile("media/webview.js", "dist/media/webview.js"),
  copyFile("media/webview.css", "dist/media/webview.css"),
]);

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching extension and MCP server...");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
