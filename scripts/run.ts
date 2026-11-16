// Run one FoldClaim step on a real network:
//   node --experimental-transform-types --no-warnings scripts/run.ts <mainnet|chipnet> <step> [epoch] [recipients]
// steps: status | registry | propose <epoch> | token | pool | activate <epoch> | sync <epoch> | claim <epoch> <0,1,2|all>
// The operator key and the demo seed are read from secrets/ and never printed. State lives in deployments/<network>/.
import { readFileSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import * as steps from '../src/steps.ts';
import { DEMO_INDEXES } from '../src/demo-tree.ts';

const [network, step, epochArg, whichArg] = process.argv.slice(2);
if (network !== 'mainnet' && network !== 'chipnet') throw new Error('network must be mainnet or chipnet');
const secret = (name: string) => readFileSync(new URL(`../secrets/${name}`, import.meta.url), 'utf8').trim();
const provider = new ElectrumNetworkProvider(network);
const operator = new Signer(secret(`${network}-operator.wif`), provider);
const ctx = {
  provider, operator,
  dir: new URL(`../deployments/${network}/`, import.meta.url).pathname,
  seed: hexToBin(secret('demo-recipients.seed')),
};
const epoch = Number(epochArg ?? 1);
const which = !whichArg || whichArg === 'all' ? DEMO_INDEXES.map((_, d) => d) : whichArg.split(',').map(Number);

const run: Record<string, () => Promise<unknown>> = {
  status: () => steps.status(ctx),
  registry: () => steps.deployRegistry(ctx),
  propose: () => steps.propose(ctx, epoch),
  token: () => steps.mintToken(ctx),
  pool: () => steps.deployPool(ctx),
  activate: () => steps.activate(ctx, epoch),
  sync: () => steps.sync(ctx, epoch),
  claim: () => steps.claim(ctx, epoch, which),
};
if (!run[step]) throw new Error(`unknown step ${step}`);
try {
  await run[step]();
  process.exit(0);
} catch (e: any) {
  console.error(`${step} failed: ${e?.message ?? e}`);
  process.exit(1);
}
