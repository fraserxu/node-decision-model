import { defineConfig } from "tsup";

const shared = { sourcemap: true, target: "node20", clean: false } as const;

// tsup builds the entries of an array config in parallel, so neither entry
// cleans dist/ itself; the build script removes it once before running tsup.
export default defineConfig([
  {
    ...shared,
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli/main.ts" },
    format: ["esm"],
    esbuildPlugins: [
      {
        // The CLI imports the library through its public entry. Keep that
        // import external so dist/cli.js loads dist/index.js instead of
        // bundling a second copy of the library.
        name: "library-entry-external",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/index\.js$/ }, () => ({
            path: "./index.js",
            external: true,
          }));
        },
      },
    ],
  },
]);
