/* eslint-disable @typescript-eslint/no-explicit-any */
// Dress rehearsal of the mainnet run: the exact steps of scripts/run.ts on the production-limit mock, starting
// from one 200,000-sat coin at output 0, as the real operator address holds. Writes the cost of each step to
// reports/rehearsal.json.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import * as steps from '../src/steps.ts';
import { DEMO_INDEXES, demoLock } from '../src/demo-tree.ts';

const BUDGET = 200_000n;

describe('mainnet rehearsal', () => {
  it('runs every step from a single 200,000-sat coin and stays within budget', async () => {
    const provider = new MockNetworkProvider({ profile: 'production' });
    const operator = new Signer(binToHex(randomBytes(32)), provider) as any;
    await provider.seedUtxo(operator.getAddress(), { txid: binToHex(randomBytes(32)), vout: 0, satoshis: BUDGET } as any);
    const seed = randomBytes(32);
    const lines: string[] = [];
    const ctx = { provider, operator, dir: mkdtempSync(join(tmpdir(), 'foldclaim-')), seed, log: (l: string) => lines.push(l) };

    const waits: number[] = [];
    const activateWhenReady = async (epoch: number) => {
      for (let extra = 0; ; extra++) {
        try { await steps.activate(ctx, epoch); waits.push(steps.ROOT_DELAY + extra); return; } catch (e: any) {
          lines.push(`activate${epoch} +${extra}: ${String(e?.message ?? e).slice(0, 160)}`);
          if (extra >= 30) throw e;
          await provider.mine(1);
        }
      }
    };
    await steps.deployRegistry(ctx);
    await steps.propose(ctx, 1);
    await steps.mintToken(ctx);
    await steps.deployPool(ctx);
    await expect(steps.activate(ctx, 1)).rejects.toThrow();
    await provider.mine(steps.ROOT_DELAY);
    await activateWhenReady(1);
    await steps.sync(ctx, 1);
    await steps.claim(ctx, 1, DEMO_INDEXES.map((_, d) => d));

    // epoch 2: a top-up for two recipients pays only the difference
    await steps.propose(ctx, 2);
    await provider.mine(steps.ROOT_DELAY);
    await activateWhenReady(2);
    await steps.sync(ctx, 2);
    await steps.claim(ctx, 2, [0, 9]);

    const s = await steps.status(ctx);
    const spent = Object.values(s.txs).reduce((n: bigint, t: any) => n + BigInt(t.spent), 0n);
    const tokenOf = async (d: number) => {
      const utxos = await provider.getUtxosForLockingBytecode(demoLock(seed, d));
      return utxos.filter((u: any) => u.token?.category === s.steps.token.category).reduce((n: bigint, u: any) => n + u.token.amount, 0n);
    };
    expect(await tokenOf(0)).toBe(BigInt(s.steps['claim2-0'].cumulative));
    expect(await tokenOf(9)).toBe(BigInt(s.steps['claim2-9'].cumulative));
    expect(await tokenOf(5)).toBe(BigInt(s.steps['claim1-5'].cumulative));
    expect(spent).toBeLessThan(BUDGET);

    mkdirSync(new URL('../reports', import.meta.url), { recursive: true });
    writeFileSync(new URL('../reports/rehearsal.json', import.meta.url), JSON.stringify({ waits, spent: spent.toString(), budget: BUDGET.toString(), txs: s.txs, log: lines }, null, 2) + '\n');
  }, 600_000);
});
