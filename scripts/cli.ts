import { sendCommand } from './send';
import { Address, Cell, beginCell, external, fromNano, internal, SendMode, storeMessage } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadCatalog, parseRange, selectRange, STATUS, validateMintOrder } from './catalog';
import { mapConcurrent } from './requests';
import { ProgressLine } from './progress';
import type { NftRecord } from './catalog';
import { collectionFor, itemFor, mintBody, mintValue, parseItem, ITEM_CODE, WALLET_FEE_BUFFER } from './contracts';
import { Chain } from './network';
import { loadWallet } from './wallet';

export const isConfirmation = (answer: string) => answer.trim().toLowerCase() === 'y';
async function confirm() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return isConfirmation(await rl.question('Confirm? y/n ')); }
  finally { rl.close(); }
}

export async function main(args = process.argv.slice(2), env = process.env, confirmation: () => Promise<boolean> = confirm) {
  const [command, ...rest] = args;
  if (command === 'send') return sendCommand(rest, env, confirmation);
  if (command !== 'info' && command !== 'mint') throw new Error('Usage: bun run info | bun run mint <start index> <stop index> | bun run send <index|nft address> <recipient address>');
  if (command === 'info' && rest.length) throw new Error('Usage: bun run info');
  const range = command === 'mint' ? parseRange(rest) : undefined;
  const catalog = await loadCatalog();
  const selected = range ? selectRange(catalog.items, ...range) : catalog.items;
  const { wallet, keys, network, apiKey, version, rps } = await loadWallet(env);
  const progress = new ProgressLine();
  const log = (message: string) => { progress.clear(); console.log(message); };
  const table = (rows: unknown) => { progress.clear(); console.table(rows); };
  try {
    const walletAddress = wallet.address.toString({ bounceable: false, urlSafe: true, testOnly: network === 'testnet' });
    const friendlyContract = (address: Address) => address.toString({ bounceable: true, urlSafe: true, testOnly: network === 'testnet' });
    const chain = new Chain(network, apiKey, message => progress.update(message), rps);
    const collection = collectionFor(wallet.address);
    const readSeqno = async (active: boolean) => active
      ? (await chain.read(() => chain.client.runMethod(wallet.address, 'seqno'))).stack.readNumber()
      : 0;
    log(`Network: ${network}`);
    log(`Wallet (${version}) / NFT owner: ${walletAddress}`);
    log(`Collection: ${catalog.name} | ${friendlyContract(collection.address)}`);
    progress.update('Fetching collection…');
    const collectionState = await chain.collection(collection.address, wallet.address);
    log(`Collection status: ${collectionState.deployed ? '✅ deployed' : '❌ non-existent'}; next index: ${collectionState.nextIndex}`);
    const inspectNfts = async (items: NftRecord[]) => {
      let completed = 0;
      const started = Date.now();
      const render = () => progress.update(`Fetching ${completed}/${items.length} NFTs | ${rps} req/s | ${((Date.now() - started) / 1000).toFixed(0)}s`);
      render();
      const heartbeat = setInterval(render, 1000);
      try {
        return await mapConcurrent(items, 8, async item => {
          const { address } = itemFor(collection.address, item.index);
          try {
            const { status } = await chain.nft(address, collection.address, item.index);
            completed++;
            render();
            return { ...item, address, status };
          } catch (error) {
            throw new Error(`NFT #${item.index} (${friendlyContract(address)}): ${error instanceof Error ? error.message : 'State check failed'}`);
          }
        });
      } finally {
        clearInterval(heartbeat);
        progress.clear();
      }
    };
    const rows = await inspectNfts(selected);
    table(rows.map(row => ({ Name: row.name, Status: STATUS[row.status], Address: friendlyContract(row.address) })));
    if (command === 'info') return;
    const pending = rows.filter(row => row.status !== 'deployed');
    if (!pending.length) { log('All selected NFTs are already deployed. Nothing to send.'); return; }
    const indices = pending.map(row => row.index);
    validateMintOrder(indices, collectionState.nextIndex);
    if (indices.length >= 250) throw new Error('At most 249 NFTs per call; use a smaller range');
    const value = mintValue(pending.length, !collectionState.deployed);
    const walletState = await chain.state(wallet.address);
    if (walletState.state === 'frozen') throw new Error('Wallet is frozen');
    if (walletState.state === 'active' && (!walletState.code || !Cell.fromBoc(walletState.code)[0]!.equals(wallet.init.code))) throw new Error('Wallet code does not match WALLET_VERSION');
    if (walletState.balance < value + WALLET_FEE_BUFFER) throw new Error(`Insufficient balance: ${fromNano(walletState.balance)} TON; need ${fromNano(value + WALLET_FEE_BUFFER)} TON including fee buffer`);
    if (version === 'w5' && walletState.state === 'active') {
      const { stack } = await chain.read(() => chain.client.runMethod(wallet.address, 'is_signature_allowed'));
      if (!stack.readBoolean()) throw new Error('W5 signature authentication is disabled');
    }
    const seqno = await readSeqno(walletState.state === 'active');
    log(`\nFrom: ${walletAddress}`);
    log(`Owner of every minted NFT: ${walletAddress}`);
    log(`Collection: ${friendlyContract(collection.address)}${collectionState.deployed ? '' : ' (will be deployed)'}`);
    table(pending.map(row => ({ Name: row.name, Action: row.status === 'burned' ? 're-mint' : 'mint', Address: friendlyContract(row.address) })));
    log(`Already deployed and skipped: ${rows.length - pending.length}`);
    log(`Send: ${fromNano(value)} TON to collection, plus wallet network fees.`);
    log(`Wallet balance: ${fromNano(walletState.balance)} TON. Fee buffer: ${fromNano(WALLET_FEE_BUFFER)} TON (not an exact fee estimate).`);
    log('Unspent attached TON stays in the collection and NFTs.');
    if (!await confirmation()) { log('Cancelled.'); return; }

    // Recheck the approved plan after a potentially long human pause. Never silently
    // expand it or sign with a different wallet seqno after confirmation.
    log('Rechecking the approved plan…');
    const freshCollection = await chain.collection(collection.address, wallet.address);
    if (freshCollection.deployed !== collectionState.deployed || freshCollection.nextIndex !== collectionState.nextIndex) throw new Error('Collection changed while waiting. Run mint again to review a fresh plan');
    const refreshed = await inspectNfts(pending);
    for (const [position, row] of pending.entries()) {
      if (refreshed[position]!.status !== row.status) throw new Error(`NFT #${row.index} changed while waiting. Run mint again`);
    }
    const freshWallet = await chain.state(wallet.address);
    if (freshWallet.state !== walletState.state || (freshWallet.code?.toString('base64') ?? '') !== (walletState.code?.toString('base64') ?? '')) throw new Error('Wallet state changed. Run mint again');
    if (freshWallet.balance < value + WALLET_FEE_BUFFER) throw new Error('Wallet balance changed; insufficient funds');
    if (await readSeqno(freshWallet.state === 'active') !== seqno) throw new Error('Wallet seqno changed. Run mint again');
    const queryId = randomBytes(8).readBigUInt64BE();
    const transferArgs = {
      seqno, secretKey: keys.secretKey, timeout: Math.floor(Date.now() / 1000) + 180,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: [internal({
        to: collection.address, value, bounce: collectionState.deployed,
        init: collectionState.deployed ? undefined : collection.init,
        body: mintBody(indices, wallet.address, queryId),
      })],
    };
    const transfer = wallet instanceof WalletContractV4 ? await wallet.createTransfer(transferArgs) : await wallet.createTransfer(transferArgs);
    const message = beginCell().store(storeMessage(external({
      to: wallet.address, init: walletState.state === 'active' ? undefined : wallet.init, body: transfer,
    }))).endCell();
    log(`Sending wallet seqno ${seqno}, query ID ${queryId}, message hash ${message.hash().toString('hex')}…`);
    try {
      // This mutation is deliberately not retried: a network error can follow acceptance.
      await chain.sendFile(message.toBoc());
    } catch {
      throw new Error('Submission result is unknown. Check bun run info and wallet transactions before retrying; the message may still execute for 180 seconds');
    }
    log('Message submitted. Waiting for every NFT to initialize…');
    const unresolved = new Map(pending.map(row => [row.index, row]));
    const deadline = Date.now() + 240_000;
    while (unresolved.size && Date.now() < deadline) {
      await Bun.sleep(5000);
      for (const [index, row] of unresolved) {
        const state = await chain.state(row.address);
        if (state.state !== 'active') continue;
        if (!state.code || !Cell.fromBoc(state.code)[0]!.equals(ITEM_CODE) || !state.data) throw new Error(`NFT #${index} has unexpected on-chain code/data after submission`);
        const actual = parseItem(Cell.fromBoc(state.data)[0]!, collection.address, index);
        if (!actual.owner.equals(wallet.address) || actual.content !== `${index}.json`) throw new Error(`NFT #${index}: owner or metadata differs from the approved plan; inspect transactions`);
        unresolved.delete(index);
        log(`✅ ${row.name} | ${friendlyContract(row.address)}`);
      }
    }
    if (unresolved.size) throw new Error(`Confirmation timed out for indices: ${[...unresolved.keys()].join(', ')}. Submission may be partially complete. Run bun run info before retrying; deployed NFTs will be skipped`);
    log('All requested NFTs are deployed and their owner/metadata are verified.');
  } finally {
    progress.clear();
    keys.secretKey.fill(0);
  }
}
if (import.meta.main) {
  main().catch(error => {
    console.error(`Error: ${error instanceof Error ? error.message : 'Operation failed'}`);
    process.exitCode = 1;
  });
}
