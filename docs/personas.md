# User personas for ipfs2foc

ipfs2foc moves already-pinned IPFS content onto Filecoin Onchain Cloud
through Curio's PDP pull. Different operators run it under different disk,
bandwidth, and time budgets. This doc maps those situations to concrete
knob settings so a new operator can pick a profile and go.

These profiles tune the headless CLI. For a small passthrough run, the
[hosted console](browser-console.md) needs none of these knobs; the
[local console](local-console.md) wraps the same machinery as the CLI
behind `ipfs2foc serve` and honors the same flags.

The two physical constraints that drive every recommendation here:

- **Disk free on the migrator host.** The default hosting path writes
  each assembled sub-piece CAR under `--car-store` (the **cached
  sub-piece** path). Files for an aggregate become eligible for deletion
  once that aggregate reaches `committed`. With per-aggregate eviction,
  peak disk is `--max-in-flight × --piece-size`, not the total job size.
- **Upload bandwidth from migrator to provider.** The provider's pull
  rate is the throughput floor. A slow upload pipe linearizes the job,
  no matter how many aggregates are queued.

Knobs referenced below:

- `--max-in-flight` (default `4`): aggregates in submission / pulling /
  parking at once. Peak disk scales with this.
- `--piece-size` (default `32 GiB`): aggregate size budget.
- `--pull-batch` (default `32`): sub-pieces requested per provider HTTP
  call.
- `--ingress` (default `funnel`): public HTTPS ingress in front of
  `redirect-serve`. Details in [`ingress.md`](./ingress.md).

Two sub-piece shapes are available:

- **Passthrough sub-piece** (default): one source CID per sub-piece,
  pulled straight from the gateway through `redirect-serve`'s 302. No
  CAR file on migrator disk. Produced by `plan`.
- **Assembled sub-piece**: many source CIDs concatenated into one
  multi-root CAR per sub-piece, stored under `--car-store` and served
  byte-for-byte during the provider pull. Produced by `pack-cars` after
  `plan --no-auto-pack`. Use when the provider's `Min Piece Size`
  exceeds individual source CIDs, or to drop the on-chain piece count.

## Choosing knobs in plain terms

Answer these in order and stop at the first match.

**How much spare disk does the migrator host have?**

- Less than 50 GiB free → `--max-in-flight 1`. Peak disk will be roughly
  one `--piece-size`. Use the cached path so the source gateway going
  down for a few minutes doesn't kill an in-flight pull.
- 50–200 GiB free → `--max-in-flight 1` or `2`. Comfortable headroom,
  one aggregate evicting while the next assembles.
- 200 GiB+ free → leave `--max-in-flight 4` (default). Peak disk
  approaches `4 × --piece-size`.

**How fast is the upload from migrator to provider?**

- Slow (home upload, < 50 Mbit) → `--max-in-flight 1` regardless of
  disk. Extra in-flight aggregates just sit on disk waiting for the
  pipe.
- Fast (gigabit, VPS, datacenter) → use whatever `--max-in-flight` your
  disk allows.

**How long will the job run?**

- Minutes → `--ingress cloudflared` is fine; the hostname is ephemeral
  but the job ends before it matters.
- Hours to days → `--ingress funnel` or a self-hosted reverse proxy, so
  the hostname is stable across the whole run.

**Are you packing multiple assets per sub-piece?**

Run the multi-asset path: `plan --no-auto-pack`, then `pack-cars
--car-store <dir>`. Assembled sub-piece CARs live on disk and are
served byte-for-byte during the provider pull, so a source-gateway
outage after assembly does not stall a pull. Per-aggregate eviction on
`committed` keeps peak disk at `--max-in-flight × --piece-size`.

If none of the above narrowed things down, the SMB / small studio
profile is the safe default: `--ingress funnel`, `--max-in-flight 1`,
defaults everywhere else.

## Persona matrix

| Persona | Assets | Total size | Disk free | Upload bw | Time tolerance | Source gateway reliance OK over | Ingress | Hosting path | `--max-in-flight` | `--piece-size` | `--pull-batch` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Laptop tester | 10–1000 | < 5 GiB | < 50 GiB | low (home upload) | one-shot, minutes to ~1 hour | minutes | `cloudflared` | passthrough sub-piece (default) | `1` | default | default |
| SMB / small studio | 10k–100k | 5–100 GiB | 100 GiB+ | medium (office or fiber home) | multi-hour, up to ~1 day | hours | `funnel` | passthrough, or assembled sub-piece when source CIDs are sub-MiB | `1`–`2` | default | default |
| Production migrator | 1M+ | TB-scale | 100–500 GiB (not TB) | high (VPS / cloud) | multi-day batch | days, with retry budget | `funnel` (long-lived `*.ts.net`) or VPS reverse proxy | assembled sub-piece, per-aggregate evict on `committed` | `4` (default) | default | default |
| Bandwidth-bound migrator | any | up to ~100 TB | as low as ~32 GiB | low (slow upload pipe) | multi-day to multi-week | days | `funnel` | assembled sub-piece, strict one-at-a-time | `1` | default | default |

"Hosting path" column maps to the sub-piece shape:

- **Passthrough sub-piece (single-asset, default).** One source CID per
  sub-piece. `redirect-serve` 302s the provider to the gateway CAR
  directly; no CAR file on migrator disk. Disk on the migrator is
  effectively zero in this mode and the matrix's hosting-path column is
  informational only.
- **Assembled sub-piece (multi-asset).** Many source CIDs concatenated
  into one CAR file under `--car-store`, served byte-for-byte during
  the provider pull. Disk-full fails loud and early; eviction on
  `committed` keeps peak disk bounded. Use when source CIDs sit below
  the provider's `Min Piece Size` or to drop the on-chain piece count.

## Laptop tester

One-line: someone trying ipfs2foc on a personal machine to confirm
it works end-to-end before committing real data to it.

### What setup looks like

```bash
# Public ingress with no account signup
brew install cloudflared

# Plan + submit a tiny batch
ipfs2foc plan --cids small-cid-list.txt --piece-size 32GiB
ipfs2foc redirect-serve --ingress cloudflared --port 4322 &
# logs print: cloudflared ingress: ready at https://<words>.trycloudflare.com

ipfs2foc pdp-submit \
  --source-base https://<words>.trycloudflare.com \
  --max-in-flight 1
```

A laptop tester wants the job to finish in one sitting. Keep
`--max-in-flight 1` so the upload pipe isn't fighting itself, and keep
the dataset small enough that the source gateway staying healthy for a few minutes
is not a real risk.

### Failure modes specific to this persona

- **Source gateway 429 or transient 5xx.** On a short job this almost always
  resolves on retry. If it doesn't, the job is small enough to re-run
  from scratch.
- **Cloudflare quick-tunnel hostname rotation.** The `*.trycloudflare.com`
  URL is tied to that `cloudflared` process. If the laptop sleeps or the
  process dies mid-job, the URL changes and in-flight pulls fail. Either
  keep the laptop awake or switch to Funnel for a stable hostname.
- **Laptop sleep mid-pull.** The provider's 2-minute idle timeout fires
  and the attempt restarts. After three attempts the sub-piece fails.
  Disable sleep for the duration of the test.

### When to switch personas

If your test job grows past ~1000 assets, ~5 GiB total, or starts taking
more than an hour, move to the SMB profile: switch ingress to `funnel`
for a stable hostname and budget for the source gateway recovering after a stumble.

## SMB / small studio

One-line: a small team migrating a real but bounded library (tens of
thousands of assets) onto FOC over a working day or two.

### What setup looks like

```bash
# One-time: Tailscale signed in, MagicDNS + HTTPS certs on, funnel attr granted.

ipfs2foc plan --cids assets.csv --piece-size 32GiB
ipfs2foc redirect-serve --port 4322 &       # default --ingress funnel
tailscale funnel --bg 4322
tailscale funnel status                              # note the *.ts.net URL

ipfs2foc pdp-submit \
  --source-base https://<machine>.<tailnet>.ts.net \
  --max-in-flight 1
```

When source CIDs sit below the provider's minimum piece size, this
persona switches to the multi-asset path (`plan --no-auto-pack` then
`pack-cars`) and lets per-aggregate eviction keep disk bounded at
roughly one aggregate's worth.

### Failure modes specific to this persona

- **Disk fills mid-job.** If `--car-store` lives on a partition shared
  with other workloads, an aggregate's worth of CAR bytes lands all at
  once. Watch free disk vs `--piece-size` and stay above one full
  `--piece-size` of headroom.
- **Source gateway flake stretching past minutes.** A 30-minute source-gateway outage on
  a multi-hour job hits the provider's retry budget (3 attempts per
  sub-piece, restart from byte 0 each time). Early-warning signal: pull
  attempts logging idle-timeout disconnects on a sub-piece that
  made progress earlier in the attempt.
- **Office router NAT quirks.** Funnel uses outbound QUIC, so most
  routers are fine, but aggressive UDP rate-limiting can throttle the
  ingress. Symptom: low and steady pull throughput regardless of upload
  link speed.

### When to switch personas

If the job grows past ~100 GiB total or you start running it across
multiple days, switch to the production-migrator profile. The key
differences are running on a host with stable power and network, and
raising `--max-in-flight` once you trust the disk headroom.

## Production migrator

One-line: an operator moving a large catalog (millions of assets,
TB-scale) on a VPS or cloud VM that has bandwidth but doesn't have a TB
of disk lying around for staging.

### What setup looks like

Run on a host with a public IP and a long-lived reverse proxy in front
of `:4322`. Funnel works here too if the VM is in your tailnet.

```bash
ipfs2foc plan --cids full-catalog.csv --piece-size 32GiB --no-auto-pack
ipfs2foc pack-cars --car-store /var/lib/ipfs2foc/cars --pack-target-size 512MiB
ipfs2foc redirect-serve --port 4322 &       # behind nginx/caddy on :443
ipfs2foc pdp-submit \
  --source-base https://migrate.example.com \
  --max-in-flight 4
```

Peak disk with defaults: `4 × 32 GiB ≈ 128 GiB`. Per-aggregate eviction
on `committed` keeps the working set at that ceiling for the lifetime of
the job, regardless of catalog size.

### Failure modes specific to this persona

- **`--car-store` partition undersized.** If peak disk lands above what
  the partition can hold, the assembly fails on write. Size the
  partition to `--max-in-flight × --piece-size` plus a small buffer.
- **Source gateway reliability over multi-day windows.** Multi-day jobs touch
  the source gateway enough times to hit the long tail of its error rate. The
  cached sub-piece path means once a sub-piece is assembled on disk, it
  survives the source gateway going down for that retry window. The risk is in the
  assembly phase, not the serve phase.
- **Provider-side admission caps.** Curio caps pending unique pieces at
  10 per client and 120 globally. If many sub-pieces submit in a burst
  and the provider's queue saturates, throughput plateaus. Symptom: pull
  starts lag behind submissions in the logs.
- **Eviction not firing.** If aggregates never reach `committed` (e.g. a
  payments setup issue), the cache grows without bound. Early-warning
  signal: `--car-store` free space monotonically dropping past one
  aggregate's worth.

### When to switch personas

If your upload pipe turns out to be the bottleneck and you're sitting on
a queue of assembled aggregates waiting to drain, drop to
`--max-in-flight 1` and run the bandwidth-bound profile. You'll use less
disk and finish at the same wall-clock time.

## Bandwidth-bound migrator

One-line: an operator with a slow upload pipe and tight disk, who needs
to migrate a lot of data by trickling one aggregate at a time.

The shape: with a slow upload, the provider drains aggregates serially
anyway. There's no benefit to staging four aggregates on disk if the
pipe can only ship one. Running `--max-in-flight 1` plus per-aggregate
eviction means peak disk is one `--piece-size` (~32 GiB), and total job
size is unbounded.

### What setup looks like

```bash
ipfs2foc plan --cids big-catalog.csv --piece-size 32GiB --no-auto-pack
ipfs2foc pack-cars --car-store /data/ipfs2foc/cars --pack-target-size 512MiB
ipfs2foc redirect-serve --port 4322 &       # funnel or cloudflared
ipfs2foc pdp-submit \
  --source-base https://<your-public-host> \
  --max-in-flight 1
```

With those settings, a host with ~50 GiB free disk can migrate a 100 TB
catalog over however many days the upload pipe needs.

### Failure modes specific to this persona

- **Eviction lag.** If the next aggregate starts assembling before the
  previous one is `committed` and evicted, peak disk briefly doubles.
  Either accept ~64 GiB peak headroom, or wait for the eviction signal
  before kicking the next submission.
- **Multi-day source-gateway window.** This persona's job lives on the source gateway for as
  long as the upload pipe takes to drain. Plan for the source gateway to have at
  least one bad hour per day and budget retry attempts accordingly.
- **Idle-timeout cascade.** A pull stuck on a slow upload pipe is
  indistinguishable from a stalled upstream to the provider. If the
  pipe drops below ~70 KB/s sustained, the provider's 2-minute idle
  timeout starts firing and attempts burn down to the 3-retry cap.
  Early-warning signal: sub-pieces failing after 3 attempts despite
  the source gateway being healthy.

### When to switch personas

If you upgrade the upload link and disk together, move to the production
profile and raise `--max-in-flight` back to the default. If you're
staying on the slow link, this is the right profile and there's nowhere
to go.

