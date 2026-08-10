import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { flushPendingMoves, registerIpc, runSyncFor } from './ipc.js'
import { initDb } from '../src/core/store/db.js'
import { initAttachmentStore } from '../src/core/store/attachments.js'
import {
  displayNameFor,
  loadStoredAccounts,
  migrateEnvAccount
} from '../src/core/accounts/manage.js'
import { initVault } from '../src/core/accounts/vault.js'
import { startOutboxWorker } from '../src/core/send/flush.js'
import { stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool } from '../src/core/sync/pool.js'
import { refreshSentFolder, startAccountWorkers } from './workers.js'
import { startSnoozeWorker, stopSnoozeWorker } from '../src/core/snooze/wake.js'
import { addAccount, getAccount, listAccounts, setBootError } from './state.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Without these, any throw outside a try/catch takes the whole app down with
 * no trace — which is how an IMAP socket timeout used to kill it. Mail is
 * already on disk, so staying up and reporting beats exiting.
 */
function installCrashHandlers(): void {
  const report = (kind: string, err: unknown): void => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[${kind}]`, message)
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('app:error', { kind, message })
    }
  }
  process.on('uncaughtException', (err) => report('uncaughtException', err))
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason))
  // A renderer crash leaves a blank window; reload once so it recovers.
  app.on('render-process-gone', (_e, contents, details) => {
    console.error('[render-process-gone]', details.reason)
    if (details.reason !== 'clean-exit') contents.reload()
  })
}

/** dev: repo root (cwd). packaged: userData, since the bundle is read-only. */
function envLocalPath(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), '.env.local')
    : join(process.cwd(), '.env.local')
}

function boot(): void {
  initDb(join(app.getPath('userData'), 'supermail.db'))
  initAttachmentStore(app.getPath('userData'))
  initVault(app.getPath('userData'))

  // Lift a legacy .env.local credential into the keychain once. Runs before
  // the load below so the migrated account appears in the same pass.
  try {
    migrateEnvAccount(envLocalPath())
  } catch (e) {
    console.error('[boot] .env.local migration failed:', e)
  }

  const stored = loadStoredAccounts((id) => displayNameFor(id))
  for (const { account, config } of stored) {
    addAccount({ accountId: account.id, email: account.email, config })
  }
  // No accounts is a normal first-run state, not a crash — the renderer shows
  // onboarding rather than an error.
  if (!stored.length) setBootError('no account connected')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Matches --bg so launch never flashes white before first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d10' : '#fcfcfb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      // Throttling stalls rAF while occluded, which stalls canvas rendering.
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

installCrashHandlers()

app.whenReady().then(() => {
  boot()
  registerIpc()
  startOutboxWorker(
    (accountId) => getAccount(accountId)?.config ?? null,
    undefined,
    (f) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:failed', f)
    },
    (accountId) => {
      const acct = getAccount(accountId)
      if (acct) void refreshSentFolder(accountId, acct.config)
    }
  )
  // Every account gets its own warmed pool and parked IDLE connection, so mail
  // pushes for all of them rather than only whichever is on screen.
  for (const a of listAccounts()) startAccountWorkers(a.config)
  startBackgroundSync()
  // Snoozed mail must return even with no window open, same as the outbox.
  startSnoozeWorker(
    (accountId) => getAccount(accountId)?.config ?? null,
    () => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('snooze:woke')
    }
  )
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Keeps mail current while no window is open.
 *
 * The renderer runs its own timer for the list on screen, but that dies with
 * the window — on macOS the app stays resident, so without this the mailbox
 * goes stale until the user reopens it and waits for a sync.
 */
function startBackgroundSync(): void {
  const INTERVAL_MS = 60_000
  // Guards against a slow pass overlapping the next tick; runSyncFor also has
  // its own per-account guard against the renderer's timer.
  let running = false
  setInterval(() => {
    if (running) return
    running = true
    void (async () => {
      try {
        for (const a of listAccounts()) {
          await runSyncFor({
            ok: true,
            accountId: a.accountId,
            email: a.email,
            config: a.config
          })
        }
      } finally {
        running = false
      }
    })()
  }, INTERVAL_MS)
}

app.on('before-quit', () => {
  // No argument: stops every account's watcher and pool.
  stopIdleWatcher()
  stopSnoozeWorker()
  // SQLite already shows these moved; don't strand them mid-undo-window.
  flushPendingMoves()
  void closePool()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
