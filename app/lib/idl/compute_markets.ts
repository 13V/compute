// Copied from /sdk — regenerate with anchor build and re-copy if the program changes.
/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/compute_markets.json`.
 */
export type ComputeMarkets = {
  "address": "8xv1L7757szxo2XPrQL5AERPGZrJaYRKgqB9RgFkQCU2",
  "metadata": {
    "name": "computeMarkets",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Compute — on-chain prediction markets for trading on compute (FPMM)"
  },
  "instructions": [
    {
      "name": "buy",
      "docs": [
        "Buy `outcome` (YES=0/NO=1) by investing `collateral_in`. A taker fee is",
        "deducted, a full set is minted into the pool, and the constant-product",
        "swap returns outcome tokens to the trader. Reverts if fewer than",
        "`min_tokens_out` would be received."
      ],
      "discriminator": [
        102,
        6,
        61,
        18,
        1,
        218,
        235,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true
        },
        {
          "name": "noMint",
          "writable": true
        },
        {
          "name": "poolYes",
          "writable": true
        },
        {
          "name": "poolNo",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "userOutcome",
          "docs": [
            "The trader's outcome-token account for the side being traded (validated in handler)."
          ],
          "writable": true
        },
        {
          "name": "userCollateral",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "collateralIn",
          "type": "u64"
        },
        {
          "name": "minTokensOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimPool",
      "docs": [
        "After resolution, the LP claims the winning-side pool reserve as collateral."
      ],
      "discriminator": [
        70,
        215,
        67,
        50,
        142,
        244,
        218,
        130
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "winningMint",
          "writable": true
        },
        {
          "name": "poolYes",
          "writable": true
        },
        {
          "name": "poolNo",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "lpCollateral",
          "writable": true
        },
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "collectFees",
      "docs": [
        "Admin withdraws accrued protocol fees for this market."
      ],
      "discriminator": [
        164,
        152,
        207,
        99,
        30,
        186,
        19,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "adminCollateral",
          "writable": true
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "docs": [
        "Create a new binary market. Permissionless: anyone may create one and",
        "nominate a `resolver` (the trusted oracle key for this market). The market",
        "id is the current `config.market_count`, which is then incremented."
      ],
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config.market_count",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
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
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "question",
          "type": "string"
        },
        {
          "name": "resolutionSource",
          "type": "string"
        },
        {
          "name": "resolutionTime",
          "type": "i64"
        },
        {
          "name": "resolver",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize the global config (one per deployment). `fee_bps` is the taker",
        "fee charged on `buy`/`sell` (e.g. 100 = 1%), capped at 10% (1000 bps)."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "admin",
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
          "name": "feeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "redeem",
      "docs": [
        "Redeem `amount` of the winning outcome token for `amount` collateral."
      ],
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "winningMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "userOutcome",
          "writable": true
        },
        {
          "name": "userCollateral",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "resolve",
      "docs": [
        "Resolve the market to a winning `outcome`. Only the market's `resolver`",
        "may call, and only at/after `resolution_time`."
      ],
      "discriminator": [
        246,
        150,
        236,
        206,
        108,
        63,
        58,
        10
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "resolver",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        }
      ]
    },
    {
      "name": "seedLiquidity",
      "docs": [
        "Seed the AMM with initial liquidity at 50/50 odds. Callable once, by the",
        "market creator, before any trading. Mints `amount` of each outcome into",
        "the pool and deposits `amount` collateral."
      ],
      "discriminator": [
        180,
        57,
        94,
        35,
        73,
        48,
        13,
        11
      ],
      "accounts": [
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true
        },
        {
          "name": "noMint",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "poolYes",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  121,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "poolNo",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  110,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "lpCollateral",
          "writable": true
        },
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sell",
      "docs": [
        "Sell `outcome` to withdraw `collateral_out` of collateral (gross). The",
        "trader returns outcome tokens to the pool, a full set is merged out, the",
        "taker fee is deducted, and the remainder is paid to the trader. Reverts if",
        "more than `max_tokens_in` outcome tokens would be required."
      ],
      "discriminator": [
        51,
        230,
        133,
        164,
        1,
        127,
        131,
        173
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.market_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true
        },
        {
          "name": "noMint",
          "writable": true
        },
        {
          "name": "poolYes",
          "writable": true
        },
        {
          "name": "poolNo",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true
        },
        {
          "name": "userOutcome",
          "docs": [
            "The trader's outcome-token account for the side being traded (validated in handler)."
          ],
          "writable": true
        },
        {
          "name": "userCollateral",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "collateralOut",
          "type": "u64"
        },
        {
          "name": "maxTokensIn",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    }
  ],
  "events": [
    {
      "name": "liquiditySeeded",
      "discriminator": [
        147,
        232,
        14,
        56,
        38,
        188,
        80,
        31
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "marketResolved",
      "discriminator": [
        89,
        67,
        230,
        95,
        143,
        106,
        199,
        202
      ]
    },
    {
      "name": "tradeExecuted",
      "discriminator": [
        41,
        110,
        64,
        129,
        60,
        79,
        179,
        80
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "feeTooHigh",
      "msg": "Fee exceeds the maximum (1000 bps)"
    },
    {
      "code": 6001,
      "name": "stringTooLong",
      "msg": "String exceeds maximum length"
    },
    {
      "code": 6002,
      "name": "marketNotOpen",
      "msg": "Market is not open for trading"
    },
    {
      "code": 6003,
      "name": "alreadySeeded",
      "msg": "Market has already been seeded with liquidity"
    },
    {
      "code": 6004,
      "name": "noLiquidity",
      "msg": "Market has no liquidity"
    },
    {
      "code": 6005,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6006,
      "name": "invalidOutcome",
      "msg": "Invalid outcome (must be 0=YES or 1=NO)"
    },
    {
      "code": 6007,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6008,
      "name": "wrongMint",
      "msg": "Wrong token mint for this account"
    },
    {
      "code": 6009,
      "name": "wrongOwner",
      "msg": "Wrong owner for this token account"
    },
    {
      "code": 6010,
      "name": "slippageExceeded",
      "msg": "Slippage tolerance exceeded"
    },
    {
      "code": 6011,
      "name": "insufficientLiquidity",
      "msg": "Insufficient liquidity for this trade"
    },
    {
      "code": 6012,
      "name": "notResolved",
      "msg": "Market has not been resolved yet"
    },
    {
      "code": 6013,
      "name": "tooEarlyToResolve",
      "msg": "Too early to resolve this market"
    },
    {
      "code": 6014,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6015,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "marketCount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "liquiditySeeded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "market",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "resolver",
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "yesMint",
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "poolYes",
            "type": "pubkey"
          },
          {
            "name": "poolNo",
            "type": "pubkey"
          },
          {
            "name": "reserveYes",
            "type": "u64"
          },
          {
            "name": "reserveNo",
            "type": "u64"
          },
          {
            "name": "lp",
            "type": "pubkey"
          },
          {
            "name": "lpShares",
            "type": "u64"
          },
          {
            "name": "collateral",
            "docs": [
              "Collateral backing outstanding full sets (excludes accrued fees)."
            ],
            "type": "u64"
          },
          {
            "name": "feeAccrued",
            "type": "u64"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "resolutionTime",
            "type": "i64"
          },
          {
            "name": "question",
            "type": "string"
          },
          {
            "name": "resolutionSource",
            "type": "string"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "u64"
          },
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "resolver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "marketResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "tradeExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "isBuy",
            "type": "bool"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "tokens",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
