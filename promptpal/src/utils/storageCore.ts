// Pure persistence coordinator. One writer per application process.
export interface FileIO {
  read(path: string): Promise<string | null>; // null ONLY when absent; throw on access errors
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export const FILES = ['promptpal-a.json', 'promptpal-b.json'] as const;
export const LEGACY = ['promptpal_data.json', 'promptpal_data.bak.json',
  'promptpal_data.bak.json.tmp', 'promptpal_data.corrupt.json'];
const MARKER = 'promptpal-reset.json';
export const OWNED_FILES = [...FILES, ...LEGACY, MARKER];
const digest = async (text: string) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
)).map(n => n.toString(16).padStart(2, '0')).join('');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function createStorage<T>(io: FileIO, defaults: T,
  validate: (value: unknown) => T, decodeLegacy: (value: unknown) => T) {
  let busy = false;
  let loaded = false;
  let readOnly = true;
  let current = clone(defaults);
  let active: string | null = null;
  let revision = 0;
  let initialization: Promise<{snapshot:T; isReadOnly:boolean; warning:string}> | null = null;

  async function decode(text: string) {
    const record = JSON.parse(text);
    if (!record || record.version !== 1 || !Number.isSafeInteger(record.revision) ||
        record.revision < 1 || typeof record.payload !== 'string' ||
        record.sha256 !== await digest(record.payload)) throw new Error('Invalid snapshot');
    return { snapshot: validate(JSON.parse(record.payload)), revision: record.revision as number };
  }
  async function persist(path: string, value: T, rev: number) {
    const payload = JSON.stringify(value);
    const text = JSON.stringify({version:1, revision:rev, payload, sha256:await digest(payload)});
    await io.write(path, text);
    if (await io.read(path) !== text) throw new Error('Write verification failed');
  }
  async function initialize() {
    if (await io.read(MARKER) !== null) {
      loaded = true;
      return { snapshot:clone(current), isReadOnly:true,
        warning:'A confirmed reset was interrupted. Saved data is locked. Retry Clear All Data to finish.' };
    }
    const candidates: {snapshot:T; revision:number; path:string}[] = [];
    let damaged = false;
    for (const path of FILES) {
      const text = await io.read(path);
      if (text === null) continue;
      try { candidates.push({...await decode(text), path}); }
      catch { damaged = true; }
    }
    candidates.sort((a,b) => b.revision - a.revision);
    if (candidates.length === 2 && candidates[0].revision === candidates[1].revision &&
        JSON.stringify(candidates[0].snapshot) !== JSON.stringify(candidates[1].snapshot)) {
      throw new Error('Conflicting snapshot revisions');
    }
    if (candidates.length) {
      const best = candidates[0]; current = best.snapshot; revision = best.revision; active = best.path;
    } else if (!damaged) {
      // Import only validated legacy data, without modifying the original files.
      for (const path of LEGACY.slice(0,2)) {
        const text = await io.read(path);
        if (text === null) continue;
        try { current = decodeLegacy(JSON.parse(text)); break; }
        catch { damaged = true; }
      }
    }
    loaded = true; readOnly = damaged;
    return {snapshot:clone(current), isReadOnly:readOnly, warning: damaged ?
      'Damaged saved data was detected. The last valid snapshot, if available, is usable in read-only mode. Files were not overwritten.' : ''};
  }
  const load = () => {
    if (!initialization) initialization = initialize().catch(() => {
      loaded = true; readOnly = true;
      return {snapshot:clone(current), isReadOnly:true,
        warning:'Saved data could not be read safely. Files were not changed. Check permissions or retry after restarting.'};
    });
    return initialization;
  };
  async function save(raw: unknown) {
    if (busy || !loaded || readOnly) return {success:false as const, fatal:readOnly,
      error:'Saving is unavailable while storage is busy, uninitialized, or read-only.'};
    busy = true;
    try {
      let next: T;
      try { next = clone(validate(raw)); }
      catch { return {success:false as const, fatal:false, error:'Invalid saved data. Nothing was written.'}; }
      if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
      const destination = active === FILES[0] ? FILES[1] : FILES[0];
      // Never write the active/last-verified snapshot.
      await persist(destination, next, revision + 1);
      active = destination; revision++; current = next;
      return {success:true as const};
    } catch {
      readOnly = true;
      return {success:false as const, fatal:true,
        error:'Save could not be verified. The previous snapshot was left untouched. Storage is now read-only; restart to inspect disk state.'};
    } finally { busy = false; }
  }
  async function reset() {
    if (busy) throw new Error('Storage is busy. Wait and try again.');
    if (!loaded) await load();
    busy = true; readOnly = true;
    try {
      // Persistent marker prevents interrupted reset from resurrecting old data.
      await io.write(MARKER, 'reset-confirmed');
      if (await io.read(MARKER) !== 'reset-confirmed') throw new Error('Reset marker failed');
      for (const path of [...FILES, ...LEGACY]) await io.remove(path);
      await persist(FILES[0], defaults, 1);
      await io.remove(MARKER);
      current = clone(defaults); active = FILES[0]; revision = 1; readOnly = false;
      initialization = Promise.resolve({snapshot:clone(current), isReadOnly:false, warning:''});
      return clone(current);
    } catch {
      throw new Error('Reset incomplete. Storage remains read-only. Retry Clear All Data. Some deletions may already have completed.');
    } finally { busy = false; }
  }
  return {load, save, reset};
}
