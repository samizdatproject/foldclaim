// Write deployments/<network>/public.json: the public values a claimant or watcher needs (operator public key,
// demo recipient addresses). Reads the secrets, prints and writes only public data.
import { readFileSync, writeFileSync } from 'node:fs';
import { binToHex, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { demoLock, DEMO_INDEXES } from '../src/demo-tree.ts';
const network = process.argv[2] ?? 'mainnet';
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const secret = (n: string) => readFileSync(new URL(`../secrets/${n}`, import.meta.url), 'utf8').trim();
const operator = new Signer(secret(`${network}-operator.wif`), new MockNetworkProvider());
const seed = hexToBin(secret('demo-recipients.seed'));
const addr = (lock: Uint8Array, tokenSupport: boolean) => {
  const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix, tokenSupport } as any);
  return typeof r === 'string' ? r : (r as any).address;
};
const info = {
  network,
  operatorPublicKey: binToHex(operator.publicKey),
  operatorAddress: operator.getAddress(network as any),
  demoRecipients: DEMO_INDEXES.map((index, d) => ({ demo: d, leafIndex: index, address: addr(demoLock(seed, d), true), cashAddress: addr(demoLock(seed, d), false) })),
};
writeFileSync(new URL(`../deployments/${network}/public.json`, import.meta.url), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info, null, 2));
