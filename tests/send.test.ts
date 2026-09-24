import { test, expect, spyOn } from 'bun:test';
import { Address, Cell, beginCell, loadMessage, toNano, TupleReader } from '@ton/core';
import { mnemonicNew } from '@ton/crypto';
import { TonClient } from '@ton/ton';
import { sendCommand, parseSendArguments, checkAddressNetwork } from '../scripts/send';
import { main } from '../scripts/cli';
import { Chain } from '../scripts/network';
import { loadWallet } from '../scripts/wallet';
import { BURN_ADDRESS, collectionFor, itemFor, ITEM_CODE, snake } from '../scripts/contracts';

const recipient = new Address(0, Buffer.alloc(32, 33));
test('send validates arguments, recipient workchain/burn address, and network flags', async () => {
  expect(parseSendArguments(['0', recipient.toString()]).index).toBe(0);
  expect(parseSendArguments([recipient.toRawString(), recipient.toString()]).nftAddress?.equals(recipient)).toBe(true);
  for (const args of [[], ['0'], ['0', 'bad'], ['-1', recipient.toString()], ['9007199254740992', recipient.toString()], ['0', BURN_ADDRESS.toString()], ['0', new Address(-1, Buffer.alloc(32, 1)).toString()]]) expect(() => parseSendArguments(args)).toThrow();
  expect(() => checkAddressNetwork(recipient.toString({ testOnly: true }), 'mainnet')).toThrow('testnet-only');
  expect(() => checkAddressNetwork(recipient.toString(), 'testnet')).not.toThrow();
  await expect(main(['send'], {})).rejects.toThrow('Usage');
});

async function fixture(version: 'v4r2' | 'w5' = 'w5') {
  const env = { SEED_PHRASE: (await mnemonicNew()).join(' '), WALLET_VERSION: version };
  const { wallet, keys } = await loadWallet(env);
  keys.secretKey.fill(0);
  const collection = collectionFor(wallet.address).address;
  const address = itemFor(collection, 0).address;
  const nft = { index: 0n, collection, owner: wallet.address, content: snake('0.json'), code: ITEM_CODE };
  const state = { state: 'uninitialized' as 'active' | 'uninitialized' | 'frozen', balance: toNano('10'), code: null as Buffer | null, data: null,
    lastTransaction: null, extra_currencies: undefined, blockId: { workchain: 0, shard: '', seqno: 1 }, timestampt: 0 };
  const read = spyOn(Chain.prototype, 'read').mockImplementation(async fn => fn());
  const getNft = spyOn(Chain.prototype, 'nftForTransfer').mockResolvedValue(nft);
  const walletState = spyOn(Chain.prototype, 'state').mockImplementation(async () => state);
  const send = spyOn(Chain.prototype, 'sendFile').mockResolvedValue(undefined);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  return { env, wallet, address, nft, state, getNft, walletState, send, log,
    restore: () => { for (const mock of [read, getNft, walletState, send, log]) mock.mockRestore(); } };
}
for (const version of ['v4r2', 'w5'] as const) {
  test(`${version}: send by index is cancelled before signing/submission`, async () => {
    const f = await fixture(version);
    try {
      let asked = false;
      await main(['send', '0', recipient.toString({ bounceable: false })], f.env, async () => {
        asked = true;
        expect(f.log.mock.calls.flat().join('\n')).toContain('Genesis Persik #0');
        expect(f.log.mock.calls.flat().join('\n')).toContain(`Recipient: ${recipient.toString({ bounceable: false })}`);
        return false;
      });
      expect(asked).toBe(true);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.getNft.mock.calls[0]![0].equals(f.address)).toBe(true);
    } finally { f.restore(); }
  });
  test(`${version}: send by NFT address submits once and verifies new owner`, async () => {
    const f = await fixture(version);
    try {
      f.getNft.mockResolvedValueOnce(f.nft).mockResolvedValueOnce(f.nft).mockResolvedValueOnce({ ...f.nft, owner: recipient });
      await sendCommand([f.address.toString(), recipient.toRawString()], f.env, async () => true, async () => {});
      expect(f.send).toHaveBeenCalledTimes(1);
      const message = loadMessage(Cell.fromBoc(f.send.mock.calls[0]![0])[0]!.beginParse());
      expect(message.info.type).toBe('external-in');
      if (message.info.type === 'external-in') expect(message.info.dest.equals(f.wallet.address)).toBe(true);
      expect(f.log.mock.calls.flat().join('\n')).toContain('transferred to');
    } finally { f.restore(); }
  });
}
test('send rejects an NFT owned by someone else before confirmation', async () => {
  const f = await fixture();
  try {
    f.getNft.mockResolvedValue({ ...f.nft, owner: recipient });
    let asked = false;
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => { asked = true; return true; })).rejects.toThrow('does not own');
    expect(asked).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.restore(); }
});
test('send aborts if ownership changes during confirmation', async () => {
  const f = await fixture();
  try {
    f.getNft.mockResolvedValueOnce(f.nft).mockResolvedValueOnce({ ...f.nft, owner: recipient });
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => true)).rejects.toThrow('NFT changed');
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.restore(); }
});
test('send checks balance before asking to confirm', async () => {
  const f = await fixture();
  try {
    f.state.balance = 0n;
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => { throw new Error('must not ask'); })).rejects.toThrow('Insufficient balance');
    expect(f.send).not.toHaveBeenCalled();
  } finally { f.restore(); }
});
test('submission failure is reported as uncertain and is not retried', async () => {
  const f = await fixture();
  try {
    f.send.mockRejectedValue(new Error('timeout'));
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => true)).rejects.toThrow('Submission result is unknown');
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally { f.restore(); }
});
test('transfer reader verifies NFT collection membership and rejects inactive accounts', async () => {
  const chain = new Chain('testnet');
  const address = new Address(0, Buffer.alloc(32, 55));
  const collection = new Address(0, Buffer.alloc(32, 44));
  const state = spyOn(chain, 'state').mockResolvedValue({ state: 'active', balance: toNano('1'), code: ITEM_CODE.toBoc(), data: null,
    lastTransaction: null, extra_currencies: undefined, blockId: { workchain: 0, shard: '', seqno: 1 }, timestampt: 0 });
  const read = spyOn(chain, 'read').mockImplementation(async fn => fn());
  const rpc = spyOn(chain.client, 'runMethod').mockImplementation(async (_address, method) => ({ gas_used: 0,
    stack: method === 'get_nft_data' ? new TupleReader([
      { type: 'int', value: -1n }, { type: 'int', value: 0n },
      { type: 'slice', cell: beginCell().storeAddress(collection).endCell() },
      { type: 'slice', cell: beginCell().storeAddress(recipient).endCell() }, { type: 'cell', cell: snake('0.json') },
    ]) : new TupleReader([{ type: 'slice', cell: beginCell().storeAddress(recipient).endCell() }]) }));
  try {
    await expect(chain.nftForTransfer(address)).rejects.toThrow('not recognized');
    state.mockResolvedValueOnce({ ...(await chain.state(address)), state: 'uninitialized' });
    await expect(chain.nftForTransfer(address)).rejects.toThrow('not active');
  } finally { state.mockRestore(); read.mockRestore(); rpc.mockRestore(); }
});

test('send aborts if wallet seqno changes during confirmation', async () => {
  const f = await fixture();
  f.state.state = 'active';
  f.state.code = f.wallet.init.code.toBoc();
  let seqno = 4n;
  const rpc = spyOn(TonClient.prototype, 'runMethod').mockImplementation(async (_address, method) => ({
    gas_used: 0, stack: new TupleReader([{ type: 'int', value: method === 'seqno' ? seqno++ : -1n }]),
  }));
  try {
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => true)).rejects.toThrow('Wallet changed');
    expect(f.send).not.toHaveBeenCalled();
  } finally { rpc.mockRestore(); f.restore(); }
});
test('send rejects W5 with disabled signature authentication', async () => {
  const f = await fixture();
  f.state.state = 'active';
  f.state.code = f.wallet.init.code.toBoc();
  const rpc = spyOn(TonClient.prototype, 'runMethod').mockResolvedValue({ gas_used: 0, stack: new TupleReader([{ type: 'int', value: 0n }]) });
  try {
    await expect(sendCommand(['0', recipient.toString()], f.env, async () => { throw new Error('must not ask'); })).rejects.toThrow('signature authentication is disabled');
    expect(f.send).not.toHaveBeenCalled();
  } finally { rpc.mockRestore(); f.restore(); }
});
