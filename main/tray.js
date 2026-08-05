const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;

function createTray(iconPath, handlers) {
  if (tray) return tray;

  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Windows tray requires a non-empty image; fall back to a 1×1 pixel.
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
  if (!tray || tray.isDestroyed()) return;
  const { app } = require('electron');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show GhStats', click: () => handlers.showWindow() },
    { label: 'Refresh data', click: () => handlers.refresh() },
    { type: 'separator' },
  {
      label: 'Always on Top',
      type: 'checkbox',
      checked: !!handlers.getSettings().alwaysOnTop,
      click: (item) => handlers.setAlwaysOnTop(item.checked)
    },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'Quit', click: () => handlers.quit() }
  ]));
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

function getIconPath() {
  return path.join(__dirname, '..', 'resources', 'icon.png');
}

module.exports = { createTray, updateTrayMenu, destroyTray, getIconPath };
