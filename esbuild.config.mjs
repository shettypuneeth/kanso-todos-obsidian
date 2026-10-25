import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const license = readFileSync(new URL("./LICENSE", import.meta.url), "utf8").trim();
const yamlLicense = readFileSync(new URL("./node_modules/yaml/LICENSE", import.meta.url), "utf8").trim();
const options = {
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
  banner: { js: `/* Generated from src/main.ts.\n\n${license}\n\nBundled dependency: yaml (ISC)\n\n${yamlLicense}\n*/` },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
