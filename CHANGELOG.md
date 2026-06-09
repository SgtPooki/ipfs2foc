# Changelog

## [0.2.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.1.0...ipfs2foc-v0.2.0) (2026-06-09)


### Features

* --source-relay to drive the shared relay ([ea3c850](https://github.com/SgtPooki/ipfs2foc/commit/ea3c85011b2db8460fc97e1a3001877a3b8dfee5))
* app computes commP from verified blocks ([f1932d7](https://github.com/SgtPooki/ipfs2foc/commit/f1932d7a9ac1627e1a94d71be94edf1658ef501c))
* **app:** stream one CAR per root in commP ([e14e8f8](https://github.com/SgtPooki/ipfs2foc/commit/e14e8f8dfea95329c83f457e1a76caf800ec3034))
* auto-convert CIDv0 to CIDv1 in the app ([ad08ecb](https://github.com/SgtPooki/ipfs2foc/commit/ad08ecb1afb7fbe883d9c9638b2039f237c13fe2))
* browser migration console + Pages CI ([d53d17a](https://github.com/SgtPooki/ipfs2foc/commit/d53d17a760ed025954598e8c6a1e67ccb1503509))
* CAR-stream block source, one request per root ([a7f3799](https://github.com/SgtPooki/ipfs2foc/commit/a7f3799290fe7fa6fffe053ea58dd94aabd559a5))
* confirm commit from chain when status lags ([78eea3c](https://github.com/SgtPooki/ipfs2foc/commit/78eea3c37c013d9497786cd53dcdc33c9e99a4c7))
* CSP and self-hosted fonts for the app ([d376d1e](https://github.com/SgtPooki/ipfs2foc/commit/d376d1e8dab9156bc1abcf4eb370f98a399c64d4))
* dashboard next-steps panel for on-chain commit ([55a40bb](https://github.com/SgtPooki/ipfs2foc/commit/55a40bb584288669e58e12c6be34a4c7885c12d2))
* default to trustless-gateway.link only ([ea7cbc5](https://github.com/SgtPooki/ipfs2foc/commit/ea7cbc58382c39983e96d167ba590e28eade6477))
* import browser run manifest into the DB ([12485be](https://github.com/SgtPooki/ipfs2foc/commit/12485be33659f6b82566f9e890bea85a18659bc9))
* one-click switch/add Calibration network ([c6e0102](https://github.com/SgtPooki/ipfs2foc/commit/c6e01027c3c70a7846948b2975666639e3681bb4))
* per-IP rate limit on relay pull path ([620f01c](https://github.com/SgtPooki/ipfs2foc/commit/620f01ccabfc964b4d938f5703212a6a7b505879))
* per-row retry with classified errors ([59080da](https://github.com/SgtPooki/ipfs2foc/commit/59080da444a9b2b3da568768281ecaca1fe85874))
* persist prepare run, resume on load ([5fb162b](https://github.com/SgtPooki/ipfs2foc/commit/5fb162b46c3c0a831e26505dfb108e92294e6619))
* redesign serve dashboard as an instrument panel ([dba6bf1](https://github.com/SgtPooki/ipfs2foc/commit/dba6bf1b78b2dff52750d35897ac75fe743a8232))
* retry cold gateway blocks in prepare ([31c8a93](https://github.com/SgtPooki/ipfs2foc/commit/31c8a936ae2abfbacfa208add2540f3255979d84))
* session key grant, storage, lifecycle ([700f371](https://github.com/SgtPooki/ipfs2foc/commit/700f37104352b12b215b70b968a4afa9eba51ec5))
* signing session panel with grant and revoke ([b51b7bb](https://github.com/SgtPooki/ipfs2foc/commit/b51b7bb60e994e7c2820571d1234af83bae88543))
* state-aware dashboard controls and gas-off label ([6316faf](https://github.com/SgtPooki/ipfs2foc/commit/6316faf77c4dc776506a37edc054c0a19f1350e7))
* stateless redirect relay for browser dApp ([40ef1c3](https://github.com/SgtPooki/ipfs2foc/commit/40ef1c363677e52a96133d023c3fc85eb3708cbc))
* submit driver with reload-safe resume ([01d9713](https://github.com/SgtPooki/ipfs2foc/commit/01d97139b8c631d3474249f7749b1b8af60d3f8c))
* submit panel with copies selector ([e3c2fa0](https://github.com/SgtPooki/ipfs2foc/commit/e3c2fa0c29a3f70077e5d8f8806ac040caf97e98))
* verified-fetch on the IPFS fallback path ([a43b08f](https://github.com/SgtPooki/ipfs2foc/commit/a43b08f7787ed3b400803dbc465c6ba728a18c54))
* wake lock and close guard during runs ([e76425f](https://github.com/SgtPooki/ipfs2foc/commit/e76425f325923519afcb8b0149ba7eb81b0f9171))
* wallet panel reads payment readiness ([339d61d](https://github.com/SgtPooki/ipfs2foc/commit/339d61d25bf6b6ca5527e735971f4910c0728d27))


### Bug Fixes

* build app as pnpm workspace for Pages CI ([e781d00](https://github.com/SgtPooki/ipfs2foc/commit/e781d009bb63a8be37893af7b5683c0e46eec687))
* don't drop worker request during WASM init ([9e9d3b1](https://github.com/SgtPooki/ipfs2foc/commit/9e9d3b1512b7e17286bdf76c4816d298d62bb67e))
* drop session duration below presign margin ([19b908b](https://github.com/SgtPooki/ipfs2foc/commit/19b908b4eb99d6ca2585a3a4e850180daa5a61c5))
* enable dashboard Start only when work is pending ([563a1ad](https://github.com/SgtPooki/ipfs2foc/commit/563a1ad0b6758b88680d1d916a6631acb8cd4a99))
* outlast slow commit confirmation ([4d58762](https://github.com/SgtPooki/ipfs2foc/commit/4d58762f590f90af098a6d501cb653d117c399d5))


### Performance Improvements

* hash commP in WASM workers off main thread ([e28d32b](https://github.com/SgtPooki/ipfs2foc/commit/e28d32ba1a88f0d1e00674917b82c9e2fa9fba34))
* lookahead CAR export for ipfs fallback ([2fc9146](https://github.com/SgtPooki/ipfs2foc/commit/2fc9146c457b462d7b50977d56818d9a6d14ef30))
* parallelize CID prep + throttle progress ([c881392](https://github.com/SgtPooki/ipfs2foc/commit/c8813927ccbc15dcfb6e0166c48072da2af9ac31))

## [0.1.0](https://github.com/SgtPooki/ipfs2foc/compare/ipfs2foc-v0.0.1...ipfs2foc-v0.1.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* full option C - INSERT-only, drop polymorphism

### Features

* add create-data-set command ([ab4f63e](https://github.com/SgtPooki/ipfs2foc/commit/ab4f63e251f2c7b548e7509e09b57e426b605501))
* analyze subcommand for persona match ([ed58793](https://github.com/SgtPooki/ipfs2foc/commit/ed58793b3969528c3ae0fadced4f261853088498))
* byte-serve assembled CARs and evict on commit ([d15e90e](https://github.com/SgtPooki/ipfs2foc/commit/d15e90e35ff695d51a7cd79d5a7a54c03aec86e3))
* cloudflared quick-tunnel ingress ([9e20786](https://github.com/SgtPooki/ipfs2foc/commit/9e207865e4ff103d45301b0644a2ecdcbfe994ac))
* example-led help, did-you-mean, next-step hints ([3f78b63](https://github.com/SgtPooki/ipfs2foc/commit/3f78b63c8648b461ccbbdbdafe3f7b4a6bac53a9))
* full option C - INSERT-only, drop polymorphism ([714b349](https://github.com/SgtPooki/ipfs2foc/commit/714b349202c35169b5b077656dc4a715d2207a53))
* helia fallback for source-gateway outages ([fdf3450](https://github.com/SgtPooki/ipfs2foc/commit/fdf3450aa939776c9cfb783e99457e91c795f396))
* node version preflight + test CI ([4e35db2](https://github.com/SgtPooki/ipfs2foc/commit/4e35db24e59a77fbec6bb1030b2a45253a6db92f))
* on-chain proof health and IPNI announcement check ([cf741db](https://github.com/SgtPooki/ipfs2foc/commit/cf741db180dd4e9afbaada4f73a6a43d179fecd6))
* option C wiring + atomic sub-piece + repack ([b9cfd6c](https://github.com/SgtPooki/ipfs2foc/commit/b9cfd6c8a356046b07c8fbb3b6188cb8ffae581f))
* pack-cars stage for multi-asset CARs ([8854c50](https://github.com/SgtPooki/ipfs2foc/commit/8854c50589f5d26bba38b7ba8d014d28c1c536c5))
* pre-submit min piece size guard ([42fab04](https://github.com/SgtPooki/ipfs2foc/commit/42fab04153e0d744173996f63a85653191ece20d)), closes [#17](https://github.com/SgtPooki/ipfs2foc/issues/17)
* report --verify HEAD-probes a sample, low-memory walk ([483f478](https://github.com/SgtPooki/ipfs2foc/commit/483f478eab0a94c0bee6cbde69812641eb501cdb))
* report full input accounting and --verify-gateway ([59f88dc](https://github.com/SgtPooki/ipfs2foc/commit/59f88dceb051d8c0a41ef21e5ccd1425f037d8f2))
* status --json + failure categories + pull-batch attempts ([68c1d60](https://github.com/SgtPooki/ipfs2foc/commit/68c1d60f999e5bc113ee8142a8ef3e9ed89afc4d))
* sub_pieces schema and member_sha256 ([8e76016](https://github.com/SgtPooki/ipfs2foc/commit/8e7601603a1af016b3dad7c264c45a1c35bab15a))
* validate numeric cli flags ([0fe7ce8](https://github.com/SgtPooki/ipfs2foc/commit/0fe7ce882b167eed63fad7394c80a10901c550c3))
* verify PiecesAdded event at commit time ([da7ed83](https://github.com/SgtPooki/ipfs2foc/commit/da7ed835dce3c7109e842bbad0d18a9a76303289))


### Bug Fixes

* addStatus must check addMessageOk and piecesAdded ([69a6686](https://github.com/SgtPooki/ipfs2foc/commit/69a6686479c8f746919e9f622fd3cbad20981635))
* bounded error listener + unlink partial CAR ([#14](https://github.com/SgtPooki/ipfs2foc/issues/14)) ([437a031](https://github.com/SgtPooki/ipfs2foc/commit/437a03114bfe7c434232168d78080db2f5a40e05))
* correct stale comments and log ([03639b7](https://github.com/SgtPooki/ipfs2foc/commit/03639b7af48b3267e6823440614a1037227c271c))
* dedup committed count + surface pack failures ([45c793f](https://github.com/SgtPooki/ipfs2foc/commit/45c793f5e355755824ddaa271b4d37fe93aa276e))
* drop webrtc from helia libp2p config ([#10](https://github.com/SgtPooki/ipfs2foc/issues/10)) ([f8a0473](https://github.com/SgtPooki/ipfs2foc/commit/f8a047303882e83e20e7c5414829dfb4d0f4e693))
* hand-build helia fallback to drop webrtc ([14e5c13](https://github.com/SgtPooki/ipfs2foc/commit/14e5c130073ed281bf51cd72a49c2f396850b383)), closes [#18](https://github.com/SgtPooki/ipfs2foc/issues/18)
* hardcode NO_PROVEN_EPOCH; constant has no getter ([71c1c75](https://github.com/SgtPooki/ipfs2foc/commit/71c1c755993f253a69c31e66480d62b42f7af6d8))
* lazy import helia to skip startup native binding ([0cf4eed](https://github.com/SgtPooki/ipfs2foc/commit/0cf4eed5eeb92583518010bf58157ce39e3ae5fb))
* make on-chain AddPieces at-most-once ([d379652](https://github.com/SgtPooki/ipfs2foc/commit/d379652044fb2ab6ef30bf15a1b1925c163f33d8))
* persist tx_hash + resume from receipt ([#12](https://github.com/SgtPooki/ipfs2foc/issues/12)) ([0ad681f](https://github.com/SgtPooki/ipfs2foc/commit/0ad681f3174769e61be535f01ee2425c92de4401))
* pin trustless-gateway CAR params ([ba4eb1f](https://github.com/SgtPooki/ipfs2foc/commit/ba4eb1fba7c44308f1bcc62f448c950f88f4b3b6))
* report bigint json + unaccountedOnChain ([#13](https://github.com/SgtPooki/ipfs2foc/issues/13)) ([cdf57b3](https://github.com/SgtPooki/ipfs2foc/commit/cdf57b3ee21668bc93c33496bdb446d1044ec281))
* report terminal CID states instead of pending ([c3b21da](https://github.com/SgtPooki/ipfs2foc/commit/c3b21dab5389c4fd7bdbac11b2160838a2740545))
* resume submitted and parked aggs ([377b398](https://github.com/SgtPooki/ipfs2foc/commit/377b3982de338c5d1718cdcf4cec765fb4d30d3c))
* set busy_timeout before WAL pragma ([#9](https://github.com/SgtPooki/ipfs2foc/issues/9)) ([a2a748c](https://github.com/SgtPooki/ipfs2foc/commit/a2a748c97593046406868acc6a391388ea80b530))
* stop silent data loss in pack/plan paths ([21b320c](https://github.com/SgtPooki/ipfs2foc/commit/21b320c015d15445f6766ee4c6fbb87266159915))
* typed network category for fetch errors ([#11](https://github.com/SgtPooki/ipfs2foc/issues/11)) ([db091e7](https://github.com/SgtPooki/ipfs2foc/commit/db091e76010b4a3097fc4c19ae7659bb5cd5c218))
