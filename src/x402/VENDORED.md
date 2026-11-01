# Vendored: DAP Agent Payments library

These files are the x402 payment library from the Foundry payment edge, copied unchanged from `dap-foundry/edge/x402/src/lib` at commit `a449da0` (the commit that last changed them, "Agent endpoints, MCP relay and x402 payment edge"). The same code prices calls on foundry.dap.solutions in production.

Do not edit them here. Change the library in dap-foundry, where its 337 tests and relay mutants run, and copy it across again. Then update the hashes below. `test/vendored.test.mjs` fails if any file differs from its recorded hash.

Bellwether uses `env.ts` (settings), `gate.ts` and `mcp.ts` (x402 over MCP), and what they import. `adapters/` and `index.ts` are kept so the copy stays whole.

| File | SHA-256 |
| --- | --- |
| `adapters/cloudflare-pages.ts` | `8e3cac6ec6f21bdfa002f5e6f92a0796a8b759da1c3d595f6d8b59efb14741d0` |
| `adapters/fetch.ts` | `b5d07735164053527c8fb393bf77d31439c12854db507338aca4f6ab05020f48` |
| `cdp-auth.ts` | `e7632b70cecab2631b0df64ff462b623d9087e9454144bdd872e734cbfb17a87` |
| `codec.ts` | `2b71a3a68c5dcfb2444f9e03602ca9158b79fd44d4a40e725d9f1ebeb0d77f78` |
| `env.ts` | `f06c9f127f6410e964cfd986ef745a139e6c6586b9345bc40eeffb3438a1cb70` |
| `facilitator.ts` | `3e72996a82a74eeb6985dc254460ac81e1f1dd57ee8ee645f88cb52b51676c5f` |
| `gate.ts` | `2a3a267f9a76fa5c895de4af9f45561122b2fdd38767989507ffb382c3a761c3` |
| `index.ts` | `4cbe60e4810a9bdf3c42da8fb80adbc547a2586cd5e677c927a33542b3307faf` |
| `mcp.ts` | `99ca0bdbc04a12c2520ec95d28ddfdf7e4d762a72ddb96dd1503a69dc460fc7e` |
| `networks.ts` | `6a6ec07175206984dd5873a28f032d4dccbde4ada33c3736d7bdbc732803f5de` |
| `path.ts` | `50fee63e2b55d00f92fb6c2ff3b4becd17c28208959ed042bd0d9f5372dce9f8` |
| `payment.ts` | `7fd1eda8cd7f9e4f4c7502d36871ecdc226be51c6c8a25370bd2a56c9cda52a3` |
| `price.ts` | `3776bbb4268e8bb5327511ec8f05569a8ab2c37ca3439d4c2c93a8066b4605c6` |
| `replay.ts` | `51d9e4d2ef2401663ff21f6dc91abd00fb6bff4ab5c76ec911f950d15383d9fa` |
| `schemas.ts` | `6f728ffe90ff4432903d2cfe7cb4b584ff8f6ad002f39f077abb9156606aa13e` |
