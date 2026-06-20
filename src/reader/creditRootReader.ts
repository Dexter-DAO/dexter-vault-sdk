/**
 * CreditRoot / CreditEvent readers — credit-identity account surface.
 *
 * Both accounts are FIXED-SIZE with NO Option fields, so decoding is a
 * fixed-offset read (mirrors src/session/decode.ts), not a moving cursor.
 *
 * CreditRoot (58 bytes):
 *   0   8  Anchor discriminator
 *   8   1  version u8
 *   9   1  bump u8
 *  10  32  nullifier
 *  42   8  established_at i64 LE
 *  50   8  event_count u64 LE
 *
 * CreditEvent (99 bytes):
 *   0   8  Anchor discriminator
 *   8   1  version u8
 *   9   1  bump u8
 *  10  32  nullifier
 *  42   8  seq u64 LE
 *  50  32  vault
 *  82   8  recorded_at i64 LE
 *  90   1  kind u8
 *  91   8  amount u64 LE
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  CREDIT_ROOT_DISCRIMINATOR,
  CREDIT_ROOT_SIZE,
  CREDIT_EVENT_DISCRIMINATOR,
  CREDIT_EVENT_DISCRIMINATOR_B58,
  CREDIT_EVENT_SIZE,
  CREDIT_EVENT_NULLIFIER_OFFSET,
  DEXTER_VAULT_PROGRAM_ID,
} from "../constants/index.js";
import { deriveCreditRootPda } from "../credit/derive.js";
import type { CreditRootState, CreditEventState } from "../types.js";

function assertDisc(buf: Buffer, disc: Uint8Array): void {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== disc[i]) throw new Error("account discriminator mismatch");
  }
}

export function decodeCreditRoot(address: PublicKey, data: Buffer | Uint8Array): CreditRootState {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== CREDIT_ROOT_SIZE) {
    throw new Error(`CreditRoot must be ${CREDIT_ROOT_SIZE} bytes, got ${buf.length}`);
  }
  assertDisc(buf, CREDIT_ROOT_DISCRIMINATOR);
  return {
    address: address.toBase58(),
    version: buf.readUInt8(8),
    bump: buf.readUInt8(9),
    nullifier: new Uint8Array(buf.subarray(10, 42)),
    establishedAt: Number(buf.readBigInt64LE(42)),
    eventCount: buf.readBigUInt64LE(50),
  };
}

export function decodeCreditEvent(address: PublicKey, data: Buffer | Uint8Array): CreditEventState {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length !== CREDIT_EVENT_SIZE) {
    throw new Error(`CreditEvent must be ${CREDIT_EVENT_SIZE} bytes, got ${buf.length}`);
  }
  assertDisc(buf, CREDIT_EVENT_DISCRIMINATOR);
  return {
    address: address.toBase58(),
    version: buf.readUInt8(8),
    bump: buf.readUInt8(9),
    nullifier: new Uint8Array(buf.subarray(10, 42)),
    seq: buf.readBigUInt64LE(42),
    vault: new PublicKey(buf.subarray(50, 82)).toBase58(),
    recordedAt: Number(buf.readBigInt64LE(82)),
    kind: buf.readUInt8(90),
    amount: buf.readBigUInt64LE(91),
  };
}

export async function readCreditRoot(
  connection: Connection,
  nullifier: Uint8Array,
): Promise<CreditRootState | null> {
  const [pda] = deriveCreditRootPda(nullifier);
  const info = await connection.getAccountInfo(pda, "confirmed");
  return info ? decodeCreditRoot(pda, info.data) : null;
}

export async function fetchCreditEvents(
  connection: Connection,
  nullifier: Uint8Array,
): Promise<CreditEventState[]> {
  const raw = await connection.getProgramAccounts(DEXTER_VAULT_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: CREDIT_EVENT_SIZE },
      { memcmp: { offset: 0, bytes: CREDIT_EVENT_DISCRIMINATOR_B58 } },
      // base58-encode the 32-byte nullifier via PublicKey (CJS-safe; bs58@6 under
      // CJS only exposes encode on `.default`, so a bare bs58.encode resolves undefined).
      { memcmp: { offset: CREDIT_EVENT_NULLIFIER_OFFSET, bytes: new PublicKey(nullifier).toBase58() } },
    ],
  });
  return raw
    .map(({ pubkey, account }) => decodeCreditEvent(pubkey, account.data))
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}
