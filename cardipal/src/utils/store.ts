import { invoke } from '@tauri-apps/api/core';
import type { StoreSnapshot } from '../types';

export interface StoreErrorPayload {
  code: string;
  message: string;
}

export type LoadResult = 
  | { status: 'success'; snapshot: StoreSnapshot; isReadOnly: boolean; warning: string | null }
  | { status: 'error'; snapshot: null; isReadOnly: true; warning: string };

export type SaveResult = 
  | { success: true }
  | { success: false; fatal: boolean; error: string; code: string };

export type OperationResult = 
  | { success: true }
  | { success: false; error: string; code: string };

function parseError(err: unknown): StoreErrorPayload {
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    return err as StoreErrorPayload;
  }
  return { code: 'UNKNOWN_ERROR', message: String(err) };
}

function requiresReadOnlyLock(code: string): boolean {
  const recoverableCodes = ['VALIDATION_ERROR', 'STALE_DATA', 'BUILT_IN_IMMUTABLE'];
  return !recoverableCodes.includes(code);
}

export async function loadUserData(): Promise<LoadResult> {
  try {
    const snapshot = await invoke<StoreSnapshot>('load_user_data');
    return { status: 'success', snapshot, isReadOnly: false, warning: null };
  } catch (err) {
    const parsed = parseError(err);
    return {
      status: 'error',
      snapshot: null,
      isReadOnly: true,
      warning: parsed.message,
    };
  }
}

export async function saveUserDataSnapshot(snapshot: StoreSnapshot): Promise<SaveResult> {
  try {
    await invoke('save_user_data', { snapshot });
    return { success: true };
  } catch (err) {
    const parsed = parseError(err);
    return { 
      success: false, 
      fatal: requiresReadOnlyLock(parsed.code), 
      error: parsed.message,
      code: parsed.code
    };
  }
}

export async function restoreBackup(): Promise<OperationResult> {
  try {
    await invoke('restore_storage');
    return { success: true };
  } catch (err) {
    const parsed = parseError(err);
    return { success: false, error: parsed.message, code: parsed.code };
  }
}

export async function resetStorageToDefaults(): Promise<OperationResult> {
  try {
    await invoke('reset_storage');
    return { success: true };
  } catch (err) {
    const parsed = parseError(err);
    return { success: false, error: parsed.message, code: parsed.code };
  }
}