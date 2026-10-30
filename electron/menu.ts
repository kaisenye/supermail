import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Electron's default menu binds ⌘W to Close Window, which would swallow the
 * close-tab shortcut before the renderer sees it. Same menus otherwise; the
 * window closes with ⇧⌘W. The Window menu is spelled out because its role
 * adds Close (⌘W) off macOS.
 */
export function installAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [{ role: 'close', accelerator: 'Shift+CmdOrCtrl+W' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
