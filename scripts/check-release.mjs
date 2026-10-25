import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const [manifest, pkg, lock, versions] = await Promise.all(
  ["manifest.json", "package.json", "package-lock.json", "versions.json"].map(readJson),
);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "Release version must be x.y.z");
assert.equal(manifest.id, "kanso-todos");
assert.equal(manifest.version, pkg.version, "Package and manifest versions differ");
assert.equal(manifest.version, lock.version, "Lockfile version differs");
assert.equal(manifest.version, lock.packages[""].version, "Lockfile root version differs");
assert.equal(pkg.name, lock.name, "Lockfile package name differs");
assert.equal(versions[manifest.version], manifest.minAppVersion, "Missing compatibility entry");
if (process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(process.env.GITHUB_REF_NAME, manifest.version, "Release tag must match manifest version exactly");
}
const bundle = await readFile(new URL("../main.js", import.meta.url), "utf8");
assert.ok(!bundle.includes("sourceMappingURL="), "Production bundle must not include a sourcemap");
assert.ok(bundle.includes("Copyright Eemeli Aro"), "Bundled YAML license notice is missing");
await Promise.all(["styles.css", "README.md", "LICENSE"].map(path =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8")));
console.log(`Release metadata and assets verified for ${manifest.version}`);
