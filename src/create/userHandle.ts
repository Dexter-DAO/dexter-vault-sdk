/**
 * Generate a fresh 16-byte vault userHandle (was server-minted in the legacy
 * anon flow). 16 bytes because it packs into identity_claim[..16] and seeds the
 * vault PDA (deriveVaultPda requires exactly 16 bytes).
 *
 * Uses the platform Web Crypto CSPRNG (globalThis.crypto.getRandomValues),
 * available in browsers and Node >=19 / any tsup build target the SDK ships.
 */
export function generateUserHandle(): Uint8Array {
  const out = new Uint8Array(16);
  globalThis.crypto.getRandomValues(out);
  return out;
}
