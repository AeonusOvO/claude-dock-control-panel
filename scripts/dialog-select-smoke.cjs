/*
 * Drives the themed <select> inside a modal <dialog>, which is where it broke.
 *
 * `showModal()` promotes the dialog to the browser's top layer and makes the rest of the document
 * inert, so a popup parented to `body` is painted underneath it and refuses the pointer — the control
 * looked like it had vanished. Neither a higher z-index nor the popover API escapes that, so this
 * checks the popup ends up inside the dialog and stays clickable.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-dialog-select-smoke'));

const probe = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  document.querySelector('#connection-advanced-dialog').showModal();
  await sleep(450);

  const select = document.querySelector('#settings-theme');
  const shell = select.closest('.select');
  const rect = shell.getBoundingClientRect();
  const init = {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };

  const hit = document.elementFromPoint(init.clientX, init.clientY);
  hit.dispatchEvent(new PointerEvent('pointerdown', init));
  hit.dispatchEvent(new MouseEvent('mousedown', init));
  await sleep(400);

  const popup = [...document.querySelectorAll('.select__listbox')].find(
    (candidate) => candidate.dataset.open === 'true',
  );
  if (!popup) return { opened: false };

  const style = getComputedStyle(popup);
  const rows = [...popup.querySelectorAll('button')];
  // A row buried under the dialog would hit-test to the dialog instead of to itself.
  const rowRect = rows[0].getBoundingClientRect();
  const rowHit = document.elementFromPoint(
    rowRect.left + rowRect.width / 2,
    rowRect.top + rowRect.height / 2,
  );

  // Committing through the popup must still drive the native element.
  let changeFired = false;
  select.addEventListener('change', () => { changeFired = true; }, { once: true });
  const target = rows.find((row) => row.dataset.value !== select.value);
  const wanted = target ? target.dataset.value : undefined;
  if (target) {
    const tr = target.getBoundingClientRect();
    const tinit = { bubbles: true, button: 0, cancelable: true, clientX: tr.left + tr.width / 2, clientY: tr.top + tr.height / 2 };
    target.dispatchEvent(new PointerEvent('pointerdown', tinit));
    target.dispatchEvent(new MouseEvent('mousedown', tinit));
    target.dispatchEvent(new MouseEvent('click', tinit));
  }
  await sleep(60);

  return {
    changeFired,
    committed: select.value === wanted,
    hostIsDialog: popup.parentElement.tagName === 'DIALOG',
    opened: true,
    // A themed popup, not the OS listbox: it paints from the theme's own surface token.
    popupBackground: style.backgroundColor,
    rowIsHittable: popup.contains(rowHit),
    rowCount: rows.length,
    visible: !popup.hidden,
  };
})()
`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'preload.js'),
    },
    width: 1280,
  });

  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1600));

  const result = await window.webContents.executeJavaScript(probe, true);
  console.log(JSON.stringify(result, undefined, 2));

  const failures = [];
  if (!result.opened) failures.push('the dropdown never opened inside the dialog');
  if (!result.visible) failures.push('the popup was not on screen');
  if (!result.hostIsDialog) {
    failures.push('the popup stayed outside the dialog, where the top layer buries it');
  }
  if (result.rowCount !== 4) failures.push(`expected 4 rows, got ${result.rowCount}`);
  if (!result.rowIsHittable) failures.push('a row was not clickable — something covers the popup');
  if (!result.committed) failures.push('clicking a row did not change the native value');
  if (!result.changeFired) failures.push('clicking a row fired no change event');

  if (failures.length > 0) {
    console.error(`\ndialog select FAILED:\n- ${failures.join('\n- ')}`);
    app.exit(1);
    return;
  }
  console.log('\ndialog select OK');
  app.exit(0);
});
