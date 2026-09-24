import { test, expect, spyOn } from 'bun:test';
import { mnemonicNew } from '@ton/crypto';
import { TonClient } from '@ton/ton';
import { toNano } from '@ton/core';
import { main } from '../scripts/cli';
import { Chain } from '../scripts/network';

for (const version of ['v4r2', 'w5']) for (const network of ['mainnet', 'testnet']) {
  test(`${version} / ${network}: cancelling a fully prepared mint never submits a transaction`, async () => {
    // Ephemeral test seed; never persisted or printed, and every network call is mocked.
    const phrase = (await mnemonicNew()).join(' ');
    const collection = spyOn(Chain.prototype, 'collection').mockResolvedValue({ deployed: false, nextIndex: 0n });
    const nft = spyOn(Chain.prototype, 'nft').mockResolvedValue({ status: 'non-existent' });
    const state = spyOn(Chain.prototype, 'state').mockResolvedValue({ state: 'uninitialized', balance: toNano('10'), code: null, data: null,
      lastTransaction: null, extra_currencies: undefined, blockId: { workchain: 0, shard: '', seqno: 1 }, timestampt: 0 });
    const open = spyOn(TonClient.prototype, 'open').mockReturnValue({ getSeqno: async () => 0 } as never);
    const send = spyOn(TonClient.prototype, 'sendFile').mockImplementation(async () => { throw new Error('Unexpected submission'); });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const table = spyOn(console, 'table').mockImplementation(() => {});
    let asked = false;
    try {
      await main(['mint', '0', '0'], { SEED_PHRASE: phrase, WALLET_VERSION: version, TON_NETWORK: network }, async () => {
        asked = true;
        const walletPrefix = network === 'mainnet' ? 'UQ' : '0Q';
        const contractPrefix = network === 'mainnet' ? 'EQ' : 'kQ';
        const lines = log.mock.calls.flat().map(String);
        expect(lines.find(line => line.startsWith('Wallet ('))).toContain(`NFT owner: ${walletPrefix}`);
        expect(lines.find(line => line.startsWith('\nFrom:'))).toContain(`From: ${walletPrefix}`);
        expect(lines.find(line => line.startsWith('Owner of every'))).toContain(`NFT: ${walletPrefix}`);
        expect(lines.filter(line => line.startsWith('Collection:')).every(line => line.includes(contractPrefix))).toBe(true);
        for (const call of table.mock.calls) {
          for (const row of call[0] as { Address: string }[]) expect(row.Address.startsWith(contractPrefix)).toBe(true);
        }
        expect(table.mock.calls.at(-1)?.[0]).toMatchObject([{ Name: 'Genesis Persik #0', Action: 'mint' }]);
        return false;
      });
      expect(asked).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(' ')).toContain('Cancelled.');
    } finally {
      for (const mock of [collection, nft, state, open, send, log, table]) mock.mockRestore();
    }
  });
}
