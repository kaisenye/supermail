import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, screen, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { flushPendingMoves, registerIpc, resumePendingMoves, runSyncFor } from './ipc.js'
import { registerTriageIpc } from './ipcTriage.js'
import { registerPowerIpc } from './ipcPower.js'
import { registerAiIpc } from './ipcAi.js'
import { installAppMenu } from './menu.js'
import { startReminderWorker } from './reminderWorker.js'
import { startHistoryWorker } from './historyWorker.js'
import { startAiWorker } from './aiWorker.js'
import { initDb } from '../src/core/store/db.js'
import { initAttachmentStore } from '../src/core/store/attachments.js'
import {
  displayNameFor,
  loadStoredAccounts,
  migrateEnvAccount
} from '../src/core/accounts/manage.js'
import { initVault } from '../src/core/accounts/vault.js'
import { onReauthRequired } from '../src/core/accounts/oauth.js'
import { getSettings, listAccounts as storedAccounts } from '../src/core/store/repo.js'
import { recordAiUsage, spentMicros } from '../src/core/store/ai.js'
import { initAi } from '../src/core/services/ai/index.js'
import { createAnthropicProvider } from '../src/core/services/ai/anthropic.js'
import { createOpenAiProvider } from '../src/core/services/ai/openai.js'
import { aiKey } from '../src/core/services/ai/keys.js'
import { onScheduledCancelled } from '../src/core/send/cancelOnReply.js'
import { startOutboxWorker } from '../src/core/send/flush.js'
import { restartIdleWatchers, stopIdleWatcher } from '../src/core/sync/idle.js'
import { closePool, dropIdleConnections } from '../src/core/sync/pool.js'
import { refreshSentFolder, startAccountWorkers, watchSentFolder } from './workers.js'
import { adoptLegacyData } from '../src/core/store/legacyData.js'
import { addAccount, getAccount, listAccounts, markNeedsReauth, setBootError } from './state.js'

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
  // First launch after the rename: bring over Supermail's mail and attachments.
  // Only into the default folder; a --user-data-dir run is a separate profile.
  const appData = app.getPath('appData')
  try {
    if (
      app.getPath('userData') === join(appData, app.getName()) &&
      adoptLegacyData(join(appData, 'Supermail'), app.getPath('userData'), 'sovo.db')
    )
      console.log('[boot] copied mail data from the Supermail folder')
  } catch (e) {
    console.error('[boot] copying Supermail data failed:', e)
  }
  initDb(join(app.getPath('userData'), 'sovo.db'))
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

/**
 * The AI service. Network calls happen only here, in main. The base-URL
 * overrides exist for QA against `pnpm ai:mock`; a packaged app ignores them.
 */
function startAi(): void {
  const override = (name: string): string | undefined =>
    app.isPackaged ? undefined : process.env[name] || undefined
  initAi({
    settings: getSettings,
    key: aiKey,
    usage: { spentMicros, record: recordAiUsage },
    providers: {
      anthropic: createAnthropicProvider({ baseURL: override('SOVO_ANTHROPIC_BASE_URL') }),
      openai: createOpenAiProvider({ baseURL: override('SOVO_OPENAI_BASE_URL') })
    }
  })
}

function createWindow(): void {
  // Most of the screen on first open, like other mail apps; never past it.
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(area.width, Math.max(1280, Math.round(area.width * 0.88))),
    height: Math.min(area.height, Math.max(820, Math.round(area.height * 0.9))),
    center: true,
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

  /*
   * A message body is untrusted HTML. Its frame is sandboxed, but a link that
   * escapes would replace the whole app with a web page and there is no way
   * back. Any navigation away from our own document opens in the real browser
   * instead; new windows are refused outright.
   */
  const isOwnPage = (url: string): boolean =>
    url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL &&
      url.startsWith(process.env.ELECTRON_RENDERER_URL))

  const openOutside = (url: string): void => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url)
  }

  win.webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url)) return
    e.preventDefault()
    openOutside(url)
  })
  // Subframes navigate separately; the message body is one. This event passes
  // one object carrying both the url and preventDefault.
  win.webContents.on('will-frame-navigate', (details) => {
    if (isOwnPage(details.url)) return
    details.preventDefault()
    openOutside(details.url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Matches dev's app name to productName, so dialogs and userData resolve the
 * same as a release. The Dock label still reads "Electron" — in dev we run
 * inside Electron's own .app and macOS takes it from that bundle's plist.
 */
function brandDevApp(): void {
  if (app.isPackaged) return
  app.setName('Sovo')
}

/** The Dock icon, unlike the name, can be replaced once the dock exists. */
function setDevDockIcon(): void {
  if (app.isPackaged) return
  const icon = join(__dirname, '../../build/icon.png')
  if (existsSync(icon)) app.dock?.setIcon(icon)
}

brandDevApp()
installCrashHandlers()

app.whenReady().then(() => {
  setDevDockIcon()
  boot()
  startAi()
  installAppMenu()
  registerIpc()
  registerTriageIpc()
  registerPowerIpc()
  registerAiIpc()
  // Google's Testing-mode refresh tokens expire after 7 days, and either
  // provider can revoke one. Tell the renderer which address needs a new
  // sign-in instead of letting sync fail silently.
  onReauthRequired((ref) => {
    const acct = storedAccounts().find((a) => a.auth_ref === ref)
    if (!acct) return
    // Workers start before the window exists, so the event alone can be lost;
    // the renderer also reads this flag from bootStatus.
    markNeedsReauth(acct.email)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('account:reauth', acct.email)
  })
  onScheduledCancelled((cancelled) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:cancelledOnReply', cancelled)
  })
  startOutboxWorker(
    (accountId) => getAccount(accountId)?.config ?? null,
    undefined,
    (f) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('send:failed', f)
    },
    (accountId, messageId) => {
      const acct = getAccount(accountId)
      if (acct) void refreshSentFolder(accountId, acct.config, messageId)
    }
  )
  startReminderWorker()
  startHistoryWorker()
  startAiWorker()
  // Every account gets its own warmed pool and parked IDLE connection, so mail
  // pushes for all of them rather than only whichever is on screen.
  for (const a of listAccounts()) {
    startAccountWorkers(a.config)
    watchSentFolder(a.accountId, a.config)
    resumePendingMoves(a.accountId, a.config)
  }
  startBackgroundSync()
  // The network is rarely back the instant the lid opens; a sync then would
  // just fail and flash the error banner. The renderer's 'online' covers the
  // case where it takes longer.
  powerMonitor.on('resume', () => setTimeout(() => reconnectAndSync('wake'), 2_500))
  ipcMain.on('net:online', () => reconnectAndSync('network back'))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * After sleep or a network change, every parked IDLE socket and pooled
 * connection may be half-open: they look connected, but pushes stop and the
 * next command waits out the socket timeout. Reconnect them all and sync every
 * account now instead of at the next poll.
 */
function reconnectAndSync(reason: string): void {
  console.log(`[sync] ${reason}: reconnecting and syncing`)
  restartIdleWatchers()
  dropIdleConnections()
  const windows = BrowserWindow.getAllWindows()
  for (const a of listAccounts()) {
    // A window syncs through its own path so the list repaints; with none
    // open (macOS keeps the app resident) sync here.
    if (windows.length) for (const w of windows) w.webContents.send('mail:new', a.email)
    else void runSyncFor({ ok: true, accountId: a.accountId, email: a.email, config: a.config })
  }
}

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
  // SQLite already shows these moved; don't strand them mid-undo-window.
  flushPendingMoves()
  void closePool()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
