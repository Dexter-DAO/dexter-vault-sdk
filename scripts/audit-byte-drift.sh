#!/usr/bin/env bash
# audit-byte-drift.sh — find protocol bytes hand-rolled OUTSIDE the SDK.
#
# The SDK owns every protocol byte: op-message tags, PDA seeds, discriminator
# derivations. Any consumer reconstructing them locally is bypass drift (the
# class that produced dexter-fe/operationMessages.ts, killed 2026-07-18).
#
# Usage:  bash scripts/audit-byte-drift.sh          # scan, report, exit 1 on hits
# Allowlist: audit-byte-drift.allow (one grep -F pattern per line) for reviewed,
# deliberate exceptions (e.g. the program's own Rust, this SDK, proof receipts).
set -uo pipefail

SDK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ALLOW="$SDK_DIR/scripts/audit-byte-drift.allow"

# Repos that CONSUME the protocol (never allowed to own its bytes).
CONSUMERS=(
  /home/branchmanager/websites/dexter-fe/app
  /home/branchmanager/websites/dexter-api/src
  /home/branchmanager/websites/dexter-api/scripts
  /home/branchmanager/websites/dexter-mcp/src
  /home/branchmanager/websites/dexter-loop/src
  /home/branchmanager/websites/dexter-agents/src
  /home/branchmanager/websites/dexter-connect/src
  /home/branchmanager/websites/dexter-x402-sdk/src
  /home/branchmanager/websites/dexter-facilitator/src
  /home/branchmanager/websites/x402gle/src
)

# Protocol byte fingerprints: op-message tags + distinctive PDA seeds +
# discriminator derivation. Quoted-literal forms only (route paths use hyphens).
PATTERNS=(
  "'request_withdrawal'" '"request_withdrawal"'
  "'finalize_withdrawal'" '"finalize_withdrawal"'
  "'force_release'" '"force_release"'
  "'set_swig'" '"set_swig"'
  "'swap_for_carry'" '"swap_for_carry"'
  "'claim_vault'" '"claim_vault"'
  "'siwx_login'" '"siwx_login"'
  "'open_standby'" '"open_standby"'
  "'close_standby'" '"close_standby"'
  "'attach_node'" '"attach_node"'
  "'recover_abandoned_lock'" '"recover_abandoned_lock"'
  "OTS_SESSION_REGISTER" "OTS_SESSION_REVOKE"
  "'swap_bracket'" '"swap_bracket"'
  "'locked-claim'" '"locked-claim"'
  "'credit_root'" '"credit_root"'
  "sha256(\"global:" "sha256('global:"
  "sha256(\"account:" "sha256('account:"
)

HITS_FILE="$(mktemp)"
for dir in "${CONSUMERS[@]}"; do
  [ -d "$dir" ] || continue
  for pat in "${PATTERNS[@]}"; do
    grep -rn -F "$pat" "$dir" \
      --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
      2>/dev/null
  done
done | sort -u > "$HITS_FILE"

if [ -f "$ALLOW" ]; then
  FILTERED="$(grep -vFf "$ALLOW" "$HITS_FILE" || true)"
else
  FILTERED="$(cat "$HITS_FILE")"
fi
rm -f "$HITS_FILE"

if [ -z "$FILTERED" ]; then
  echo "✓ byte-drift audit clean — no protocol bytes hand-rolled outside the SDK"
  exit 0
fi

echo "✗ BYPASS DRIFT — protocol bytes found outside the SDK:"
echo "$FILTERED" | sed 's/^/  /'
echo
echo "Fix: consume @dexterai/vault builders, or add a REVIEWED line to scripts/audit-byte-drift.allow"
exit 1
