/*
 * Drives the themed <select> in a real renderer to prove the kit responds to a pointer.
 *
 * The native element is layered over the visual trigger to keep focus and assistive-tech reach, which
 * means every press lands on the native element rather than the trigger. This checks the consequences
 * of that layering: a press on the shell opens the popup, a row commits its value, and the popup
 * animates out instead of vanishing.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.setPath('userData', path.join(__dirname, '..', 'dist', '.electron-select-smoke'));

const probe = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const select = document.querySelector('#terminal-theme');
  const shell = select.closest('.select');
  const listbox = [...document.querySelectorAll('.select__listbox')].find(
    (candidate) => candidate.previousElementSibling === null || true,
  );

  const press = (element) => {
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    element.dispatchEvent(new PointerEvent('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.dispatchEvent(new MouseEvent('click', init));
  };

  // What the pointer actually hits at the centre of the control.
  const rect = shell.getBoundingClientRect();
  const hitAtCentre = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );

  // 1. A press on whatever is topmost must open the popup.
  press(hitAtCentre);
  await sleep(40);
  const shellAfterPress = shell.dataset.open;
  const popup = [...document.querySelectorAll('.select__listbox')].find(
    (candidate) => candidate.dataset.open === 'true',
  );
  const openedPopupVisible = Boolean(popup) && !popup.hidden;
  const rowCount = popup ? popup.querySelectorAll('button').length : 0;

  // 2. Committing a row must change the native value and fire a real change event.
  let changeFired = false;
  select.addEventListener('change', () => { changeFired = true; }, { once: true });
  const originalValue = select.value;
  const target = popup
    ? [...popup.querySelectorAll('button')].find((row) => row.dataset.value !== originalValue)
    : undefined;
  const wanted = target ? target.dataset.value : undefined;
  if (target) press(target);
  await sleep(40);
  const committed = select.value === wanted;

  // 3. The dismissal must animate rather than blink: still on screen, marked closing, then gone.
  const closingMarked = popup ? popup.dataset.closing === 'true' : false;
  const stillOnScreenDuringExit = popup ? !popup.hidden : false;
  const exitAnimation = popup ? getComputedStyle(popup).animationName : '';
  await sleep(700);
  const hiddenAfterExit = popup ? popup.hidden : false;
  const closingCleared = popup ? popup.dataset.closing === undefined : false;

  // 4. Reopening after a full close must still work (the exit must not strand state).
  press(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  await sleep(40);
  const reopened = shell.dataset.open === 'true';

  return {
    changeFired,
    closingCleared,
    closingMarked,
    committed,
    exitAnimation,
    hiddenAfterExit,
    hitAtCentreIsNativeSelect: hitAtCentre === select,
    openedPopupVisible,
    reopened,
    rowCount,
    shellAfterPress,
    stillOnScreenDuringExit,
  };
})()
`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'preload.js'),
    },
    width: 1180,
  });

  await window.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const result = await window.webContents.executeJavaScript(probe, true);
  console.log(JSON.stringify(result, undefined, 2));

  const failures = [];
  if (!result.hitAtCentreIsNativeSelect) {
    failures.push('expected the native select to be the topmost element (the layering under test)');
  }
  if (result.shellAfterPress !== 'true') failures.push('a press did not open the popup');
  if (!result.openedPopupVisible) failures.push('the popup was not visible after opening');
  if (result.rowCount === 0) failures.push('the popup rendered no rows');
  if (!result.committed) failures.push('clicking a row did not change the native value');
  if (!result.changeFired) failures.push('clicking a row fired no change event');
  if (!result.closingMarked) failures.push('the dismissal was not marked as closing');
  if (!result.stillOnScreenDuringExit) failures.push('the popup blinked out instead of animating');
  if (result.exitAnimation !== 'selectListboxOut') {
    failures.push(`expected the exit keyframe, got "${result.exitAnimation}"`);
  }
  if (!result.hiddenAfterExit) failures.push('the popup never hid after its exit animation');
  if (!result.closingCleared) failures.push('the closing flag was left set');
  if (!result.reopened) failures.push('the select could not be reopened after closing');

  if (failures.length > 0) {
    console.error(`\nselect interaction FAILED:\n- ${failures.join('\n- ')}`);
    app.exit(1);
    return;
  }
  console.log('\nselect interaction OK');
  app.exit(0);
});
