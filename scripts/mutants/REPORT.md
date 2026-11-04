# Mutants: Bellwether

Each mutant edits one payment or analytics branch of the change of 4 November 2026 (Use when descriptions, a Bazaar listing on every price, one Analytics Engine data point per answered call) and must Deny: npm test must fail with the edit applied. A copy with no edit passes first. Run: `node scripts/mutants/run.mjs`.

| Mutant | Defect | Result | First failing tests |
| --- | --- | --- | --- |
| B1 | a tool description without its price: the MCP line stops after the job | Deny | every tool description opens with Use when, then the job, then the price, under 300 characters, with no dash; the allowance a description names is the one the service applies |
| B2 | a priced API endpoint described without its price in its 402 | Deny | each priced API endpoint describes itself in its 402 with a Use when line and the price, as the OpenAPI file does |
| B3 | the Bazaar input schema dropped from every priced API route | Deny | every priced API route carries a Bazaar listing whose example its own schema accepts, as the facilitator checks |
| B4 | the MCP example arguments dropped from every metered tool | Deny | every metered MCP tool carries a Bazaar listing with example arguments its input schema accepts, and an example answer |
| B5 | the MCP example answer dropped from every metered tool | Deny | every metered MCP tool carries a Bazaar listing with example arguments its input schema accepts, and an example answer |
| B6 | the allowed values of an enum left out of the query schema | Deny | every priced API route carries a Bazaar listing whose example its own schema accepts, as the facilitator checks |
| B7 | an integer parameter listed as any string, with no digit pattern | Deny | every priced API route carries a Bazaar listing whose example its own schema accepts, as the facilitator checks |
| B8 | an example call the endpoint refuses with 400 instead of pricing | Deny | each priced API endpoint describes itself in its 402 with a Use when line and the price, as the OpenAPI file does; every priced API route carries a Bazaar listing whose example its own schema accepts, as the facilitator checks |
| B9 | a 402 challenge counted as a paid API call in analytics | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B10 | the paying wallet written to analytics as it is | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B11 | revenue counted on a refused API call | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B12 | a licensed MCP call recorded as paid | Deny | one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B13 | a licensed API call recorded as paid | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B14 | the analytics write throwing into the answer | Deny | without the binding nothing is written and nothing fails, and a write that throws never touches an answer |
| B15 | a paid MCP call not recorded in analytics | Deny | one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed |
| B16 | the payer hashed without the shared prefix, so no surface can match it | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed |
| B17 | the query written into the tool name of an API data point | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash; fuzz: no data point ever holds a wallet address, a query or a licence key |
| B18 | a free API call with the paid tier off recorded as refused | Deny | one data point per answered API call: challenged, paid, refused, licensed, free; the payer only as a hash |
| B19 | a free MCP call the tool refused recorded as free | Deny | one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed |
| B20 | the challenge past the allowance not recorded on MCP | Deny | one data point per answered tools/call: free within the allowance, challenged past it, paid, refused, licensed; fuzz: no data point ever holds a wallet address, a query or a licence key |

All 20 Deny.
