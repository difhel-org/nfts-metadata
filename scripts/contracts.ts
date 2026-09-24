import { Address, beginCell, Cell, contractAddress, Dictionary, toNano } from '@ton/core';
import type { DictionaryValue } from '@ton/core';
import collectionArtifact from '../artifacts/NftCollection.json';
import itemArtifact from '../artifacts/NftItem.json';

export const METADATA_ROOT = 'https://raw.githubusercontent.com/difhel-org/nfts-metadata/main/persik/';
export const COLLECTION_URL = `${METADATA_ROOT}collection.json`;
export const ITEM_PREFIX = `${METADATA_ROOT}tokens/`;
export const ITEM_VALUE = toNano('0.08');
export const COLLECTION_RESERVE = toNano('0.05');
export const PER_ITEM_OVERHEAD = toNano('0.02');
export const WALLET_FEE_BUFFER = toNano('0.05');
export const BURN_ADDRESS = new Address(0, Buffer.alloc(32));

function artifactCode(artifact: typeof itemArtifact): Cell {
  const code = Cell.fromBase64(artifact.codeBoc64);
  if (code.hash().toString('hex') !== artifact.codeHashHex.toLowerCase()) throw new Error('Artifact hash mismatch');
  return code;
}
export const ITEM_CODE = artifactCode(itemArtifact);
export const COLLECTION_CODE = artifactCode(collectionArtifact);
export const snake = (text: string) => beginCell().storeStringTail(text).endCell();
export const collectionMetadata = () => beginCell().storeUint(1, 8).storeStringTail(COLLECTION_URL).endCell();

export function collectionData(admin: Address, nextIndex = 0n): Cell {
  return beginCell().storeAddress(admin).storeUint(nextIndex, 64)
    .storeRef(beginCell().storeRef(collectionMetadata()).storeRef(snake(ITEM_PREFIX)))
    .storeRef(ITEM_CODE)
    .storeRef(beginCell().storeUint(100, 16).storeUint(1000, 16).storeAddress(admin))
    .endCell();
}
export function collectionFor(admin: Address) {
  const init = { code: COLLECTION_CODE, data: collectionData(admin) };
  return { address: contractAddress(0, init), init };
}
export function itemFor(collection: Address, index: number) {
  const init = { code: ITEM_CODE, data: beginCell().storeUint(index, 64).storeAddress(collection).endCell() };
  return { address: contractAddress(0, init), init };
}
export function itemParams(owner: Address, index: number): Cell {
  return beginCell().storeAddress(owner).storeRef(snake(`${index}.json`)).endCell();
}
const batchValue: DictionaryValue<Cell> = {
  serialize: (params, builder) => { builder.storeCoins(ITEM_VALUE).storeRef(params); },
  parse: slice => { slice.loadCoins(); return slice.loadRef(); },
};
export function mintBody(indices: number[], owner: Address, queryId: bigint): Cell {
  if (!indices.length || indices.length >= 250 || new Set(indices).size !== indices.length) throw new Error('Invalid mint batch');
  if (indices.length === 1) return beginCell().storeUint(1, 32).storeUint(queryId, 64)
    .storeUint(indices[0]!, 64).storeCoins(ITEM_VALUE).storeRef(itemParams(owner, indices[0]!)).endCell();
  const dict = Dictionary.empty(Dictionary.Keys.BigUint(64), batchValue);
  for (const index of indices) dict.set(BigInt(index), itemParams(owner, index));
  return beginCell().storeUint(2, 32).storeUint(queryId, 64).storeDict(dict).endCell();
}
export const mintValue = (count: number, deployCollection: boolean) =>
  (ITEM_VALUE + PER_ITEM_OVERHEAD) * BigInt(count) + (deployCollection ? COLLECTION_RESERVE : 0n);

export function parseItem(data: Cell, collection: Address, index: number) {
  const slice = data.beginParse();
  if (slice.loadUintBig(64) !== BigInt(index) || !slice.loadAddress().equals(collection)) throw new Error(`NFT #${index}: unexpected identity`);
  if (!slice.remainingBits && !slice.remainingRefs) throw new Error(`NFT #${index}: active but not initialized; inspect on-chain state before retrying`);
  const owner = slice.loadAddress();
  const content = slice.loadRef().beginParse().loadStringTail();
  slice.endParse();
  return { owner, content };
}
