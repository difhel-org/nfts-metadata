import { Address, Cell, beginCell, external, fromNano, internal, SendMode, storeMessage } from '@ton/core';
import { WalletContractV4 } from '@ton/ton';
import { randomBytes } from 'node:crypto';
import { loadCatalog } from './catalog';
import { BURN_ADDRESS, collectionFor, itemFor, nftTransferBody, NFT_TRANSFER_VALUE, WALLET_FEE_BUFFER } from './contracts';
import { Chain } from './network';
import type { Network } from './network';
import { ProgressLine } from './progress';
import { loadWallet, parseEnvironment } from './wallet';

export function parseSendArguments(args: string[]) {
  if (args.length !== 2) throw new Error('Usage: bun run send <index|nft address> <recipient address>');
  const [target, recipient] = args as [string, string];
  const index = /^(0|[1-9]\d*)$/.test(target) ? Number(target) : undefined;
  if (index !== undefined && !Number.isSafeInteger(index)) throw new Error('NFT index must be a safe non-negative integer');
  let nftAddress: Address | undefined;
  try { if (index === undefined) nftAddress = Address.parse(target); }
  catch { throw new Error('Invalid NFT index or address'); }
  let recipientAddress: Address;
  try { recipientAddress = Address.parse(recipient); }
  catch { throw new Error('Invalid recipient address; provide a raw or friendly TON address'); }
  if (recipientAddress.workChain !== 0) throw new Error('Recipient must be in workchain 0');
  if (recipientAddress.equals(BURN_ADDRESS)) throw new Error('The zero address burns this NFT. Use an explicit burn operation instead of send');
  return { target, index, nftAddress, recipient, recipientAddress };
}
export function checkAddressNetwork(value: string, network: Network) {
  if (Address.isFriendly(value) && Address.parseFriendly(value).isTestOnly && network === 'mainnet') throw new Error('A testnet-only address cannot be used on mainnet');
}

export async function sendCommand(args: string[], env: Record<string, string | undefined>, confirmation: () => Promise<boolean>, wait: (ms: number) => Promise<unknown> = Bun.sleep) {
  const parsed = parseSendArguments(args);
  const config = parseEnvironment(env);
  checkAddressNetwork(parsed.recipient, config.network);
  if (parsed.nftAddress) checkAddressNetwork(parsed.target, config.network);
  const catalog = await loadCatalog();
  const record = parsed.index === undefined ? undefined : catalog.items.find(item => item.index === parsed.index);
  if (parsed.index !== undefined && !record) throw new Error(`No JSON manifest for NFT #${parsed.index}`);
  const { wallet, keys, network, apiKey, rps, version } = await loadWallet(env);
  const progress = new ProgressLine();
  const log = (message: string) => { progress.clear(); console.log(message); };
  const friendly = (address: Address, bounceable: boolean) => address.toString({ bounceable, urlSafe: true, testOnly: network === 'testnet' });
  try {
    const chain = new Chain(network, apiKey, message => progress.update(message), rps);
    const localCollection = collectionFor(wallet.address).address;
    const nftAddress = parsed.nftAddress ?? itemFor(localCollection, parsed.index!).address;
    const recipient = parsed.recipientAddress;
    progress.update('Fetching NFT and wallet…');
    const nft = await chain.nftForTransfer(nftAddress);
    if (parsed.index !== undefined && (nft.index !== BigInt(parsed.index) || !nft.collection?.equals(localCollection))) throw new Error('NFT does not match the requested collection/index');
    if (!nft.owner.equals(wallet.address)) throw new Error(`Wallet does not own this NFT. Current owner: ${friendly(nft.owner, false)}`);
    if (recipient.equals(nft.owner)) { log('Recipient already owns this NFT. Nothing to send.'); return; }
    const name = record?.name ?? (nft.collection?.equals(localCollection) ? catalog.items.find(item => BigInt(item.index) === nft.index)?.name : undefined) ?? `NFT #${nft.index}`;

    const inspectWallet = async () => {
      const state = await chain.state(wallet.address);
      if (state.state === 'frozen') throw new Error('Wallet is frozen');
      if (state.state === 'active' && (!state.code || !Cell.fromBoc(state.code)[0]!.equals(wallet.init.code))) throw new Error('Wallet code does not match WALLET_VERSION');
      if (state.balance < NFT_TRANSFER_VALUE + WALLET_FEE_BUFFER) throw new Error(`Insufficient balance: need ${fromNano(NFT_TRANSFER_VALUE + WALLET_FEE_BUFFER)} TON including fee buffer`);
      if (version === 'w5' && state.state === 'active') {
        const { stack } = await chain.read(() => chain.client.runMethod(wallet.address, 'is_signature_allowed'));
        if (!stack.readBoolean()) throw new Error('W5 signature authentication is disabled');
      }
      const seqno = state.state === 'active' ? (await chain.read(() => chain.client.runMethod(wallet.address, 'seqno'))).stack.readNumber() : 0;
      return { state, seqno };
    };
    const initialWallet = await inspectWallet();
    const recipientDisplay = Address.isFriendly(parsed.recipient)
      ? friendly(recipient, Address.parseFriendly(parsed.recipient).isBounceable)
      : recipient.toRawString();
    log(`Network: ${network}`);
    log(`From (${version}): ${friendly(wallet.address, false)}`);
    log(`NFT: ${name} | ${friendly(nftAddress, true)}`);
    log(`Collection: ${nft.collection ? friendly(nft.collection, true) : 'standalone NFT'}`);
    log(`Recipient: ${recipientDisplay}`);
    log(`Attach: ${fromNano(NFT_TRANSFER_VALUE)} TON to the NFT, plus wallet network fees.`);
    log('Recipient notification: 1 nanoton. Excess TON returns to the sending wallet.');
    log(`Wallet balance: ${fromNano(initialWallet.state.balance)} TON. Fee buffer: ${fromNano(WALLET_FEE_BUFFER)} TON.`);
    if (!await confirmation()) { log('Cancelled.'); return; }

    progress.update('Rechecking ownership and wallet…');
    const fresh = await chain.nftForTransfer(nftAddress);
    if (!fresh.owner.equals(wallet.address) || fresh.index !== nft.index || fresh.collection?.toRawString() !== nft.collection?.toRawString() || !fresh.code.equals(nft.code) || !fresh.content.equals(nft.content)) throw new Error('NFT changed while waiting. Run send again to review a fresh plan');
    const freshWallet = await inspectWallet();
    if (freshWallet.seqno !== initialWallet.seqno || freshWallet.state.state !== initialWallet.state.state) throw new Error('Wallet changed while waiting. Run send again');
    const queryId = randomBytes(8).readBigUInt64BE();
    const transferArgs = {
      seqno: freshWallet.seqno, secretKey: keys.secretKey, timeout: Math.floor(Date.now() / 1000) + 180,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: [internal({ to: nftAddress, value: NFT_TRANSFER_VALUE, bounce: true, body: nftTransferBody(recipient, wallet.address, queryId) })],
    };
    const body = wallet instanceof WalletContractV4 ? await wallet.createTransfer(transferArgs) : await wallet.createTransfer(transferArgs);
    const message = beginCell().store(storeMessage(external({ to: wallet.address, init: freshWallet.state.state === 'active' ? undefined : wallet.init, body }))).endCell();
    log(`Sending wallet seqno ${freshWallet.seqno}, query ID ${queryId}, message hash ${message.hash().toString('hex')}…`);
    try { await chain.sendFile(message.toBoc()); }
    catch { throw new Error('Submission result is unknown. Check NFT ownership and wallet transactions before retrying; the message may still execute for 180 seconds'); }

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      progress.update('Waiting for the NFT owner to change…');
      await wait(5000);
      let current: Awaited<ReturnType<Chain['nftForTransfer']>>;
      try { current = await chain.nftForTransfer(nftAddress); }
      catch { throw new Error('Message submitted, but ownership verification failed. Inspect NFT and wallet transactions before retrying'); }
      if (current.index !== nft.index || current.collection?.toRawString() !== nft.collection?.toRawString() || !current.code.equals(nft.code) || !current.content.equals(nft.content)) throw new Error('NFT identity or content changed after submission. Inspect transactions');
      if (current.owner.equals(recipient)) {
        log(`✅ ${name} transferred to ${recipientDisplay}`);
        return;
      }
      if (!current.owner.equals(wallet.address)) throw new Error('NFT owner changed to a different address after submission. Inspect transactions before retrying');
    }
    throw new Error('Transfer confirmation timed out. Check NFT ownership and wallet transactions before retrying');
  } finally {
    progress.clear();
    keys.secretKey.fill(0);
  }
}
