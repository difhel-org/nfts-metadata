import { RequestLimiter, requestsPerSecond } from './requests';
import { Address, Cell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { BURN_ADDRESS, COLLECTION_CODE, ITEM_CODE, collectionData, parseItem } from './contracts';
import type { NftStatus } from './catalog';

export type Network = 'mainnet' | 'testnet';
export interface HistoryTransaction {
  account: string;
  lt: string;
  orig_status: string;
  end_status: string;
  description: { aborted?: boolean; destroyed?: boolean; compute_ph?: { success?: boolean }; action?: { success?: boolean } };
  in_msg?: { bounced?: boolean; message_content?: { body?: string } } | null;
}
export function isBurn(tx: HistoryTransaction): boolean {
  const d = tx.description;
  if (tx.orig_status !== 'active' || tx.end_status !== 'nonexist' || d.aborted !== false || d.destroyed !== true || d.compute_ph?.success !== true || d.action?.success !== true || tx.in_msg?.bounced !== false) return false;
  const body = tx.in_msg.message_content?.body;
  if (!body) return false;
  try {
    const s = Cell.fromBase64(body).beginParse();
    if (s.loadUint(32) !== 0x5fcc3d14) return false;
    s.loadUintBig(64);
    return s.loadAddress().equals(BURN_ADDRESS);
  } catch { return false; }
}
export class Chain {
  readonly client: TonClient;
  private readonly limiter: RequestLimiter;
  private readonly base: string;
  constructor(readonly network: Network, private readonly apiKey?: string, private readonly report: (message: string) => void = () => {}, rps = requestsPerSecond(undefined, Boolean(apiKey))) {
    this.limiter = new RequestLimiter(rps);
    this.base = network === 'mainnet' ? 'https://toncenter.com' : 'https://testnet.toncenter.com';
    this.client = new TonClient({ endpoint: `${this.base}/api/v2/jsonRPC`, apiKey, timeout: 20_000 });
  }
  async read<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.limiter.run(fn); }
      catch (error) {
        const status = (error as { response?: { status?: number }; status?: number }).response?.status ?? (error as { status?: number }).status;
        if (attempt >= 3 || (status !== 429 && status !== 503)) throw error;
        const delay = 1500 * 2 ** attempt;
        this.report(`Toncenter HTTP ${status}: retry ${attempt + 1}/3 in ${delay / 1000}s…`);
        await Bun.sleep(delay);
      }
    }
  }
  // Submission shares the rate limiter but is never retried.
  sendFile(boc: Buffer) { return this.limiter.run(() => this.client.sendFile(boc)); }
  state(address: Address) { return this.read(() => this.client.getContractState(address)); }
  async collection(address: Address, admin: Address) {
    const state = await this.state(address);
    if (state.state === 'frozen') throw new Error('Collection is frozen; manual recovery is required');
    if (state.state !== 'active') return { deployed: false, nextIndex: 0n };
    if (!state.code || !Cell.fromBoc(state.code)[0]!.equals(COLLECTION_CODE) || !state.data) throw new Error('Unexpected collection code/data');
    const data = Cell.fromBoc(state.data)[0]!;
    const s = data.beginParse();
    const actualAdmin = s.loadAddress();
    const nextIndex = s.loadUintBig(64);
    if (!actualAdmin.equals(admin)) throw new Error('Derived wallet is not the current collection admin');
    if (!data.equals(collectionData(admin, nextIndex))) throw new Error('On-chain collection configuration differs from the pinned deployment');
    return { deployed: true, nextIndex };
  }
  async nft(address: Address, collection: Address, index: number): Promise<{ status: NftStatus; owner?: Address; content?: string }> {
    const state = await this.state(address);
    if (state.state === 'frozen') throw new Error(`NFT #${index} is frozen; cannot label it as burned or mint it`);
    if (state.state === 'active') {
      if (!state.code || !Cell.fromBoc(state.code)[0]!.equals(ITEM_CODE) || !state.data) throw new Error(`NFT #${index}: unexpected code/data`);
      return { status: 'deployed', ...parseItem(Cell.fromBoc(state.data)[0]!, collection, index) };
    }
    const status = await this.absentStatus(address, state.lastTransaction?.lt);
    return { status };
  }
  async nftForTransfer(address: Address) {
    const state = await this.state(address);
    if (state.state !== 'active' || !state.code) throw new Error('NFT is not active (not deployed, burned or frozen)');
    const { stack } = await this.read(() => this.client.runMethod(address, 'get_nft_data'));
    if (!stack.readBoolean()) throw new Error('NFT is not initialized');
    const index = stack.readBigNumber();
    const collection = stack.readAddressOpt();
    const owner = stack.readAddress();
    const content = stack.readCell();
    if (collection) {
      const result = await this.read(() => this.client.runMethod(collection, 'get_nft_address_by_index', [{ type: 'int', value: index }]));
      if (!result.stack.readAddress().equals(address)) throw new Error('NFT address is not recognized by its claimed collection');
    }
    return { index, collection, owner, content, code: Cell.fromBoc(state.code)[0]! };
  }
  async absentStatus(address: Address, latestLt?: string): Promise<'burned' | 'non-existent'> {
    // Account state alone loses the distinction after destruction. Walk indexed history,
    // including dust/top-ups after a burn, until the most recent active incarnation.
    let endLt: bigint | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${this.base}/api/v3/transactions`);
      url.searchParams.set('account', address.toRawString());
      url.searchParams.set('limit', '100');
      url.searchParams.set('sort', 'desc');
      if (endLt !== undefined) url.searchParams.set('end_lt', String(endLt));
      const result = await this.read(async () => {
        const response = await fetch(url, { headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {}, signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw Object.assign(new Error(`Toncenter history: HTTP ${response.status}`), { status: response.status });
        return await response.json() as { transactions?: HistoryTransaction[] };
      });
      const txs = result.transactions;
      if (!Array.isArray(txs)) throw new Error('Toncenter returned invalid transaction history');
      if (page === 0 && latestLt && BigInt(latestLt) > 0n && (!txs[0] || BigInt(txs[0].lt) < BigInt(latestLt))) throw new Error('Transaction index is behind account state; retry info shortly');
      for (const tx of txs) {
        if (!Address.parse(tx.account).equals(address) || !/^\d+$/.test(tx.lt) || !tx.description) throw new Error('Invalid history entry');
        if (isBurn(tx)) return 'burned';
        if (tx.orig_status === 'active' || tx.end_status === 'active') {
          if (tx.end_status === 'active') throw new Error('Account state and transaction history disagree; retry shortly');
          return 'non-existent'; // e.g. storage deletion is not an owner-authorized burn.
        }
      }
      if (txs.length < 100) return 'non-existent';
      const next = BigInt(txs.at(-1)!.lt) - 1n;
      if (endLt !== undefined && next >= endLt) throw new Error('History pagination did not advance');
      endLt = next;
    }
    throw new Error('History scan limit reached; refusing to guess NFT status');
  }
}
