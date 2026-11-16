// A stateful SolidCash function that uses `require(this.age >= N)` compiles to OP_CHECKSEQUENCEVERIFY on the
// contract's master input, so that input must carry nSequence >= N. SolidCash 0.51 always gives stateful inputs
// the default sequence and has no call option to change it. Until it does, run such a call inside
// `withRelativeLock`, which sets the sequence of the master input of the given contract category for that call
// only. Nothing else changes: the transaction is built and signed as usual, and the VM checks the lock.
import { TransactionBuilder } from '@solidcash/solidcash';

type Override = { categoryId: string; sequence: number };
const active: Override[] = [];
const proto = TransactionBuilder.prototype as any;

if (!proto.__foldclaimRelativeLock) {
  const original = proto.buildLibauthTransaction;
  proto.buildLibauthTransaction = function patched(this: any, ...args: unknown[]) {
    if (active.length > 0) {
      for (const input of this.inputs ?? []) {
        const token = input.token;
        if (!token?.nft || token.nft.capability !== 'minting') continue;
        const hit = active.find((o) => o.categoryId.toLowerCase() === String(token.category).toLowerCase());
        if (hit) input.options = { ...(input.options ?? {}), sequence: hit.sequence };
      }
    }
    return original.apply(this, args);
  };
  proto.__foldclaimRelativeLock = true;
}

/** Run `send` with the master input of contract `categoryId` carrying nSequence `blocks` (a block-based lock). */
export async function withRelativeLock<T>(categoryId: string, blocks: number, send: () => Promise<T>): Promise<T> {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 0xffff) throw new Error('blocks must be 1..65535');
  const entry = { categoryId, sequence: blocks };
  active.push(entry);
  try {
    return await send();
  } finally {
    active.splice(active.indexOf(entry), 1);
  }
}
