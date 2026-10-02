import { readFileSync } from "node:fs";

const PACKAGE_NAME = "node-decision-model";

/**
 * The published version, read from package.json so `--version`, the
 * User-Agent, and the package version cannot drift apart. This module runs
 * from `src/` under vitest and from `dist/` once built (ESM and CJS; tsup
 * shims `import.meta.url` for CJS), and package.json sits one level above
 * both, so the relative path is the same in every case. npm always packs
 * package.json, so it is present in the installed package too.
 */
function readPackageVersion(): string {
  const url = new URL("../package.json", import.meta.url);
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(readFileSync(url, "utf8")) as { name?: unknown; version?: unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read the ${PACKAGE_NAME} version from ${url.pathname}: ${message}`);
  }
  if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error(`${url.pathname} is not the ${PACKAGE_NAME} package.json`);
  }
  return pkg.version;
}

export const VERSION: string = readPackageVersion();
