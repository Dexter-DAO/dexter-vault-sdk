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
          "name": "vault",
          "writable": true
        },
        {
          "name": "swig"
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
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.supabase_user_id"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
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
          "name": "dexterSessionSigner",
          "signer": true
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
            "type": "i64"
          },
          {
            "name": "supabaseUserId",
            "type": {
              "array": [
                "u8",
                16
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
            "type": "i64"
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
            "name": "supabaseUserId",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          }
        ]
      }
    }
  ]
};
