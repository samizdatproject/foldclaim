// Show the operator's coins on a network: node scripts/balance.mjs [mainnet|chipnet]
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
const network = process.argv[2] ?? 'mainnet';
const address = network === 'mainnet'
  ? 'bitcoincash:qz0td56ndjs8snhmmzyp5g4a4vudmvl7vuxr2vsdyd'
  : 'bchtest:qqsz4e0f20turad80afl895nf8mgvhkmjy3ddthg6z';
const provider = new ElectrumNetworkProvider(network);
const [height, utxos] = await Promise.all([provider.getBlockHeight(), provider.getUtxos(address)]);
console.log(`${network} height ${height}  ${address}`);
for (const u of utxos) console.log(` ${u.txid}:${u.vout}  ${u.satoshis} sats${u.token ? `  token ${u.token.category} ${u.token.amount}${u.token.nft ? ' nft ' + u.token.nft.capability : ''}` : ''}`);
console.log(`total ${utxos.reduce((s, u) => s + BigInt(u.satoshis), 0n)} sats in ${utxos.length} coin(s)`);
process.exit(0);
