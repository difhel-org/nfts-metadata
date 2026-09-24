import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { Address, beginCell, toNano } from '@ton/core';
import { Chain, isBurn } from '../scripts/network';
import type { HistoryTransaction } from '../scripts/network';
import { BURN_ADDRESS, COLLECTION_CODE, ITEM_CODE, collectionData, collectionFor, itemFor, itemParams } from '../scripts/contracts';
import { loadCatalog, parseRange, selectRange, validateMintOrder } from '../scripts/catalog';
import { isConfirmation, main } from '../scripts/cli';
import { parseEnvironment, walletFor } from '../scripts/wallet';

const admin = new Address(0, Buffer.alloc(32, 5));
const collection = collectionFor(admin);
const nft = itemFor(collection.address, 0);
function tx(overrides: Partial<HistoryTransaction> = {}): HistoryTransaction {
  return {
    account: nft.address.toRawString(), lt: '100', orig_status: 'active', end_status: 'nonexist',
    description: { aborted: false, destroyed: true, compute_ph: { success: true }, action: { success: true } },
    in_msg: { bounced: false, message_content: { body: beginCell().storeUint(0x5fcc3d14, 32).storeUint(1, 64).storeAddress(BURN_ADDRESS).endCell().toBoc().toString('base64') } },
    ...overrides,
  };
}
class TestChain extends Chain {
  constructor() { super('testnet'); }
  override read<T>(fn: () => Promise<T>) { return fn(); }
}
function state(overrides: Partial<Awaited<ReturnType<Chain['state']>>> = {}): Awaited<ReturnType<Chain['state']>> {
  return { state: 'uninitialized', balance: 0n, code: null, data: null, lastTransaction: null,
    extra_currencies: undefined, blockId: { workchain: 0, shard: '', seqno: 1 }, timestampt: 0, ...overrides };
}
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); });
function history(...pages: HistoryTransaction[][]) {
  fetchSpy = spyOn(globalThis, 'fetch');
  for (const transactions of pages) fetchSpy.mockResolvedValueOnce(Response.json({ transactions }));
}

describe('CLI input and deployment plan', () => {
  test('catalog comes from all 20 repo manifests', async () => {
    const catalog = await loadCatalog();
    expect(catalog.name).toBe('Difhel’s Persik Lab');
    expect(catalog.items.length).toBe(20);
    expect(selectRange(catalog.items, 0, 0).map(x => x.name)).toEqual(['Genesis Persik #0']);
    expect(selectRange(catalog.items, 3, 9).length).toBe(7);
    expect(() => selectRange(catalog.items, 19, 20)).toThrow();
  });
  test('ranges are inclusive and strictly validated', () => {
    expect(parseRange(['0', '0'])).toEqual([0, 0]);
    for (const args of [[], ['0'], ['1', '0'], ['-1', '2'], ['1.1', '3'], ['0', '1', '2'], ['0', '1e2'], ['0', '9007199254740992']]) expect(() => parseRange(args)).toThrow();
    expect(() => validateMintOrder([0, 2, 3], 2n)).not.toThrow();
    expect(() => validateMintOrder([2], 0n)).toThrow('mint #0 first');
  });
  test('only explicit y confirms', () => {
    expect(isConfirmation('Y')).toBe(true);
    for (const answer of ['', 'n', 'no', 'yes', 'ok']) expect(isConfirmation(answer)).toBe(false);
  });
  test('argument errors happen before loading secrets or making RPC calls', async () => {
    await expect(main(['mint', '-1', '0'], {})).rejects.toThrow('Usage');
    await expect(main(['info', 'extra'], {})).rejects.toThrow('Usage');
    await expect(main(['mint', '0', '99'], {})).rejects.toThrow('JSON manifest');
  });
  test('only supported wallets/networks; W5 uses the appropriate network ID', () => {
    expect(parseEnvironment({ WALLET_VERSION: 'w5' }).network).toBe('mainnet');
    expect(() => parseEnvironment({ WALLET_VERSION: 'v3' })).toThrow();
    expect(() => parseEnvironment({ WALLET_VERSION: 'v4r2', TON_NETWORK: 'other' })).toThrow();
    const key = Buffer.alloc(32, 7);
    expect(walletFor(key, 'w5', 'mainnet').address.equals(walletFor(key, 'w5', 'testnet').address)).toBe(false);
    expect(walletFor(key, 'v4r2', 'mainnet').address.equals(walletFor(key, 'v4r2', 'testnet').address)).toBe(true);
  });
});
describe('on-chain status, never inferred from high-water index', () => {
  test('valid burn requires destruction, successful execution, and zero-address transfer', () => {
    expect(isBurn(tx())).toBe(true);
    expect(isBurn(tx({ description: { destroyed: true, aborted: true } }))).toBe(false);
    expect(isBurn(tx({ end_status: 'active' }))).toBe(false);
    expect(isBurn(tx({ in_msg: null }))).toBe(false);
    expect(isBurn(tx({ in_msg: { bounced: false, message_content: { body: beginCell().storeUint(0x5fcc3d14, 32).storeUint(1, 64).storeAddress(admin).endCell().toBoc().toString('base64') } } }))).toBe(false);
  });
  test('never deployed, including dust-only accounts, is non-existent', async () => {
    history([], [tx({ orig_status: 'uninit', end_status: 'uninit', description: {}, in_msg: null })]);
    expect(await new TestChain().absentStatus(nft.address)).toBe('non-existent');
    expect(await new TestChain().absentStatus(nft.address, '100')).toBe('non-existent');
  });
  test('burned then funded with dust is still burned', async () => {
    history([tx({ lt: '101', orig_status: 'nonexist', end_status: 'uninit', description: {}, in_msg: null }), tx()]);
    expect(await new TestChain().absentStatus(nft.address, '101')).toBe('burned');
  });
  test('paginates through unrelated transactions after burn', async () => {
    history(Array.from({ length: 100 }, (_, i) => tx({ lt: String(200-i), orig_status: 'uninit', end_status: 'uninit', description: {}, in_msg: null })), [tx()]);
    expect(await new TestChain().absentStatus(nft.address, '200')).toBe('burned');
    expect(String(fetchSpy!.mock.calls[1]![0])).toContain('end_lt=100');
  });
  test('storage deletion and failed mint are not classified as burns', async () => {
    history([tx({ description: { aborted: false, destroyed: false } })]);
    expect(await new TestChain().absentStatus(nft.address, '100')).toBe('non-existent');
  });
  test('stale history and provider failures are errors, not non-existent', async () => {
    history([]);
    await expect(new TestChain().absentStatus(nft.address, '100')).rejects.toThrow('behind');
    fetchSpy!.mockResolvedValueOnce(new Response('no', { status: 401 }));
    await expect(new TestChain().absentStatus(nft.address)).rejects.toThrow('HTTP 401');
    fetchSpy!.mockResolvedValueOnce(Response.json({}));
    await expect(new TestChain().absentStatus(nft.address)).rejects.toThrow('invalid');
  });
  test('active re-minted NFT takes precedence over historical burns', async () => {
    const chain = new TestChain();
    chain.state = async () => state({ state: 'active', code: ITEM_CODE.toBoc(), data: beginCell().storeUint(0, 64).storeAddress(collection.address).storeSlice(itemParams(admin, 0).beginParse()).endCell().toBoc() });
    const result = await chain.nft(nft.address, collection.address, 0);
    expect(result.status).toBe('deployed');
    expect(result.owner!.equals(admin)).toBe(true);
    expect(result.content).toBe('0.json');
  });
  test('frozen and uninitialized active contracts do not become fake burn/mint candidates', async () => {
    const chain = new TestChain();
    chain.state = async () => state({ state: 'frozen' });
    await expect(chain.nft(nft.address, collection.address, 0)).rejects.toThrow('frozen');
    chain.state = async () => state({ state: 'active', code: ITEM_CODE.toBoc(), data: nft.init.data.toBoc() });
    await expect(chain.nft(nft.address, collection.address, 0)).rejects.toThrow('not initialized');
  });
  test('collection verifies its code, admin, metadata and next index', async () => {
    const chain = new TestChain();
    chain.state = async () => state({ state: 'active', code: COLLECTION_CODE.toBoc(), data: collectionData(admin, 7n).toBoc(), balance: toNano('1') });
    expect(await chain.collection(collection.address, admin)).toEqual({ deployed: true, nextIndex: 7n });
    await expect(chain.collection(collection.address, BURN_ADDRESS)).rejects.toThrow('admin');
  });
});
