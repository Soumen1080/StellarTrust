/**
 * Metro configuration.
 *
 * `@stellartrust/shared` is a `file:` dependency living outside this package,
 * which npm links as a symlink. Metro watches only the project root by
 * default, so the shared sources would otherwise be invisible to the bundler
 * even though TypeScript resolves them fine.
 *
 * Two settings fix that, and both are needed:
 *
 *  - `watchFolders` puts the shared package inside Metro's watch set, so its
 *    files can be read and a change to a contract triggers a reload.
 *  - `nodeModulesPaths` keeps module resolution anchored to this app's
 *    `node_modules`. Without it, a package imported from inside the shared
 *    folder resolves against the monorepo root and can pick up a second copy
 *    of React — which fails at runtime with the invalid-hook-call error rather
 *    than at build time.
 *
 * Symlink resolution itself is no longer configured here: Metro has handled it
 * natively since SDK 53, and the old `unstable_enableSymlinks` override now
 * only trips `expo-doctor`'s config check.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "..", "shared");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(sharedRoot, "node_modules"),
];

module.exports = config;
