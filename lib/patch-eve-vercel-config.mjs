import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const eveFunctionMaxDuration = 800;
const outputRoots = [".eve/nitro-output", ".vercel/output/functions"];
const configPaths = [];

for (const root of outputRoots) {
  await collectVercelFunctionConfigs(root);
}

await Promise.all(configPaths.map(patchConfig));

async function collectVercelFunctionConfigs(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectVercelFunctionConfigs(path);
      continue;
    }

    if (entry.name === ".vc-config.json" && path.includes("__server.func")) {
      configPaths.push(path);
    }
  }
}

async function patchConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  config.maxDuration = Math.max(
    Number(config.maxDuration ?? 0),
    eveFunctionMaxDuration,
  );
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Set eve Vercel function maxDuration=${config.maxDuration} in ${path}`);
}
