# FoldClaim

**Pull-based CashToken reward claims for Bitcoin Cash, written in SolidCash.**

FoldingCash pays Folding@home contributors in FLDCH tokens by pushing one output per user per distribution.
The operator's cost grows with users × distributions, and for small earners the dust is worth more than the
reward. FoldClaim turns this around:

- The operator publishes one Merkle root per epoch: about 11,000 sats, whatever the number of users.
- Each user claims whenever they like, as rarely as they like, and pays only their own fee.
- Users never need a receipt NFT in their wallet.

It is live on **BCH mainnet** with a test token: real contracts, a real 144-block audit window and real claims.

## How it works

```
 F@H daily summary ──► leaves (address, cumulative earned) ──► Merkle root
                                                                   │ proposeRoot (operator key)
                                                                   ▼
                      RootRegistry ── 144-block audit window ── activateRoot (anyone)
                                                                   │ syncRoot (anyone; reads the registry)
                                                                   ▼
 user / relayer ──► claim(proof) ──► FoldClaimPool ──► tokens to the leaf's own address
                                         └─ claimed[address] = cumulative   (verified mapping = receipt)
```

- **Leaf** = `sha256(0x00 ‖ lockingBytecode ‖ uint64le(cumulative))`, **node** = `sha256(0x01 ‖ left ‖ right)`.
  - The index bits choose left or right.
  - Odd levels are padded with 32 zero bytes, which have no known preimage, so no padding slot can be claimed.
  - The 0x00/0x01 prefixes stop a leaf from being passed off as a node.
- **Cumulative-only roots.** A leaf holds the total a recipient has earned so far, never a per-epoch amount, so:
  - a claim pays `cumulative − claimed[recipient]`;
  - skipping epochs costs nothing;
  - nothing ever expires.
- **Receipt** = one verified-mapping entry per recipient inside the pool's own token category. A repeat claim
  is refused on-chain (`nothing to claim`). Users hold no receipt NFT and can lose nothing by having one.
- **Payout binding.** Tokens always go to the leaf's locking bytecode, which is part of the leaf hash. Anyone can
  submit a claim and pay its fee, whether that is the user, a relayer or the operator, but nobody can redirect
  the payout.
- **Root timelock.** `RootRegistry.activateRoot` requires `this.age >= 144`. That is a relative timelock
  (OP_CHECKSEQUENCEVERIFY) on the registry's master UTXO.
  - Only the operator can spend that UTXO during the window, by proposing again, which restarts the window.
  - The pool reads the registry through its data NFT only, so nobody can reset or skip the delay.
  - Watchers have a full day to recompute a proposed root from the public F@H files (see `build-epoch --verify`
    below) and raise the alarm.
- **Sync.** `FoldClaimPool.syncRoot` copies the registry's *active* root, never the pending one. Anyone can call it.

### Files

| Path | What it is |
|---|---|
| `contracts/RootRegistry.scash` | Timelocked root publisher (operator proposes, anyone activates after 144 blocks) |
| `contracts/FoldClaimPool.scash` | Claim pool: Merkle loop, verified-mapping receipts, token container, cross-contract root read |
| `src/merkle.ts` | Off-chain tree and proofs, matching the contract byte for byte |
| `src/snapshot.ts`, `scripts/build-epoch.ts` | F@H daily summary → points delta → token allocation → cumulative leaves → root, plus `--verify` for watchers |
| `src/steps.ts`, `scripts/run.ts` | Resumable deployment and demo steps (each records its txid before anything else can fail) |
| `scripts/claim.ts` | Claim for any address in a published epoch file; the user's own key or a relayer pays the fee |
| `src/relative-lock.ts` | Sets the master input's nSequence for `this.age` (SolidCash 0.51 has no option for it yet; fix prepared upstream) |
| `deployments/mainnet/` | State, compiled artifacts, the epoch files (the static proof endpoint) and public info |
| `test/` | Solidhat tests: contracts, forged claims, the mainnet rehearsal, Merkle depth |

## Live on mainnet

All transactions are on BCH mainnet. The reward token is a worthless test token (category `b8259369…c478`, 10⁹
units), never real FLDCH.

| Step | Transaction |
|---|---|
| RootRegistry deploy (category `c9521215…de082`) | `d80f89918b43cb4eb94515fe8bbcc70a28e0efafa576b627adeeef06097056d0` |
| Propose epoch 1 (300 leaves, depth 9, root `f6b2e52e…2b15f`) | `d8ffa816fd0d980872e88ac85621b97f2241d3585cfd916e7b2d4912464266b5` |
| Test token genesis | `5410e0d9469e127804b0f22787c5c1612f32b372a7472a4e319cb123eb786771` |
| FoldClaimPool deploy (category `f50d2d3d…ab6a`) | `14ba45c3bc715f66d050062c20de26197ad222292042721101626192c9afa3a6` |
| Activate, sync, claims, epoch 2 | see `deployments/mainnet/state.json`; they follow the 144-block window |

The demo tree has 300 leaves.
- **Ten leaves** pay demo recipients whose keys we hold. They are spread across the tree (indexes 0, 1, 42, 99,
  150, 151, 200, 255, 256, 299) so the claims exercise different proof paths, including the last leaf, whose
  path runs through the zero padding.
- **The other 290** are synthetic locks with no known key. We never claim them, so no unsolicited tokens or dust
  go to real people.

## Run it

```sh
npm install
npx solidhat test                       # all tests on the production-limit mock (sequential, several minutes)

# a network (state in deployments/<net>/, keys in secrets/<net>-operator.wif, never printed)
R="node --experimental-transform-types --no-warnings scripts/run.ts mainnet"
$R status
$R registry && $R propose 1 && $R token && $R pool
$R activate 1        # refused until 144 blocks after the proposal confirmed; a refusal costs nothing
$R sync 1 && $R claim 1 all
scripts/autopilot.sh mainnet           # or let this retry each step until the demo is complete

# a user's claim (any address in the epoch file); --payer <wif-file> pays the fee from the user's own key
node --experimental-transform-types --no-warnings scripts/claim.ts mainnet deployments/mainnet/tree-epoch1.json <address>
```

The code is network-agnostic. `scripts/run.ts chipnet …` runs the same steps on chipnet.

## Cost

These figures were measured on the SDK's production-limit mock (`reports/rehearsal.json`, `reports/depth-analysis.md`)
and match the mainnet transactions so far, byte for byte where both exist.

| | Size | Paid by | Paid |
|---|---|---|---|
| Root update per epoch (propose + activate + sync) | 3.2 + 3.1 + 4.4 kB | operator | ≈ 10,800 sats, **independent of the number of users** |
| First claim by a recipient | ≈ 5.4 kB | claimer (user or relayer) | ≈ 8,000–9,000 sats: about 5,400 fee, 1,200 that travel with the tokens to the recipient, and the rest locked in the receipt entry |
| Later top-up claim | ≈ 5.1 kB | claimer | ≈ 6,500 sats |
| Push (today), per user per distribution | ≈ 70–80 B output | operator | ≈ 75 sats fee + a token-output dust amount (~800 sats) |

So:
- **For the operator,** pull replaces about 875 sats × users × distributions with about 10,800 sats per epoch.
  At 10,000 users and monthly distributions, that is about 8.75 M sats a month against 10,800.
- **For a user,** one claim costs about the same as 7–10 pushes. A user who claims less often than every 7–10
  distributions comes out ahead of the push model. A user who never claims costs nobody anything.
- **Claim size barely depends on tree size.** Each level adds one 32-byte sibling.
  - Depth 9 (512 leaves) gives a 5,462-byte claim.
  - Depth 24 (16.7 M leaves) gives a 5,944-byte claim.
  - The unlocking bytecode stays near 4.2 kB, well under the 10,000-byte per-input limit.
  - The contract's `depth <= 24` cap, not the VM, is the ceiling.
- **Why a claim is about 5 kB:** SolidCash's stateful machinery co-spends the pool master, its data NFT, the
  receipt entry (or its predecessor for a first claim), the token container and the registry's data NFT. A
  hand-written CashScript claim path could be smaller, at the price of writing that machinery by hand.

## Answers to the open questions in the bounty

- **Epoch cadence.**
  - Snapshots are daily, because F@H publishes daily.
  - Weekly or monthly roots are enough. Since roots are cumulative, cadence changes nothing for users.
  - Each epoch costs the operator about 10,800 sats.
  - Two epochs must be at least 144 blocks apart: one audit window, plus the sync before the next proposal.
- **Maximum leaves.** 2²⁴ ≈ 16.7 M per root, at about 5.9 kB per claim (see the depth analysis).
- **Root authority.**
  - The v1 demo uses a single operator key.
  - For production we recommend 2-of-3. `proposeRoot` would check a multisig instead of one signature, a small
    change.
  - The 144-block window and public watchers protect users whatever the key setup.
  - There is no on-chain veto. A bad root can only be replaced by a new proposal, which restarts the window.
- **Receipt layout.**
  - A verified-mapping entry, keyed by the recipient's locking bytecode, whose value is the cumulative amount
    already paid.
  - It is held under the pool's category, not in the user's wallet. Absence is proven by co-spending the
    strict predecessor in the sorted map, which is how double claims are refused.
- **How leaves link to F@H names.**
  - F@H usernames of the form `{name}_{address}` are decoded with CashAddress.
  - Token-aware and plain forms of one key map to the same locking bytecode.
  - Several names that point to one address are added together.
  - Names without a valid address get nothing.
- **Link verification.**
  - Off-chain. Each epoch publishes the SHA-256 of the two F@H files it was built from.
  - Anyone can rebuild the root with `scripts/build-epoch.ts --verify` within the 144-block window.
  - On-chain, the contract only checks Merkle membership and the timelock.
- **Not built (yet).**
  - The optional operator push path behind a long timelock.
  - Sharding the pool across several UTXOs.
  - Claims serialize on the pool's master UTXO. BCH has no unconfirmed-chain limit, so throughput is fine, but
    two claimers who build at the same moment conflict and one must rebuild.

## Assumptions

- **SolidCash instead of CashScript.** The contracts are SolidCash 0.51 and compile to ordinary BCH script.
  SolidCash brings stateful storage, verified mappings, token containers and loops, which keep the contract short.
- **Mainnet instead of chipnet.** The bounty asks for a chipnet demo. We ran it on mainnet with a test token,
  which is a stricter test. The same code runs on chipnet unchanged.
- **Test token, not FLDCH.** The pool never holds real FLDCH.

## Security notes

An independent review (an AI code reviewer, with its findings fixed) found no critical or high issues. It checked:
operator-only proposals; no early activation; no griefing of the timer; monotonic epochs; double claims; payout
redirection; leaf/node second preimages; out-of-range and negative indexes; uint64 bounds; and draining.

The tests cover all of these, including forged claims (wrong recipient, inflated amount, wrong path, index out of
range, negative index, truncated proof, other token).

The trust model: the operator key can publish any root, which takes effect after 144 blocks unless watchers act.
Use 2-of-3 for real funds.

## Credits

Built by samizdatproject with Claude Code (Anthropic): the code, tests and this document were written with AI
assistance and checked by the tests above and an independent AI review.
