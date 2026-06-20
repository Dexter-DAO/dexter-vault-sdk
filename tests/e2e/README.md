# Personhood loop E2E (SDK-driven, fixture)

Proves the personhood credit -> ledger loop is drivable entirely through the
published `@dexterai/vault` SDK surface — `establish_credit_root -> welded vault
-> record_credit_event -> readback` — against a local validator, with the
committed World ID v4 fixture (no real proof).

The program-side loop is already proven in
`dexter-vault/tests/world-id-credit-root.ts` via Anchor bindings; this test
proves the SAME loop through the SDK contract the facilitator + admin console
consume. Every on-chain write/read here goes through an SDK export, never an
Anchor binding.

## Prereqs (one terminal)

1. Build the program with the fixture-test feature so the committed snarkjs
   fixture verifies on-chain:
   ```bash
   cd ~/websites/dexter-vault && anchor build -- --features fixture-test-context
   ```
2. Start a local validator preloaded with the built program:
   ```bash
   solana-test-validator --reset \
     --bpf-program Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc \
     target/deploy/dexter_vault.so
   ```
3. Fund a local payer / dexter-authority keypair:
   ```bash
   solana airdrop 10 <pubkey> -u localhost
   ```
4. Post the interim World ID root the fixture proof is anchored to
   (`public.json[6]` = R_test) via `post_interim_root`. The SDK does not expose
   a builder for this admin step — drive it with the dexter-vault harness
   (`world-id-credit-root.ts` posts it before `establish_credit_root`).
   `establish_credit_root` will fail with a root-cache miss until this is done.

## Run

```bash
DEXTER_RPC=http://127.0.0.1:8899 \
FIXTURE_DIR=~/websites/dexter-vault/tests/fixtures/world-id-v4 \
PAYER_KEYPAIR=<path-to-keypair.json> \
  npx vitest run tests/e2e/personhood-loop.e2e.test.ts
```

Expected: PASS — `eventCount` 0 -> 1, one `CreditEvent` of `500000` against the
welded vault, read back through the SDK.

The test **SKIPS itself** if any of `DEXTER_RPC` / `FIXTURE_DIR` /
`PAYER_KEYPAIR` is unset, so `npx vitest run` (the full suite) stays green on a
validator-less CI box.

## Proof-shape: the fixture is snarkjs-RAW (pinned)

`tests/fixtures/world-id-v4/proof.json` is **raw snarkjs groth16 output**, NOT
pre-prepared on-chain byte arrays. It has the projective limbs:

- `pi_a`: `[x, y, 1]` (decimal field-element strings)
- `pi_b`: `[[x_c0, x_c1], [y_c0, y_c1], [1, 0]]`
- `pi_c`: `[x, y, 1]`

`public.json` is the 15 public signals as decimal field-element strings
(`public[0]` = nullifier, `public[6]` = merkle root R_test).

Therefore the E2E does NOT pass the proof bytes straight through. It MIRRORS the
verified transform in `dexter-vault/tests/helpers/world-id.ts`
(`loadFixtureProofArgs`), which itself mirrors the Rust host KAT in
`programs/dexter-vault/src/verify/groth16.rs`:

| field    | transform                                                                 | bytes |
| -------- | ------------------------------------------------------------------------- | ----- |
| proof_a  | `dec2be32(pi_a[0]) ‖ dec2be32((P - pi_a[1]) mod P)` (G1 negated)           | 64    |
| proof_b  | `dec2be32(pi_b[0][1]) ‖ dec2be32(pi_b[0][0]) ‖ dec2be32(pi_b[1][1]) ‖ dec2be32(pi_b[1][0])` (limb-reordered G2) | 128   |
| proof_c  | `dec2be32(pi_c[0]) ‖ dec2be32(pi_c[1])` (G1, not negated)                  | 64    |
| public[] | each decimal -> `dec2be32` (big-endian 32-byte)                           | 15×32 |

where `P` is the bn254 base field prime. If the fixture were ever swapped for a
pre-prepared (raw 64/128/64-byte) proof, drop these transforms and pass the
bytes straight through instead.
