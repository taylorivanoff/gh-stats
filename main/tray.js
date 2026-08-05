const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;
let trayHandlers = null;

function createTray(iconPath, handlers) {
  if (tray) return tray;
  trayHandlers = handlers;

  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createFromBuffer(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    );
  }
  if (process.platform === 'darwin') {
    image = image.resize({ width: 18, height: 18 });
    image.setTemplateImage(true);
  } else if (!image.isEmpty()) {
    image = image.resize({ width: 16, height: 16 });
  }

  tray = new Tray(image);
  tray.setToolTip('GhStats');
  updateTrayMenu(handlers);
  tray.on('click', () => handlers.showWindow());
  return tray;
}

function updateTrayMenu(handlers) {
  const h = handlers || trayHandlers;
  if (!tray || tray.isDestroyed() || !h) return;
  trayHandlers = h;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show GhStats', click: () => h.showWindow() },
    { label: 'Refresh data', click: () => h.refresh() },
    { type: 'separator' },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: !!h.getSettings().alwaysOnTop,
      click: (item) => h.setAlwaysOnTop(item.checked)
    },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => h.checkForUpdates?.() },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: () => h.quit() }
  ]));
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  trayHandlers = null;
}

function getIconPath() {
  return path.join(__dirname, '..', 'resources', 'icon.png');
}

module.exports = { createTray, updateTrayMenu, destroyTray, getIconPath };
