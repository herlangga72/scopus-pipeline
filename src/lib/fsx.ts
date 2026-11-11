import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function listJsonIds(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const files = await readdir(dir);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

export function jsonPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export async function writeBufferAtomic(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)));
  await rename(tmp, path);
}
