# Tutorial: your first migration on calibration

This walks one CID end-to-end on the **calibration** testnet, so a mistake costs
testnet funds, not real ones. By the end you will have planned a piece, served
it, committed it on chain, and confirmed it with `report`. Each step prints
something you can check before moving on.

For the production flow and the knob settings behind it, see the
[README quickstart](../README.md#quickstart) and
[operator profiles](personas.md). This tutorial trades those choices for a fixed,
known-good path.

## Before you start

- **Node 26+** and ipfs2foc installed (`npm install -g ipfs2foc`, or
  `node packages/cli/src/index.ts` from a clone).
- A **calibration wallet** exported as `PRIVATE_KEY` (`0x` + 64 hex), funded with
  calibration FIL and USDFC. Run the one-time payer setup (deposit + approvals):

  ```bash
  export PRIVATE_KEY=0x...
  npx filecoin-pin@latest payments setup --auto --network calibration
  npx filecoin-pin@latest payments status --network calibration
  ```
- A **calibration provider id** from PDP Scan
  (`https://pdp.vxb.ai/calibration/providers`).
- One **public CID** that resolves over `trustless-gateway.link`. Any small file
  already on the public IPFS network works.

```bash
export PRIVATE_KEY=0x...
```

## 1. Confirm the gateway serves a deterministic CAR

```bash
ipfs2foc probe <sample-cid> --gateway https://trustless-gateway.link
```

Checkpoint: the line starts with `OK` and ends with `deterministic`. A `WARN`
means that gateway cannot be a source — pick another from [sources.md](sources.md).

## 2. Provision a data set

```bash
ipfs2foc create-data-set --provider-id <calibration-provider-id> --network calibration
```

Checkpoint: the output prints a `dataSetId`. Note it; the next steps reuse it.

## 3. Plan the CID

```bash
printf '%s\n' <sample-cid> > cids.txt
ipfs2foc plan --cids cids.txt --db migrate.db
```

Checkpoint: `Done. 1/1 pieces, 1 aggregate(s) -> migrate.db`. The next-step line
points you at `redirect-serve` and `pdp-submit`.

## 4. Serve the sub-piece (leave this terminal running)

```bash
ipfs2foc redirect-serve --db migrate.db --port 4322 --ingress cloudflared
```

Checkpoint: a log line `cloudflared ingress: ready at https://<words>.trycloudflare.com`.
Copy that URL. Confirm it from another network:

```bash
curl -I https://<words>.trycloudflare.com/healthz   # expect HTTP 200
```

## 5. Submit on chain (a second terminal)

```bash
ipfs2foc pdp-submit --db migrate.db --data-set-id <data-set-id> \
  --source-base https://<words>.trycloudflare.com --network calibration
```

Checkpoint: `committed 1 aggregate(s)` and an explorer link. The next-step line
points you at `report`.

## 6. Confirm it landed

```bash
ipfs2foc report --db migrate.db --data-set-id <data-set-id> --network calibration
```

Checkpoint: the report shows every CID accounted for and the data set live on
chain, and the command exits `0`. A non-zero exit means something is still
pending — re-read the report's error lines.

## What you proved

One CID is now committed as part of an on-chain piece, still retrievable over
IPFS by its original CID. To scale this up — multiple assets per piece, larger
catalogs, slower links — read [operator profiles](personas.md) and switch
`--network calibration` for `mainnet` once you trust the flow.
</content>
