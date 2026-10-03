/** Each QA run owns its dependency cache; concurrent dev servers cannot replace it. */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const qaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function startQaServer(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid QA cache name");
  const cacheParent = await realpath(os.tmpdir());
  const prefix = `pace-${name}-qa-`;
  const cacheDir = await mkdtemp(path.join(cacheParent, prefix));
  const cleanup = async () => {
    // Resolve and verify the exact directory created by this run before deleting
    // recursively. Never remove the shared temp root or a redirected target.
    const resolved = await realpath(cacheDir);
    const samePath = (a, b) =>
      process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    if (
      !samePath(resolved, path.resolve(cacheDir)) ||
      !samePath(path.dirname(resolved), cacheParent) ||
      !path.basename(resolved).startsWith(prefix)
    )
      throw new Error(
        "Refusing to remove a QA cache outside its temporary parent",
      );
    await rm(resolved, { recursive: true, force: true });
  };
  let server;
  try {
    server = await createServer({
      root: qaRoot,
      configFile: path.join(qaRoot, "vite.config.ts"),
      cacheDir,
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        watch: { ignored: ["**/*"] },
      },
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("QA server did not bind a local port");
    return {
      root: qaRoot,
      cacheDir,
      baseURL: `http://127.0.0.1:${address.port}/`,
      async close() {
        try {
          await server.close();
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    try {
      if (server) await server.close();
    } finally {
      await cleanup();
    }
    throw error;
  }
}
