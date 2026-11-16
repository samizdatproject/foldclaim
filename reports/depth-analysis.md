## Merkle proof depth on the production-limit mock

| Depth | Max leaves | Claim tx (B) | Unlocking (B) | Accepted | Fee @ 1 sat/B |
|---|---|---|---|---|---|
| 9 | 512 | 5,462 | 3,692 | yes | 5,462 |
| 12 | 4,096 | 5,558 | 3,788 | yes | 5,558 |
| 16 | 65,536 | 5,687 | 3,917 | yes | 5,687 |
| 20 | 1,048,576 | 5,815 | 4,045 | yes | 5,815 |
| 24 | 16,777,216 | 5,944 | 4,174 | yes | 5,944 |
| 25 | n/a | n/a | n/a | refused ("proof too deep") | n/a |

Each extra level adds about 32 bytes (one sibling) to the claim, so the full 24-level proof costs only about 480 bytes more than depth 9. The unlocking bytecode stays near 4.2 KB at depth 24, well under the 10,000-byte per-input limit, so that limit would only bind at roughly 180 levels. The op-cost and hashing budget accepted all depths, since each level is one 65-byte sha256. The contract's `depth <= 24` cap, not the VM, is the effective ceiling. The 128-byte commitment is irrelevant here because the proof is passed as an unlocking argument and not stored in the commitment.
A depth-d tree holds 2^d recipients, so depth 9 covers 512 F@H recipients, depth 12 covers 4,096, depth 16 covers 65,536, depth 20 covers about 1.05 million and depth 24 covers about 16.8 million. Roots here are synthetic (one real leaf, random siblings); a second claim under a random-index root also succeeded at every depth.
