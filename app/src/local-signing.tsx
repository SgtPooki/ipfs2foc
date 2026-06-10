/**
 * Signing panel for the local console (#25 Slice D). The wallet stays in the
 * browser: it signs one scoped on-chain grant (CreateDataSet + AddPieces,
 * explicit expiry), and the resulting session key is handed to the loopback
 * daemon, which signs presigns and drives pull/add itself. After the
 * handover the browser is a status view again — the tab can close.
 *
 * The handover POST carries raw key material over the same-origin loopback
 * connection. The real security boundary is the on-chain authorization
 * (minimal scope, expiry, revoke), same framing as session-store.ts.
 */

import { useCallback, useEffect, useState } from 'react'
import { fmtToken, type PaymentsStatus, readPaymentsStatus, readyToSign } from './payments.ts'
import {
  DEFAULT_SESSION_DURATION_SECONDS,
  extendSession,
  grantSession,
  resumeSession,
  revokeSession,
  SESSION_DURATIONS,
  type SessionState,
  sessionCanPresign,
} from './session.ts'
import {
  connectWallet,
  NETWORKS,
  type NetworkKey,
  networkOf,
  refreshWallet,
  switchToNetwork,
  type WalletState,
} from './wallet.ts'

export interface ServerSessionInfo {
  present: boolean
  sessionAddress?: string
  expiresAt?: number
  valid?: boolean
}

function short(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

function fmtExpiry(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Led({ on, color }: { on: boolean; color: string }) {
  return <span className="led" style={{ background: on ? color : 'transparent', borderColor: color }} />
}

export default function LocalSigningPanel({
  apiBase,
  network,
  panelNo,
  serverSession,
  onChanged,
}: {
  apiBase: string
  network: NetworkKey
  panelNo: string
  serverSession: ServerSessionInfo | null | undefined
  onChanged: () => void
}) {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [payments, setPayments] = useState<PaymentsStatus | null>(null)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [paymentsError, setPaymentsError] = useState<string | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionDuration, setSessionDuration] = useState<bigint>(DEFAULT_SESSION_DURATION_SECONDS)

  const walletNetwork = wallet == null ? null : networkOf(wallet.chainId)
  const onNetwork = walletNetwork === network

  const connect = useCallback(async () => {
    setWalletError(null)
    try {
      setWallet(await connectWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const switchNet = useCallback(async () => {
    setWalletError(null)
    try {
      await switchToNetwork(network)
      setWallet(await refreshWallet())
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : String(err))
    }
  }, [network])

  // Payment-readiness reads — nothing is signed; re-read on wallet changes.
  useEffect(() => {
    setPayments(null)
    setPaymentsError(null)
    setPaymentsLoading(false)
    if (wallet == null) return
    const net = networkOf(wallet.chainId)
    if (net == null) return
    let stale = false
    setPaymentsLoading(true)
    readPaymentsStatus(wallet.address, net)
      .then((s) => {
        if (!stale) setPayments(s)
      })
      .catch((err) => {
        if (!stale) setPaymentsError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!stale) setPaymentsLoading(false)
      })
    return () => {
      stale = true
    }
  }, [wallet])

  // Restore a stored session for this wallet+network (covers reload-mid-grant:
  // chain reads are authoritative and a dead record wipes itself).
  useEffect(() => {
    setSession(null)
    setSessionError(null)
    if (wallet == null || networkOf(wallet.chainId) !== network) return
    let stale = false
    resumeSession(wallet, network)
      .then((s) => {
        if (!stale && s != null) setSession(s)
      })
      .catch(() => {
        // resume is best-effort; the grant flow re-offers
      })
    return () => {
      stale = true
    }
  }, [wallet, network])

  const handToServer = useCallback(
    async (s: SessionState, w: WalletState) => {
      const res = await fetch(`${apiBase}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionPrivateKey: s.privateKey,
          root: w.address,
          chainId: NETWORKS[network].id,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `the daemon rejected the session (${res.status})`)
      }
      onChanged()
    },
    [apiBase, network, onChanged]
  )

  const grant = useCallback(async () => {
    if (wallet == null) return
    setSessionError(null)
    setSessionBusy('granting…')
    try {
      const s = await grantSession(wallet, network, sessionDuration, () => setSessionBusy('confirming grant…'))
      setSession(s)
      setSessionBusy('sending to daemon…')
      await handToServer(s, wallet)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, network, sessionDuration, handToServer])

  const resend = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('sending to daemon…')
    try {
      await handToServer(session, wallet)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session, handToServer])

  const extend = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('extending…')
    try {
      const s = await extendSession(wallet, network, session, sessionDuration, () =>
        setSessionBusy('confirming extension…')
      )
      setSession(s)
      // Refresh the daemon's cached expiry too (it also re-reads the chain
      // mid-run, so this is belt-and-suspenders for the status display).
      await handToServer(s, wallet)
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session, network, sessionDuration, handToServer])

  const revoke = useCallback(async () => {
    if (wallet == null || session == null) return
    setSessionError(null)
    setSessionBusy('revoking…')
    try {
      await revokeSession(wallet, network, session, () => setSessionBusy('confirming revoke…'))
      setSession(null)
      await fetch(`${apiBase}/session`, { method: 'DELETE' }).catch(() => null)
      onChanged()
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(null)
    }
  }, [wallet, session, network, apiBase, onChanged])

  const daemonHasSession =
    serverSession?.present === true &&
    serverSession.valid === true &&
    serverSession.sessionAddress === session?.sessionAddress
  const remaining = session == null ? null : Number(session.expiresAt) - Math.floor(Date.now() / 1000)
  const nudgeExtend = remaining != null && remaining < 6 * 3600

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-no">{panelNo}</span>
        <h2>Signing</h2>
        <span className="panel-note">grant a scoped key — the daemon submits, this tab can close</span>
      </div>
      <div className="wallet-row">
        {wallet == null ? (
          <button className="btn primary" onClick={() => void connect()} type="button">
            Connect wallet
          </button>
        ) : (
          <div className="wallet-on">
            <Led color={onNetwork ? 'var(--ok)' : 'var(--warn)'} on />
            <code className="addr">{short(wallet.address, 8, 6)}</code>
            <span className={`chip ${onNetwork ? 'chip-ok' : 'chip-warn'}`}>
              {walletNetwork ? NETWORKS[walletNetwork].label : `chain ${wallet.chainId}`}
            </span>
            {!onNetwork && (
              <>
                <button className="btn small" onClick={() => void switchNet()} type="button">
                  Switch to {NETWORKS[network].label}
                </button>
                <span className="hint">the daemon runs {network} — signing needs the wallet on the same network</span>
              </>
            )}
          </div>
        )}
        {walletError && <span className="err-text">{walletError}</span>}
      </div>
      {wallet != null && onNetwork && (
        <div className="pay-status">
          {paymentsLoading ? (
            <span className="dim">reading payment status…</span>
          ) : paymentsError == null ? (
            payments == null ? null : (
              <>
                <span className="pay-label">wallet</span>
                <span className="pay-value">
                  {fmtToken(payments.fil, network === 'calibration' ? 'tFIL' : 'FIL')} ·{' '}
                  {fmtToken(payments.walletUsdfc, 'USDFC')}
                </span>
                <span className="pay-label">deposited</span>
                <span className="pay-value">
                  {fmtToken(payments.depositedUsdfc, 'USDFC')} ({fmtToken(payments.availableUsdfc, 'USDFC')} available)
                </span>
                <span className="pay-label">storage operator</span>
                <span className="pay-value">
                  <Led color={payments.operatorApproved ? 'var(--ok)' : 'var(--warn)'} on />{' '}
                  {payments.operatorApproved ? 'approved' : 'not approved'}
                </span>
                {!readyToSign(payments) && (
                  <span className="pay-setup">
                    signing needs a one-time payment setup: deposit USDFC into Filecoin Pay and approve the storage
                    service as a payments operator —{' '}
                    <a
                      href="https://github.com/SgtPooki/ipfs2foc#network-gas-and-payments"
                      rel="noreferrer"
                      target="_blank"
                    >
                      setup guide
                    </a>
                  </span>
                )}
                {readyToSign(payments) && (
                  <>
                    <span className="pay-label">signing session</span>
                    {session == null ? (
                      <span className="pay-value session-controls">
                        <select
                          disabled={sessionBusy != null}
                          onChange={(e) => setSessionDuration(BigInt(e.target.value))}
                          value={sessionDuration.toString()}
                        >
                          {SESSION_DURATIONS.map((d) => (
                            <option key={d.label} value={d.seconds.toString()}>
                              {d.label}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn small"
                          disabled={sessionBusy != null}
                          onClick={() => void grant()}
                          type="button"
                        >
                          Enable signing
                        </button>
                      </span>
                    ) : (
                      <span className="pay-value session-controls">
                        <Led color={sessionCanPresign(session) ? 'var(--ok)' : 'var(--warn)'} on />
                        <code className="addr">{short(session.sessionAddress, 8, 6)}</code>
                        <span className="dim">until {fmtExpiry(session.expiresAt)}</span>
                        {daemonHasSession ? (
                          <span className="chip chip-ok">daemon holds session</span>
                        ) : (
                          <button
                            className="btn small"
                            disabled={sessionBusy != null}
                            onClick={() => void resend()}
                            type="button"
                          >
                            Send to daemon
                          </button>
                        )}
                        <button
                          className="btn small"
                          disabled={sessionBusy != null}
                          onClick={() => void extend()}
                          type="button"
                        >
                          Extend
                        </button>
                        <button
                          className="btn small"
                          disabled={sessionBusy != null}
                          onClick={() => void revoke()}
                          type="button"
                        >
                          Revoke
                        </button>
                      </span>
                    )}
                    {nudgeExtend && session != null && (
                      <span className="pay-setup">
                        the session expires soon — extending now keeps a running submit going (the daemon re-checks the
                        chain; no resubmit needed)
                      </span>
                    )}
                  </>
                )}
              </>
            )
          ) : (
            <span className="err-text">{paymentsError}</span>
          )}
        </div>
      )}
      {sessionBusy && <p className="dim">{sessionBusy}</p>}
      {sessionError && <p className="err-text">{sessionError}</p>}
    </section>
  )
}
