import { register, unregister } from '@tauri-apps/plugin-global-shortcut';

const activeBindings = new Set<string>();
let registrationQueue: Promise<{ success: boolean; error?: string; fatal?: boolean }> = Promise.resolve({ success: true });
let latestTriggerCallback: (() => void) | null = null;

export function registerGlobalShortcut(
  onTrigger: () => void,
  newShortcut: string = 'CommandOrControl+Shift+Space'
): Promise<{ success: boolean; error?: string; fatal?: boolean }> {
  latestTriggerCallback = onTrigger;

  registrationQueue = registrationQueue.then(async () => {
    if (activeBindings.has(newShortcut)) return { success: true };

    try {
      await register(newShortcut, (event) => {
        if (event.state === 'Pressed') {
          latestTriggerCallback?.();
        }
      });
      activeBindings.add(newShortcut);

      // Cleanup logic (protects future FR10 rebinding)
      const oldBindings = Array.from(activeBindings).filter(b => b !== newShortcut);
      for (const old of oldBindings) {
        try {
          await unregister(old);
          activeBindings.delete(old);
        } catch (cleanupErr) {
          try {
            await unregister(newShortcut);
            activeBindings.delete(newShortcut);
            return { success: false, error: 'Failed to clean up old shortcut. New registration safely rolled back.' };
          } catch (rollbackErr) {
            return { success: false, fatal: true, error: 'CRITICAL: Failed to remove old shortcut AND failed to rollback new shortcut. App restart required.' };
          }
        }
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Shortcut rejected by OS.' };
    }
  });

  return registrationQueue;
}

export function releaseGlobalShortcuts(): Promise<void> {
  registrationQueue = registrationQueue.then(async () => {
    const bindings = Array.from(activeBindings);
    for (const binding of bindings) {
      try {
        await unregister(binding);
      } catch {
      } finally {
        activeBindings.delete(binding);
      }
    }
    return { success: true };
  });

  return registrationQueue.then(() => undefined);
}

export function clearShortcutCallback(callback: () => void): Promise<void> {
  if (latestTriggerCallback === callback) {
    latestTriggerCallback = null;
  }

  return releaseGlobalShortcuts();
}