import { requestsPerSecond } from './requests';
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import type { Network } from './network';

export function parseEnvironment(env: Record<string, string | undefined>) {
  const version = env.WALLET_VERSION?.trim().toLowerCase();
  if (version !== 'v4r2' && version !== 'w5') throw new Error('Set WALLET_VERSION to v4r2 or w5 in .env');
  const network = env.TON_NETWORK?.trim() || 'mainnet';
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('TON_NETWORK must be mainnet or testnet');
  const apiKey = env.TONCENTER_API_KEY?.trim() || undefined;
  const rps = requestsPerSecond(env.TONCENTER_RPS, Boolean(apiKey));
  return { version, network, apiKey, rps } as const;
}
export function walletFor(publicKey: Buffer, version: 'v4r2' | 'w5', network: Network) {
  return version === 'v4r2' ? WalletContractV4.create({ workchain: 0, publicKey }) : WalletContractV5R1.create({
    publicKey,
    walletId: { networkGlobalId: network === 'mainnet' ? -239 : -3, context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 } },
  });
}
export async function loadWallet(env: Record<string, string | undefined>) {
  const config = parseEnvironment(env);
  const words = env.SEED_PHRASE?.trim().split(/\s+/) ?? [];
  if (!words.length || !await mnemonicValidate(words)) throw new Error('SEED_PHRASE must contain a valid TON mnemonic');
  const keys = await mnemonicToPrivateKey(words);
  return { ...config, wallet: walletFor(keys.publicKey, config.version, config.network), keys };
}
