// Lazy chunk (loaded with import()): reattach the registry and pool with the SolidCash SDK, exactly as
// scripts/claim.ts does, and decode their live on-chain state.
import { hexToBin, binToHex } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { StatefulContract, getDataNftLockingBytecode } from '@solidcash/solidcash/stateful';

const plain = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v instanceof Uint8Array ? binToHex(v) : String(v)]));

export async function readLiveState({ state, publicInfo, poolArtifact, registryArtifact }) {
  const provider = new ElectrumNetworkProvider('mainnet');
  const operator = hexToBin(publicInfo.operatorPublicKey);
  const reg = state.steps.registry;
  const registry = StatefulContract.from(registryArtifact, [operator], { provider }, reg.categoryId);
  const registryData = getDataNftLockingBytecode(reg.categoryId, hexToBin(reg.lockingBytecode));
  const pool = StatefulContract.from(poolArtifact, [hexToBin(state.steps.token.category), registryData], {
    provider,
    externalContracts: { IRootRegistry: { artifact: registryArtifact, categoryId: reg.categoryId, constructorArgs: [operator] } },
  }, state.steps.pool.categoryId);
  try {
    const registryState = plain(await registry.getState());
    const poolState = plain(await pool.getState());
    return { registry: registryState, pool: poolState };
  } finally {
    try { await provider.disconnect?.(); } catch { /* already closed */ }
  }
}
