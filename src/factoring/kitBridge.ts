/**
 * Kit v2 → Web3.js v1 instruction converter + RPC extractor.
 * Ported verbatim from dexter-api/src/vault/finalizeWithdrawBuilder.ts
 * (mirrors swigAdapter.ts kitInstructionsToWeb3 — keep in sync). The @swig-wallet/kit
 * SignV2 path emits kit-v2 instructions; the rest of the SDK speaks web3.js v1.
 */
import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js';
import { createSolanaRpc } from '@solana/kit';

export function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    const accounts = (ix.accounts ?? []).map((acc: any) => {
      const role = acc.role;
      const hasBooleanShape = typeof acc.signer === 'boolean' || typeof acc.writable === 'boolean';
      let isSigner = false;
      let isWritable = false;
      if (hasBooleanShape) {
        isSigner = Boolean(acc.signer);
        isWritable = Boolean(acc.writable);
      } else if (typeof role === 'number') {
        isSigner = role >= 2;
        isWritable = role % 2 === 1;
      } else if (typeof role === 'string') {
        const r = role.toLowerCase();
        isSigner = r.endsWith('signer');
        isWritable = r.startsWith('writable');
      }
      const addressSource = acc.address ?? acc.publicKey;
      const pubkey =
        addressSource instanceof PublicKey
          ? addressSource
          : typeof addressSource === 'string'
            ? new PublicKey(addressSource)
            : new PublicKey(String(addressSource));
      return { pubkey, isSigner, isWritable };
    });
    return new TransactionInstruction({
      programId: new PublicKey(ix.programAddress ?? ix.programId),
      keys: accounts,
      data: Buffer.from(ix.data ?? []),
    });
  });
}

export function getRpc(connection: Connection): any {
  const endpoint = (connection as any)._rpcEndpoint ?? (connection as any).rpcEndpoint;
  if (!endpoint) throw new Error('factoring: cannot extract RPC endpoint from connection');
  return createSolanaRpc(endpoint);
}
