import { exists, mkdir, readTextFile, writeTextFile, remove, BaseDirectory } from '@tauri-apps/plugin-fs';
import { starterTemplates } from '../data/templates';
import { validateTemplateBlueprint } from './builder';
import { createStorage } from './storageCore';
import type { Template } from '../types';
export interface StoreSnapshot { customTemplates: Template[]; favoriteIds: string[]; theme:'dark'|'light' }
const options = {baseDir:BaseDirectory.AppData};
const defaults: StoreSnapshot = {customTemplates:[], favoriteIds:[], theme:'light'};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function requireValid(condition: unknown): asserts condition { if (!condition) throw new Error('Invalid snapshot'); }
function validate(raw: unknown): StoreSnapshot {
  requireValid(object(raw));
  requireValid(Object.keys(raw).sort().join(',') === 'customTemplates,favoriteIds,theme');
  requireValid(Array.isArray(raw.customTemplates) && Array.isArray(raw.favoriteIds));
  requireValid(raw.theme === 'dark' || raw.theme === 'light');
  const ids = new Set(starterTemplates.map(t => t.id));
  for (const t of raw.customTemplates) {
    requireValid(object(t));
    requireValid(Object.keys(t).sort().join(',') ===
      'category,contextText,createdAt,formatText,id,isBuiltIn,name,schemaVersion,taskText,updatedAt,variables');
    for (const key of ['id','name','category','contextText','taskText','formatText']) requireValid(typeof t[key] === 'string');
    requireValid((t.id as string).trim() && (t.name as string).trim() && !ids.has(t.id as string));
    requireValid(t.schemaVersion === 1 && t.isBuiltIn === false);
    requireValid(typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) && t.createdAt >= 0);
    requireValid(typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt) && t.updatedAt >= t.createdAt);
    requireValid(Array.isArray(t.variables));
    for (const v of t.variables) {
      requireValid(object(v));
      requireValid(Object.keys(v).sort().join(',') === 'defaultValue,label,name,required');
      requireValid(typeof v.name === 'string' && typeof v.label === 'string' &&
        typeof v.defaultValue === 'string' && typeof v.required === 'boolean');
    }
    requireValid(validateTemplateBlueprint(t as unknown as Template).success);
    ids.add(t.id as string);
  }
  const favorites = new Set<string>();
  for (const id of raw.favoriteIds) {
    requireValid(typeof id === 'string' && ids.has(id) && !favorites.has(id)); favorites.add(id);
  }
  return JSON.parse(JSON.stringify(raw)) as StoreSnapshot;
}
const engine = createStorage({
  async read(path) { return await exists(path, options) ? readTextFile(path, options) : null; },
  async write(path, text) { 
    await mkdir('.', { ...options, recursive: true });
    await writeTextFile(path, text, options); 
  },
  async remove(path) { if (await exists(path, options)) await remove(path, options); }
}, defaults, validate, raw => {
  requireValid(object(raw));
  requireValid(Object.keys(raw).sort().join(',') === 'favoriteTemplateIds,templates,theme');
  return validate({customTemplates:raw.templates, favoriteIds:raw.favoriteTemplateIds, theme:raw.theme});
});
export async function loadUserData() {
  const result = await engine.load();
  return {status:'success' as const, ...result};
}
export const saveUserDataSnapshot = engine.save;
export const resetStorageToDefaults = engine.reset;
