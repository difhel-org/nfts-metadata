import { describe, test, expect } from 'bun:test';
import { Address, beginCell, Cell, internal, SendMode, toNano } from '@ton/core';
import type { Contract, ContractProvider, Sender, StateInit, Transaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { keyPairFromSeed } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { BURN_ADDRESS, collectionFor, COLLECTION_URL, ITEM_PREFIX, itemFor, mintBody, mintValue, parseItem, snake, nftTransferBody, NFT_TRANSFER_VALUE } from '../scripts/contracts';
import { walletFor } from '../scripts/wallet';
import { isBurn } from '../scripts/network';
import type { HistoryTransaction } from '../scripts/network';

class ContractHandle implements Contract {
  constructor(readonly address: Address, readonly init?: StateInit) {}
  async send(provider: ContractProvider, via: Sender, body: Cell, value = toNano('0.2')) {
    await provider.internal(via, { body, value, bounce: false });
  }
  async getCollection(provider: ContractProvider) {
    const { stack } = await provider.get('get_collection_data', []);
    return { nextIndex: stack.readBigNumber(), metadata: stack.readCell(), admin: stack.readAddress() };
  }
  async getRoyalties(provider: ContractProvider) {
    const { stack } = await provider.get('royalty_params', []);
    return { numerator: stack.readNumber(), denominator: stack.readNumber(), recipient: stack.readAddress() };
  }
  async getItemAddress(provider: ContractProvider, index: number) {
    return (await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }])).stack.readAddress();
  }
  async getItem(provider: ContractProvider) {
    const { stack } = await provider.get('get_nft_data', []);
    return { initialized: stack.readBoolean(), index: stack.readNumber(), collection: stack.readAddress(), owner: stack.readAddress(), content: stack.readCell().beginParse().loadStringTail() };
  }
  async getContent(provider: ContractProvider, index: number) {
    return (await provider.get('get_nft_content', [{ type: 'int', value: BigInt(index) }, { type: 'cell', cell: snake(`${index}.json`) }])).stack.readCell();
  }
}
function burnBody(response: Address | null = null, owner = BURN_ADDRESS) {
  return beginCell().storeUint(0x5fcc3d14, 32).storeUint(123, 64).storeAddress(owner)
    .storeAddress(response).storeMaybeRef(null).storeCoins(0).storeBit(0).endCell();
}
async function setup() {
  const chain = await Blockchain.create();
  const admin = await chain.treasury('admin');
  const other = await chain.treasury('other');
  const config = collectionFor(admin.address);
  const collection = chain.openContract(new ContractHandle(config.address, config.init));
  const item = (index: number) => chain.openContract(new ContractHandle(itemFor(config.address, index).address));
  return { chain, admin, other, collection, item, config };
}
function indexed(tx: Transaction): HistoryTransaction {
  const d = tx.description;
  return {
    account: new Address(0, Buffer.from(tx.address.toString(16).padStart(64, '0'), 'hex')).toRawString(), lt: String(tx.lt),
    orig_status: tx.oldStatus === 'non-existing' ? 'nonexist' : tx.oldStatus, end_status: tx.endStatus === 'non-existing' ? 'nonexist' : tx.endStatus,
    description: d.type === 'generic' ? { aborted: d.aborted, destroyed: d.destroyed,
      compute_ph: { success: d.computePhase.type === 'vm' && d.computePhase.success }, action: { success: d.actionPhase?.success } } : {},
    in_msg: tx.inMessage?.info.type === 'internal' ? { bounced: tx.inMessage.info.bounced, message_content: { body: tx.inMessage.body.toBoc().toString('base64') } } : null,
  };
}

describe('pinned nft-v1.1 contracts in TVM', () => {
  test('first mint deploys collection and NFT, getters decode the exact raw URLs', async () => {
    const { collection, admin, item, config, chain } = await setup();
    await collection.send(admin.getSender(), mintBody([0], admin.address, 1n), mintValue(1, true));
    const data = await collection.getCollection();
    expect(data.nextIndex).toBe(1n);
    expect(data.admin.equals(admin.address)).toBe(true);
    const royalties = await collection.getRoyalties();
    expect(royalties.numerator).toBe(100);
    expect(royalties.denominator).toBe(1000);
    expect(royalties.recipient.equals(admin.address)).toBe(true);
    const metadata = data.metadata.beginParse();
    expect(metadata.loadUint(8)).toBe(1);
    expect(metadata.loadStringTail()).toBe(COLLECTION_URL);
    expect((await collection.getItemAddress(0)).equals(itemFor(config.address, 0).address)).toBe(true);
    const nft = await item(0).getItem();
    expect(nft.initialized).toBe(true);
    expect(nft.index).toBe(0);
    expect(nft.owner.equals(admin.address)).toBe(true);
    expect(nft.content).toBe('0.json');
    const full = (await collection.getContent(0)).beginParse();
    expect(full.loadUint(8)).toBe(1);
    expect(full.loadStringTail()).toBe(`${ITEM_PREFIX}0.json`);
    const account = (await chain.getContract(item(0).address)).accountState;
    if (account?.type !== 'active' || !account.state.data) throw new Error('Missing item state');
    expect(parseItem(account.state.data, config.address, 0).owner.equals(admin.address)).toBe(true);
  });
  test('all 20 NFTs can deploy in one batch', async () => {
    const { collection, admin, item } = await setup();
    const indices = Array.from({ length: 20 }, (_, i) => i);
    await collection.send(admin.getSender(), mintBody(indices, admin.address, 2n), mintValue(20, true));
    expect((await collection.getCollection()).nextIndex).toBe(20n);
    for (const index of indices) {
      const nft = await item(index).getItem();
      expect(nft.owner.equals(admin.address)).toBe(true);
      expect(nft.content).toBe(`${index}.json`);
    }
  });
  test('burn destroys, refunds owner, and re-mint restores same address without incrementing nextIndex', async () => {
    const { collection, admin, other, item, chain } = await setup();
    await collection.send(admin.getSender(), mintBody([0], admin.address, 3n), mintValue(1, true));
    const address = item(0).address;
    const result = await item(0).send(admin.getSender(), burnBody(other.address), toNano('0.1'));
    const destruction = result.transactions.find(tx => isBurn(indexed(tx)));
    expect(destruction).toBeDefined();
    expect((await chain.getContract(address)).accountState?.type).not.toBe('active');
    expect([...destruction!.outMessages.values()].some(msg => msg.info.type === 'internal' && msg.info.dest.equals(admin.address))).toBe(true);
    expect([...destruction!.outMessages.values()].some(msg => msg.info.type === 'internal' && msg.info.dest.equals(other.address))).toBe(false);
    await collection.send(admin.getSender(), mintBody([0], admin.address, 4n), mintValue(1, false));
    expect((await collection.getCollection()).nextIndex).toBe(1n);
    expect((await item(0).getItem()).owner.equals(admin.address)).toBe(true);
    expect((await collection.getItemAddress(0)).equals(address)).toBe(true);
  });
  test('unauthorized burn and collection mint fail; live NFT cannot be overwritten', async () => {
    const { collection, admin, other, item } = await setup();
    await collection.send(admin.getSender(), mintBody([0], admin.address, 5n), mintValue(1, true));
    const burn = await item(0).send(other.getSender(), burnBody());
    expect(burn.transactions.some(tx => isBurn(indexed(tx)))).toBe(false);
    expect((await item(0).getItem()).owner.equals(admin.address)).toBe(true);
    await collection.send(other.getSender(), mintBody([1], other.address, 6n));
    expect((await collection.getCollection()).nextIndex).toBe(1n);
    await collection.send(admin.getSender(), mintBody([0], other.address, 7n));
    expect((await item(0).getItem()).owner.equals(admin.address)).toBe(true);
  });
  test('mixed re-mint and new mint; nonconsecutive new indices are rejected', async () => {
    const { collection, admin, item } = await setup();
    await collection.send(admin.getSender(), mintBody([0, 1], admin.address, 8n), mintValue(2, true));
    await item(0).send(admin.getSender(), burnBody());
    await collection.send(admin.getSender(), mintBody([0, 2], admin.address, 9n), mintValue(2, false));
    expect((await collection.getCollection()).nextIndex).toBe(3n);
    expect((await item(0).getItem()).initialized).toBe(true);
    expect((await item(2).getItem()).initialized).toBe(true);
    await collection.send(admin.getSender(), mintBody([4], admin.address, 10n));
    expect((await collection.getCollection()).nextIndex).toBe(3n);
  });
  for (const version of ['v4r2', 'w5'] as const) {
    for (const network of ['mainnet', 'testnet'] as const) {
      test(`${version} / ${network}: signed wallet messages deploy and transfer NFT`, async () => {
        const chain = await Blockchain.create();
        const funder = await chain.treasury('funder');
        const keys = keyPairFromSeed(Buffer.alloc(32, 42)); // Public test fixture, never a live wallet.
        const wallet = walletFor(keys.publicKey, version, network);
        const opened = chain.openContract(wallet);
        // Fund an uninitialized wallet. Its first signed external message includes StateInit.
        await funder.send({ to: wallet.address, value: toNano('2'), bounce: false });
        const config = collectionFor(wallet.address);
        const args = { seqno: 0, secretKey: keys.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
          messages: [internal({ to: config.address, init: config.init, bounce: false, value: mintValue(1, true), body: mintBody([0], wallet.address, 11n) })] };
        const body = wallet instanceof WalletContractV4 ? await wallet.createTransfer(args) : await wallet.createTransfer(args);
        await opened.send(body);
        expect(await opened.getSeqno()).toBe(1);
        const nft = chain.openContract(new ContractHandle(itemFor(config.address, 0).address));
        expect((await nft.getItem()).owner.equals(wallet.address)).toBe(true);
        const transferArgs = { seqno: 1, secretKey: keys.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
          messages: [internal({ to: nft.address, bounce: true, value: NFT_TRANSFER_VALUE, body: nftTransferBody(funder.address, wallet.address, 12n) })] };
        const transferBody = wallet instanceof WalletContractV4 ? await wallet.createTransfer(transferArgs) : await wallet.createTransfer(transferArgs);
        const sent = await opened.send(transferBody);
        expect(await opened.getSeqno()).toBe(2);
        expect((await nft.getItem()).owner.equals(funder.address)).toBe(true);
        expect((await nft.getItem()).content).toBe('0.json');
        const messages = sent.transactions.flatMap(tx => [...tx.outMessages.values()]);
        expect(messages.some(msg => msg.info.type === 'internal' && msg.info.dest.equals(funder.address) && msg.info.value.coins === 1n && msg.body.beginParse().preloadUint(32) === 0x05138d91)).toBe(true);
        expect(messages.some(msg => msg.info.type === 'internal' && msg.info.dest.equals(wallet.address) && msg.body.bits.length >= 32 && msg.body.beginParse().preloadUint(32) === 0xd53276db)).toBe(true);

      });
    }
  }
});
