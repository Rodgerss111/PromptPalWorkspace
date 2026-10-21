import { getCurrentWindow } from '@tauri-apps/api/window';

let visibilityTarget = false;
let operationQueue: Promise<void> = Promise.resolve();
let requestEpoch = 0;

export async function requestVisibility(visible: boolean): Promise<void> {
  visibilityTarget = visible;
  const myEpoch = ++requestEpoch;

  operationQueue = operationQueue.then(async () => {
    // Drop the OS call entirely if a newer request arrived while queued
    if (requestEpoch !== myEpoch) return;

    const mainWindow = getCurrentWindow();
    try {
      if (visibilityTarget) {
        await mainWindow.show();
        await mainWindow.setFocus();
      } else {
        await mainWindow.hide();
      }
    } catch (err) {
      console.error("Visibility request failed:", err);
      // Only reconcile OS state if no newer request superseded this one
      if (requestEpoch === myEpoch) {
        try {
          visibilityTarget = await mainWindow.isVisible();
        } catch (fallbackErr) {
          console.error("Failed to reconcile:", fallbackErr);
        }
      }
    }
  });

  return operationQueue;
}

export async function toggleVisibility(): Promise<boolean> {
  const nextVisible = !visibilityTarget;
  await requestVisibility(nextVisible);
  return nextVisible;
}