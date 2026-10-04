import { getCurrentWindow } from '@tauri-apps/api/window';

let desiredVisibility: 'visible' | 'hidden' = 'hidden';
let operationQueue: Promise<void> = Promise.resolve();

export function requestVisibility(visible: boolean): Promise<void> {
  desiredVisibility = visible ? 'visible' : 'hidden';

  const operation = async () => {
    const appWindow = getCurrentWindow();

    if (desiredVisibility === 'visible') {
      await appWindow.show();
      if (desiredVisibility !== 'visible') return;
      await appWindow.unminimize();

      if (desiredVisibility !== 'visible') return;
      await appWindow.setFocus();
    } else {
      await appWindow.hide();
    }
  };

  const currentOp = operationQueue.then(operation);
  operationQueue = currentOp.catch(() => {});
  return currentOp;
}