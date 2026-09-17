import {
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { buildPlugin } from "./examples/backend-preferences-source/scripts/build.mjs";
import { validatePackage, readZip } from "./package-validation.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
export async function exportBackendStarter(out) {
  const scratch = await mkdtemp(path.join(tmpdir(), "pcbjam-backend-example-"));
  try {
    await mkdir(out, { recursive: true });
    const built = await buildPlugin(scratch);
    validatePackage(readZip(await readFile(built.zip)));
    await copyFile(built.zip, path.join(out, "backend-preferences.zip"));
    const names = [
      ".gitignore",
      "README.md",
      "manifest.json",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.logic.json",
      "tsconfig.ui.json",
      "scripts/build.mjs",
      "scripts/watch.mjs",
      "types/logic.d.ts",
      "types/ui.d.ts",
      "src/main.ts",
      "src/ui/main.tsx",
      "src/ui/App.tsx",
      "src/ui/styles.css",
      "backend/package.json",
      "backend/package-lock.json",
      "backend/server.ts",
      "backend/schema.sql",
      "backend/backend-verifier.mjs",
      "backend/backend-verifier.d.mts",
    ];
    const files = {};
    for (const name of names) {
      const bytes = await readFile(
        path.join(root, "examples/backend-preferences-source", name)
      );
      files["backend-preferences-source/" + name] = [
        bytes,
        { mtime: new Date("2020-01-01T00:00:00Z") },
      ];
    }
    await writeFile(
      path.join(out, "backend-preferences-source.zip"),
      zipSync(files, { level: 9 })
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
