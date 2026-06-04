/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/dexter_vault.json`.
 */
export type DexterVault = {
  "address": "Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc",
  "metadata": {
    "name": "dexterVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "finalizeWithdrawal",
      "discriminator": [
        178,
        87,
        206,
        68,
        201,
        186,
        164,
        232
      ],
      "accounts": [
        {
          "name": "swig",
          "docs": [
            "Position 0 — REQUIRED at this index by Swig's ProgramExec authority",
            "validator. When a Swig::SignV2 follows this instruction in the same",
            "transaction, Swig's on-chain validator inspects accounts[0..1] of the",
            "preceding instruction and rejects unless they're [swig, swig_wallet].",
            "",
            "We additionally enforce `swig.key() == vault.swig_address` via the",
            "`address` constraint so a caller cannot pass an arbitrary Swig account",
            "in here — defense in depth: even if Swig's own validation changes in a",
            "future program upgrade, this vault keeps its own invariant.",
            "",
            "deserialize or dereference it."
          ]
        },
        {
          "name": "swigWalletAddress",
          "docs": [
            "Position 1 — required by Swig's ProgramExec validator (see `swig`).",
            "The Swig wallet address is the PDA owning the SPL token ATA being",
            "debited; it is derived under the Swig program at",
            "`[\"swig-wallet-address\", swig_pubkey]`.",
            "",
            "We independently verify the canonical derivation via Anchor's `seeds`",
            "+ `seeds::program` constraint. If a caller supplied a fake account, our",
            "program rejects before any Swig CPI runs — we do not rely on Swig",
            "catching it downstream.",
            ""
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  105,
                  103,
                  45,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116,
                  45,
                  97,
                  100,
                  100,
                  114,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "swig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                13,
                12,
                233,
                66,
                225,
                231,
                197,
                6,
                226,
                24,
                223,
                13,
                125,
                241,
                197,
                47,
                175,
                220,
                53,
                41,
                228,
                141,
                103,
                77,
                29,
                178,
                76,
                117,
                181,
                76,
                204,
                190
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "finalizeWithdrawalArgs"
            }
          }
        }
      ]
    },
    {
      "name": "forceRelease",
      "discriminator": [
        122,
        190,
        243,
        252,
        54,
        202,
        208,
        234
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "buyer's passkey signature via the SIMD-0075 precompile sibling."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "forceReleaseArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initializeVault",
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "dexterAuthority",
          "docs": [
            "The Dexter session authority to bind to this vault. Must sign init, so",
            "a vault can only be created bound to an authority that consented. This",
            "key may later mutate `pending_voucher_count` (settle_voucher /",
            "force_release) — and only this key. It can never move funds."
          ],
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeVaultArgs"
            }
          }
        }
      ]
    },
    {
      "name": "provePasskey",
      "discriminator": [
        35,
        175,
        41,
        143,
        201,
        118,
        49,
        184
      ],
      "accounts": [
        {
          "name": "vault",
          "docs": [
            "Read-only: this instruction proves passkey control and mutates NOTHING."
          ]
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "passkey signature via the SIMD-0075 precompile sibling instruction."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "provePasskeyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "registerSessionKey",
      "discriminator": [
        69,
        94,
        60,
        44,
        49,
        199,
        183,
        233
      ],
      "accounts": [
        {
          "name": "vault",
          "docs": [
            "Receives the new `active_session`. Mutated, no signer required: the",
            "passkey signature embedded in the args (verified via the SIMD-0075",
            "precompile sibling) is what authorizes the mutation."
          ],
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "instruction in the transaction MUST be a secp256r1_verify call whose",
            "signed message is `authenticatorData || sha256(clientDataJSON)` and",
            "whose `clientDataJSON.challenge` decodes to sha256(registration_message)."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "registerSessionKeyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "requestWithdrawal",
      "discriminator": [
        251,
        85,
        121,
        205,
        56,
        201,
        12,
        177
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "requestWithdrawalArgs"
            }
          }
        }
      ]
    },
    {
      "name": "revokeSessionKey",
      "discriminator": [
        81,
        192,
        32,
        110,
        104,
        116,
        144,
        151
      ],
      "accounts": [
        {
          "name": "vault",
          "docs": [
            "Mutated to clear `active_session`. No signer required; the passkey",
            "signature in the args is the authorization."
          ],
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "instruction in the transaction MUST be a secp256r1_verify call."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "revokeSessionKeyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "rotateDexterAuthority",
      "discriminator": [
        145,
        60,
        4,
        119,
        180,
        205,
        236,
        134
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "dexterAuthority",
          "docs": [
            "Must equal the vault's CURRENT `dexter_authority`. Only the current",
            "authority can hand off to a new one — so the session-master key can be",
            "rotated without bricking existing vaults."
          ],
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "rotateDexterAuthorityArgs"
            }
          }
        }
      ]
    },
    {
      "name": "rotatePasskey",
      "discriminator": [
        28,
        134,
        49,
        89,
        196,
        34,
        58,
        174
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "CURRENT passkey signature via the SIMD-0075 precompile sibling."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "rotatePasskeyArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setSwig",
      "discriminator": [
        253,
        229,
        89,
        206,
        192,
        118,
        137,
        165
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setSwigArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setSwigAtomic",
      "discriminator": [
        119,
        111,
        247,
        215,
        190,
        3,
        170,
        23
      ],
      "accounts": [
        {
          "name": "vault",
          "docs": [
            "The dexter-vault PDA — initialized by initialize_vault, mutated here",
            "(we set swig_address)."
          ],
          "writable": true
        },
        {
          "name": "feePayer",
          "docs": [
            "The fee payer + role-0 bootstrap authority. MUST be a tx-level signer."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "swigAccount",
          "docs": [
            "The Swig state account, derived as `findProgramAddress([swig_id], swig_program)`.",
            "Swig will initialize it during the CreateV1 CPI."
          ],
          "writable": true
        },
        {
          "name": "swigWalletAddress",
          "docs": [
            "The Swig wallet PDA (different from swig_account — it's the spending",
            "authority address). CPI'd into by CreateV1."
          ],
          "writable": true
        },
        {
          "name": "swigProgram",
          "docs": [
            "The Swig program itself."
          ],
          "address": "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB"
        },
        {
          "name": "systemProgram",
          "docs": [
            "System program — Swig CreateV1 needs it to create the state account."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "Instructions sysvar — read by verify_passkey_signed."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setSwigAtomicArgs"
            }
          }
        }
      ]
    },
    {
      "name": "settleTabVoucher",
      "discriminator": [
        173,
        22,
        98,
        31,
        110,
        129,
        59,
        161
      ],
      "accounts": [
        {
          "name": "swig",
          "docs": [
            "Position 0 — REQUIRED at this index by Swig's ProgramExec authority",
            "validator. When a Swig::SignV2 follows this instruction in the same",
            "transaction, Swig's on-chain validator inspects accounts[0..1] of",
            "the preceding instruction and rejects unless they're",
            "[swig, swig_wallet], AND that the preceding instruction's data",
            "starts with a registered marker discriminator.",
            "",
            "Also bound to `vault.swig_address` via the Anchor `address`",
            "constraint, so a caller cannot pass an arbitrary Swig account here.",
            "",
            "deserialize or dereference it."
          ]
        },
        {
          "name": "swigWalletAddress",
          "docs": [
            "Position 1 — required by Swig's ProgramExec validator (see `swig`).",
            "The Swig wallet address is the PDA owning the SPL token ATA being",
            "debited; derived under the Swig program at",
            "`[\"swig-wallet-address\", swig_pubkey]`.",
            ""
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  105,
                  103,
                  45,
                  119,
                  97,
                  108,
                  108,
                  101,
                  116,
                  45,
                  97,
                  100,
                  100,
                  114,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "swig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                13,
                12,
                233,
                66,
                225,
                231,
                197,
                6,
                226,
                24,
                223,
                13,
                125,
                241,
                197,
                47,
                175,
                220,
                53,
                41,
                228,
                141,
                103,
                77,
                29,
                178,
                76,
                117,
                181,
                76,
                204,
                190
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "dexterAuthority",
          "docs": [
            "Must equal `vault.dexter_authority` — only the recorded authority",
            "can drive the gate-counter decrement. The buyer's session-key",
            "signature is what authorizes the SPEND amount; this signer is what",
            "authorizes the counter mutation. Same model as the existing",
            "`settle_voucher`. NOTE: this signer does NOT sign the Swig transfer",
            "in [N+1] — that's signed by the swig wallet PDA via Swig's",
            "ProgramExec authority, gated by the vault program being the",
            "ProgramExec authority on the Swig."
          ],
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "settleTabVoucherArgs"
            }
          }
        }
      ]
    },
    {
      "name": "settleVoucher",
      "discriminator": [
        144,
        176,
        128,
        220,
        156,
        79,
        41,
        54
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "dexterAuthority",
          "docs": [
            "Must equal the `dexter_authority` recorded on the vault at init.",
            "`has_one` enforces this — closing Finding B (previously any signer",
            "could mutate the counter)."
          ],
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "settleVoucherArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "coolingOffNotElapsed",
      "msg": "Cooling-off period has not elapsed"
    },
    {
      "code": 6001,
      "name": "pendingVouchersExist",
      "msg": "Pending vouchers must settle before withdrawal can finalize"
    },
    {
      "code": 6002,
      "name": "noPendingWithdrawal",
      "msg": "No pending withdrawal request"
    },
    {
      "code": 6003,
      "name": "passkeyVerificationFailed",
      "msg": "Passkey signature verification failed"
    },
    {
      "code": 6004,
      "name": "invalidVoucherSignature",
      "msg": "Voucher signature does not match Dexter session key"
    },
    {
      "code": 6005,
      "name": "forceReleaseTooEarly",
      "msg": "force_release grace period has not elapsed"
    },
    {
      "code": 6006,
      "name": "nothingToRelease",
      "msg": "No stuck voucher to force-release"
    },
    {
      "code": 6007,
      "name": "unsupportedVaultVersion",
      "msg": "Vault account version is not supported by this program"
    },
    {
      "code": 6008,
      "name": "sessionAlreadyActive",
      "msg": "A session is already active on this vault and has not expired"
    },
    {
      "code": 6009,
      "name": "sessionExpiryInPast",
      "msg": "Session expiry must be in the future"
    },
    {
      "code": 6010,
      "name": "sessionCapZero",
      "msg": "Session max_amount must be greater than zero"
    },
    {
      "code": 6011,
      "name": "noActiveSession",
      "msg": "No active session to revoke"
    },
    {
      "code": 6012,
      "name": "sessionPubkeyMismatch",
      "msg": "Revocation message session pubkey does not match the active session"
    }
  ],
  "types": [
    {
      "name": "finalizeWithdrawalArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn clientDataJSON; challenge must be sha256(operation_message)."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "forceReleaseArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn clientDataJSON; challenge must be sha256(operation_message)."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "initializeVaultArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "passkeyPubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "coolingOffSeconds",
            "docs": [
              "Withdrawal cooling-off in seconds. Zero = instant. See §7.1 of the v2",
              "design doc for why this tightened from i64 to u32."
            ],
            "type": "u32"
          },
          {
            "name": "identityClaim",
            "docs": [
              "Operator-defined opaque identity bytes. The protocol doesn't interpret",
              "these. Dexter writes a Supabase UUID into the first 16 bytes and zeros",
              "the rest; future operators may use whichever scheme they want."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "pendingWithdrawal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "requestedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "provePasskeyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "challenge",
            "docs": [
              "The 32-byte challenge to prove control over (e.g. a SIWX login nonce /",
              "digest). The passkey must have signed `\"siwx_login\" || challenge`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn clientDataJSON; its `challenge` field must base64url-decode to",
              "`sha256(\"siwx_login\" || challenge)`."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "registerSessionKeyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sessionPubkey",
            "docs": [
              "Ed25519 pubkey the buyer's SDK generated in memory. The passkey is",
              "endorsing this exact key — only this key can sign vouchers for the",
              "duration of the session."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxAmount",
            "docs": [
              "Cumulative cap in atomic units. The seller's middleware AND any future",
              "on-chain consumer of `active_session.spent` enforces this."
            ],
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Wall-clock expiry, unix seconds. Must be strictly in the future."
            ],
            "type": "i64"
          },
          {
            "name": "allowedCounterparty",
            "docs": [
              "The seller this session is bound to. Any voucher claiming a different",
              "counterparty MUST be rejected by the seller's verification path."
            ],
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "Per-session nonce. Combined with `expires_at`, gives each session a",
              "unique fingerprint for off-chain replay protection. Caller picks; the",
              "program does not enforce monotonicity (a non-monotonic nonce is the",
              "buyer's own footgun, not a protocol attack)."
            ],
            "type": "u32"
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn `clientDataJSON`. Its `challenge` field must base64url-decode",
              "to sha256(registration_message)."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "docs": [
              "WebAuthn `authenticatorData` (37+ bytes)."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "requestWithdrawalArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "signedAt",
            "type": "i64"
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn `clientDataJSON` from the browser. Its `challenge` field",
              "must base64url-decode to `sha256(operation_message)`."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "docs": [
              "WebAuthn `authenticatorData` (37+ bytes)."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "revokeSessionKeyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "clientDataJson",
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "rotateDexterAuthorityArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newDexterAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "rotatePasskeyArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newPasskeyPubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn clientDataJSON; challenge must be sha256(operation_message)."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "sessionRegistration",
      "docs": [
        "On-chain record of an authorized session key.",
        "",
        "The session pubkey is an ordinary ed25519 keypair the buyer's SDK generated",
        "in memory at tab-open time. The passkey signed a 180-byte registration",
        "message (see docs/DESIGN-vault-v2-session-keys.md §2.2) endorsing these",
        "scope limits. From this point on, the seller's middleware accepts vouchers",
        "signed by `session_pubkey` for this vault, up to `max_amount` and before",
        "`expires_at`, only for `allowed_counterparty`.",
        "",
        "`spent` is the running cumulative — incremented by settle paths that close",
        "vouchers — so we can enforce the cap across the lifetime of the session",
        "without an additional read."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sessionPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxAmount",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "allowedCounterparty",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u32"
          },
          {
            "name": "spent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "setSwigArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "swigAddress",
            "type": "pubkey"
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn `clientDataJSON` produced by the browser. Must contain a",
              "`challenge` field equal to base64url(sha256(operation_message))."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "docs": [
              "WebAuthn `authenticatorData` produced by the authenticator (37+ bytes)."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "setSwigAtomicArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "swigId",
            "docs": [
              "32-byte Swig ID (HMAC-derived client-side from identity_seed + hmac_key)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "swigAccountBump",
            "docs": [
              "Bump for swig_account."
            ],
            "type": "u8"
          },
          {
            "name": "swigWalletAddressBump",
            "docs": [
              "Bump for swig_wallet_address PDA."
            ],
            "type": "u8"
          },
          {
            "name": "dexterMasterPubkey",
            "docs": [
              "Becomes role-2 (Ed25519Session) authority."
            ],
            "type": "pubkey"
          },
          {
            "name": "clientDataJson",
            "docs": [
              "WebAuthn clientDataJSON (challenge = sha256(\"set_swig\" || swig_address_bytes))."
            ],
            "type": "bytes"
          },
          {
            "name": "authenticatorData",
            "docs": [
              "WebAuthn authenticatorData (37+ bytes)."
            ],
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "settleTabVoucherArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "channelId",
            "docs": [
              "Channel id from the voucher's payload — first 32 bytes of the",
              "44-byte message the session key signed."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "cumulativeAmount",
            "docs": [
              "Total cumulative amount this voucher authorizes. Must be > the",
              "vault's recorded `active_session.spent` (monotonic) and <= the",
              "session's `max_amount` cap."
            ],
            "type": "u64"
          },
          {
            "name": "sequenceNumber",
            "docs": [
              "Monotonic sequence number from the voucher payload. Stored as-is in",
              "the signed message; not currently used for replay defense (the",
              "`spent` monotonicity check covers replay) but reserved for future",
              "out-of-order voucher detection."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "settleVoucherArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "increment",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "docs": [
              "Layout version. MUST be the first field so byte 0 of the deserialized",
              "account directly indicates which Vault generation this is. A program",
              "bound to v2 rejects (`VaultError::UnsupportedVaultVersion`) anything",
              "that isn't `VAULT_VERSION_V2`."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "passkeyPubkey",
            "type": {
              "array": [
                "u8",
                33
              ]
            }
          },
          {
            "name": "swigAddress",
            "type": "pubkey"
          },
          {
            "name": "coolingOffSeconds",
            "docs": [
              "Minimum delay between `request_withdrawal` and `finalize_withdrawal`.",
              "`u32` because negative is meaningless and 136 years of seconds is plenty."
            ],
            "type": "u32"
          },
          {
            "name": "pendingVoucherCount",
            "type": "u32"
          },
          {
            "name": "pendingWithdrawal",
            "type": {
              "option": {
                "defined": {
                  "name": "pendingWithdrawal"
                }
              }
            }
          },
          {
            "name": "identityClaim",
            "docs": [
              "Operator-defined opaque identity claim (formerly `supabase_user_id`).",
              "The protocol does not interpret these bytes; Dexter writes a Supabase",
              "UUID prefix, future operators may write whatever they want. Documented",
              "in the OTS spec as \"operator-defined\"."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "dexterAuthority",
            "docs": [
              "The session authority recorded at init — the ONLY key permitted to",
              "mutate `pending_voucher_count` (settle_voucher / force_release)."
            ],
            "type": "pubkey"
          },
          {
            "name": "activeSession",
            "docs": [
              "Currently-authorized session key, if any. Written by `register_session_key`",
              "(passkey-signed), cleared by `revoke_session_key` (passkey-signed) or by",
              "the program when expiry is observed during a future read. v2 enforces",
              "at most one active session per vault; multi-seller / multi-session is",
              "future work (issue #5)."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "sessionRegistration"
                }
              }
            }
          }
        ]
      }
    }
  ]
};
