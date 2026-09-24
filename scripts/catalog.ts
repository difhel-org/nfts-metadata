import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export interface NftRecord { index: number; name: string }
export type NftStatus = 'non-existent' | 'deployed' | 'burned';
export const STATUS: Record<NftStatus, string> = { 'non-existent': '❌ non-existent', deployed: '✅ deployed', burned: '🔥 burned' };
export const ROOT = resolve(import.meta.dir, '..');
export async function loadCatalog(root = ROOT): Promise<{ name: string; items: NftRecord[] }> {
  const collection = JSON.parse(await readFile(resolve(root, 'persik/collection.json'), 'utf8'));
  if (typeof collection.name !== 'string' || !collection.name.trim()) throw new Error('Collection name is missing');
  const dir = resolve(root, 'persik/tokens');
  const items: NftRecord[] = [];
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json')) continue;
    if (!/^(0|[1-9]\d*)\.json$/.test(file)) throw new Error(`Invalid NFT filename: ${file}`);
    const index = Number(file.slice(0, -5));
    if (!Number.isSafeInteger(index)) throw new Error(`Invalid NFT index: ${file}`);
    const metadata = JSON.parse(await readFile(resolve(dir, file), 'utf8'));
    if (typeof metadata.name !== 'string' || !metadata.name.trim()) throw new Error(`${file}: missing name`);
    items.push({ index, name: metadata.name });
  }
  items.sort((a, b) => a.index - b.index);
  if (!items.length) throw new Error('No NFT manifests found');
  return { name: collection.name, items };
}
export function parseRange(args: string[]): [number, number] {
  if (args.length !== 2 || args.some(x => !/^(0|[1-9]\d*)$/.test(x) || !Number.isSafeInteger(Number(x)))) throw new Error('Usage: bun run mint <start index> <stop index> (inclusive, non-negative integers)');
  const start = Number(args[0]), stop = Number(args[1]);
  if (start > stop) throw new Error('Start index must not exceed stop index');
  return [start, stop];
}
export function selectRange(items: NftRecord[], start: number, stop: number) {
  const selected = items.filter(item => item.index >= start && item.index <= stop);
  if (selected.length !== stop - start + 1) throw new Error('Every index in the requested range must have a JSON manifest');
  return selected;
}
export function validateMintOrder(indices: number[], nextIndex: bigint) {
  for (const index of [...indices].sort((a,b) => a-b)) {
    if (BigInt(index) > nextIndex) throw new Error(`Cannot mint #${index}: mint #${nextIndex} first (the contract requires consecutive new indices)`);
    if (BigInt(index) === nextIndex) nextIndex++;
  }
}
