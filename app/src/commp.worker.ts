// Module worker: runs one computePiece (fetch + CAR parse + WASM commP hash)
// off the main thread. One worker per in-flight CID, so concurrent CIDs hash on
// separate cores instead of time-slicing the UI thread — with the JS hasher on
// the main thread, four concurrent rows shared one core and each crawled.
//
// computePiece is loaded with a dynamic import, deliberately: the WASM fr32
// hasher in its import graph initializes with top-level await, and Chromium
// enables a module worker's message port at the first top-level-await
// suspension — a message posted before evaluation finishes is dropped, not
// queued, so the client's immediate postMessage never arrived and the worker
// idled forever. With the dynamic import this module evaluates synchronously,
// onmessage is registered before the port is enabled, and the request awaits
// the module promise instead.
import type { PieceResult } from './commp.ts'

const commp = import('./commp.ts')

// Progress is throttled here, not just in the UI: every postMessage crosses a
// thread boundary and a stream at hash speed would emit thousands per second.
const PROGRESS_INTERVAL_MS = 200

export interface WorkerRequest {
  gateway: string
  cid: string
  relayBase: string
}

export type WorkerResponse =
  | { type: 'progress'; bytes: number }
  | { type: 'done'; result: PieceResult }
  | { type: 'error'; message: string }

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { gateway, cid, relayBase } = e.data
  const post = (msg: WorkerResponse) => self.postMessage(msg)
  let lastEmit = 0
  try {
    const { computePiece } = await commp
    const result = await computePiece(gateway, cid, relayBase, (bytes) => {
      const now = performance.now()
      if (now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      post({ type: 'progress', bytes })
    })
    post({ type: 'done', result })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
