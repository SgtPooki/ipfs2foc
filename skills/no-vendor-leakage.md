# No Vendor Leakage

**Trigger:** Writing any persistent file in the repo (code, docs, fixtures, test names).

## Rule

- Use generic role names: "source IPFS gateway", "IPFS pinning provider", "storage provider", "operator".
- Do not embed customer names or vendor product names in code, doc prose, fixture names, or test descriptions.
- Concrete public URLs are fine when the operator must paste them (e.g. `gateway.example.com/ipfs/<cid>`).
- If a vendor-specific quirk is the reason for a branch, document the technical behavior, not the brand.

## Examples

### Bad

```ts
// <vendor-product-name>'s gateway returns 502 sometimes
async function probe<VendorProductName>(cid: string) { ... }
```

```md
This tool migrates <customer-name> assets off <pinning-provider-name>.
```

### Good

```ts
// Source gateway can return 5xx under load; retry with backoff.
async function probeSourceGateway(cid: string) { ... }
```

```md
This tool migrates assets from an IPFS pinning provider to a Filecoin storage provider.
```

## Why

Vendor names in long-lived files leak operator identity, age badly when contracts change, and tie generic infrastructure code to a brand it does not depend on.
