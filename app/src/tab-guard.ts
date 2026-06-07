// Keep-open affordances while a run is active (#23). Closing the tab is SAFE
// — prepare and submit state persist, and a reopened tab resumes without
// re-signing or re-submitting — but it pauses orchestration: providers finish
// in-flight pulls and already-submitted commits on their own, while new
// presigns and commit submissions wait for the tab to come back. These hooks
// make the common long run smoother: the screen stays awake while the user
// watches, and an accidental close gets a confirmation first.
import { useEffect } from 'react'

export function useTabLifetime(active: boolean): void {
  // Confirm before an accidental close while work is in flight. Browsers
  // show their own generic dialog; pages cannot customize the text.
  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])

  // Hold a screen wake lock while active so the machine does not sleep
  // mid-run. The platform releases the sentinel whenever the tab is hidden;
  // reacquire on return while the run is still going. Entirely best-effort —
  // browsers without the API or with power restrictions just decline.
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | null = null
    let stopped = false
    const acquire = async () => {
      try {
        const s = await navigator.wakeLock.request('screen')
        if (stopped) {
          void s.release().catch(() => null)
        } else {
          sentinel = s
        }
      } catch {
        // declined (hidden tab, battery saver) — nothing to do
      }
    }
    const onVisibility = () => {
      if (!stopped && document.visibilityState === 'visible') void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => null)
    }
  }, [active])
}
