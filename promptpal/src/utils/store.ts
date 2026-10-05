import { invoke } from '@tauri-apps/api/core';
import type { Template } from '../types';
export interface StoreSnapshot { customTemplates: Template[]; favoriteIds: string[]; theme:'dark'|'light' }
export async function loadUserData() {
  const snapshot = await invoke<StoreSnapshot>('load_user_data');
  return { status:'success' as const, snapshot, isReadOnly:false, warning:'' };
}
export async function saveUserDataSnapshot(snapshot: StoreSnapshot) {
  await invoke('save_user_data', { snapshot });
  return { success:true as const };
}
export async function resetStorageToDefaults() {
  await invoke('reset_storage');
  return { customTemplates:[], favoriteIds:[], theme:'light' as const };
}
