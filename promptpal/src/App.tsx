import { TemplateBuilder, type BuilderSession } from './components/TemplateBuilder';
import { useState, useRef, useCallback, useEffect, useMemo, useReducer } from 'react';
import { PromptEditor } from './components/PromptEditor';
import { TemplateLibrary } from './components/TemplateLibrary';
import { loadUserData, saveUserDataSnapshot, restoreBackup, resetStorageToDefaults } from './utils/store';
import { clearShortcutCallback, registerGlobalShortcut, releaseGlobalShortcuts } from './utils/shortcut';
import { requestVisibility } from './utils/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Template, SessionState, Preferences, StoreSnapshot } from './types';
import './App.css';

type ConfirmState = {
  message: string;
  onConfirm: () => void;
};

type ProbeStatusStr = 'Complete' | 'Partial' | 'RestrictedTarget' | 'UnauthorizedProcess' | 'ElevatedTarget' | 'TargetDrift' | 'PropertyQueryFailed' | 'TargetVerificationFailed' | 'ProcessAccessDenied' | 'FocusQueryFailed' | 'UiaInstantiationFailed' | 'ComInitializationFailed' | 'Busy' | 'ThreadCommunicationFailed' | 'ThreadSpawnFailed' | 'Timeout';
type TargetProbeResult = {
  status: ProbeStatusStr;
  process_path: string | null;
  class_name: string | null;
  control_type: number | null;
  framework_id: string | null;
  automation_id: string | null;
  aria_role: string | null;
  is_keyboard_focusable: boolean | null;
  has_value_pattern: boolean | null;
  has_text_pattern: boolean | null;
};

const ENABLE_UIA_DIAGNOSTICS = import.meta.env.DEV && import.meta.env.VITE_UIA_DIAGNOSTICS === 'true';

export type SessionAction =
  | { type: 'START_MANUAL'; session: SessionState; input: string }
  | { type: 'UPDATE_INPUT'; value: string }
  | { type: 'UPDATE_EDITOR'; template: Template }
  | { type: 'UPDATE_VARIABLES'; values: Record<string, string> }
  | { type: 'SET_BUILDER_SESSION'; builderSession: BuilderSession | null }
  | { type: 'SET_COPY_FEEDBACK'; value: string }
  | { type: 'CLEAR' };

export interface WorkflowState {
  session: SessionState | null;
  manualInput: string;
  draftTemplate: Template | null;
  draftVariables: Record<string, string>;
  builderSession: BuilderSession | null;
  copyFeedback: string;
}

export const initialWorkflowState: WorkflowState = {
  session: null,
  manualInput: '',
  draftTemplate: null,
  draftVariables: {},
  builderSession: null,
  copyFeedback: '',
};

export function reduceWorkflow(state: WorkflowState, action: SessionAction): WorkflowState {
  switch (action.type) {
    case 'START_MANUAL':
      if (state.session !== null) return state;
      return { ...state, session: action.session, manualInput: action.input };
    case 'UPDATE_INPUT':
      if (state.session !== null) return state;
      return { ...state, manualInput: action.value };
    case 'UPDATE_EDITOR':
      return { ...state, draftTemplate: action.template };
    case 'UPDATE_VARIABLES':
      return { ...state, draftVariables: action.values };
    case 'SET_BUILDER_SESSION':
      return { ...state, builderSession: action.builderSession };
    case 'SET_COPY_FEEDBACK':
      return { ...state, copyFeedback: action.value };
    case 'CLEAR':
      return initialWorkflowState;
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown session action: ${String(exhaustive)}`);
    }
  }
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  const [viewState, setViewState] = useState<'capture' | 'library' | 'editor' | 'builder'>('capture');
  const [focusRequested, setFocusRequested] = useState(false);

  const workflowRef = useRef(initialWorkflowState);
  const [workflow, rawDispatchWorkflow] = useReducer(reduceWorkflow, initialWorkflowState);
  const { session, manualInput, draftTemplate, draftVariables, builderSession, copyFeedback } = workflow;
  const sessionRef = useRef<SessionState | null>(null);
  
  const [customTemplates, setCustomTemplates] = useState<Template[]>([]);
  const builtInTemplatesRef = useRef<Template[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const dataRevisionRef = useRef<number>(1);
  const preferencesRef = useRef<Preferences | null>(null);

  const [isReadOnly, setIsReadOnly] = useState(false);
  const [initStatus, setInitStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('loading');
  const [initError, setInitError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const storageBusy = useRef(false);

  const [pendingAction, setPendingAction] = useState<'Prompt' | 'Original' | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const isWriting = useRef<boolean>(false);
  const draftId = useRef<number>(0);
  const feedbackTimer = useRef<number | null>(null);
  const isMounted = useRef<boolean>(true);
  const currentActivationId = useRef<number>(0);

  const dispatchWorkflow = useCallback((action: SessionAction) => {
    if (action.type === 'CLEAR' && isWriting.current) {
      setGlobalError('Please wait for the clipboard operation to finish before clearing.');
      return; 
    }

    const nextState = reduceWorkflow(workflowRef.current, action);
    workflowRef.current = nextState;
    sessionRef.current = nextState.session;
    
    if (action.type === 'CLEAR') {
      setGlobalError(null);
      setViewState('capture');
      setPendingAction(null);
      draftId.current += 1;
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
    }
    rawDispatchWorkflow(action);
  }, []);

  const allTemplates = useMemo(() => [...builtInTemplatesRef.current, ...customTemplates], [customTemplates]);

  const requestConfirmation = useCallback((message: string, onConfirm: () => void) => {
    setConfirmState({ message, onConfirm });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadUserData().then(result => {
      if (cancelled) return;
      if (result.status === 'success') {
        const snap = result.snapshot;
        builtInTemplatesRef.current = snap.templates.filter(t => t.isBuiltIn);
        setCustomTemplates(snap.templates.filter(t => !t.isBuiltIn));
        setFavoriteIds(snap.preferences.favoriteTemplateIds);
        preferencesRef.current = snap.preferences;
        dataRevisionRef.current = snap.preferences.dataRevision;
        setIsReadOnly(false);
        setInitStatus('success');
      } else {
        setIsReadOnly(true);
        setInitError(result.warning);
        setInitStatus('error');
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    document.body.className = theme === 'dark' ? 'dark-theme' : 'light-theme';
  }, [theme]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unlistenSingleInstance: (() => void) | undefined;

    const handleShortcutTriggered = async () => {
      const activationId = ++currentActivationId.current;
      const isActive = () => isMounted && currentActivationId.current === activationId;

      if (sessionRef.current !== null) {
        requestVisibility(true).then(() => {
          if (isActive()) {
            setGlobalError('Active draft exists. Clear your session to capture new text.');
            setFocusRequested(false);
          }
        }).catch(() => {
          if (isActive()) setGlobalError('Failed to coordinate window visibility.');
        });
        return;
      }

      setViewState('capture');
      setGlobalError(null);
      requestVisibility(true).then(() => {
        if (isActive()) setFocusRequested(true);
      }).catch(() => {
        if (isActive()) setGlobalError('Failed to coordinate window visibility.');
      });

      if (ENABLE_UIA_DIAGNOSTICS) {
        let timeoutId: number | undefined;
        try {
          const probePromise = invoke<TargetProbeResult>('perform_target_probe');
          const timeoutPromise = new Promise<TargetProbeResult>((resolve) =>
            timeoutId = window.setTimeout(() => resolve({
              status: 'Timeout',
              process_path: null,
              class_name: null,
              control_type: null,
              framework_id: null,
              automation_id: null,
              aria_role: null,
              is_keyboard_focusable: null,
              has_value_pattern: null,
              has_text_pattern: null,
            }), 200)
          );
          const probe = await Promise.race([probePromise, timeoutPromise]);

          if (isActive()) {
            if (sessionRef.current !== null) {
              setGlobalError('Finish or clear this draft before starting another capture.');
              return;
            }

            if (probe.status === 'Complete' || probe.status === 'Partial') {
              console.log(`[UIA Probe] Browser: ${probe.process_path} | Class: ${probe.class_name} | Role: ${probe.aria_role}`);
            } else {
              setGlobalError(`Target probe unavailable: ${probe.status}`);
            }
          }
        } catch (err) {
          console.error('[UIA Probe] Native request failed. Ensure the "uia-diagnostics" Cargo feature is active.', err);
        } finally {
          if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        }
      }
    };

    registerGlobalShortcut(handleShortcutTriggered, 'CommandOrControl+Shift+Space').then(result => {
      if (isMounted) {
        if (result.fatal) {
          setGlobalError(`Shortcut Error: ${result.error}`);
        } else if (!result.success) {
          setGlobalError(`Shortcut Warning: ${result.error}`);
        }
      }
    });

    const handleGlobalKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        currentActivationId.current++;
        setFocusRequested(false);
        try {
          await getCurrentWindow().hide();
        } catch (err) {
          console.warn('Failed to hide window:', err);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);

    void listen('single-instance-summon', () => {
      if (!isMounted) return;

      const activationId = ++currentActivationId.current;
      const isActive = () => isMounted && currentActivationId.current === activationId;

      requestVisibility(true).then(() => {
        if (isActive()) setFocusRequested(true);
      }).catch(() => {
        if (isActive()) setGlobalError('Failed to coordinate single-instance visibility.');
      });
    }).then(unlisten => {
      if (!isMounted) {
        unlisten();
      } else {
        unlistenSingleInstance = unlisten;
      }
    }).catch(() => {
      if (isMounted) setGlobalError('Failed to register single-instance listener.');
    });

    return () => {
      isMounted = false;
      window.removeEventListener('keydown', handleGlobalKeyDown);
      clearShortcutCallback(handleShortcutTriggered);
      if (unlistenSingleInstance) unlistenSingleInstance();
    };
  }, []);

  useEffect(() => {
    if (focusRequested && viewState === 'capture' && inputRef.current) {
      inputRef.current.focus();
      setFocusRequested(false);
    }
  }, [focusRequested, viewState]);

  const invalidateFeedback = useCallback(() => {
    draftId.current++;
    dispatchWorkflow({ type: 'SET_COPY_FEEDBACK', value: '' });
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
  }, [dispatchWorkflow]);

  const executeCopy = async (text: string, type: 'Prompt' | 'Original') => {
    if (isWriting.current) return;
    
    isWriting.current = true;
    setPendingAction(type);
    const capturedDraftId = draftId.current;
    
    if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);

    try {
      await navigator.clipboard.writeText(text);
      if (isMounted.current && capturedDraftId === draftId.current) {
        dispatchWorkflow({ type: 'SET_COPY_FEEDBACK', value: `${type} copied successfully.` });
      }
    } catch (err) {
      if (isMounted.current && capturedDraftId === draftId.current) {
        dispatchWorkflow({ type: 'SET_COPY_FEEDBACK', value: 'Copy failed. Please select the text and copy manually.' });
      }
    } finally {
      // Unconditionally releases the lock whether the OS succeeds or throws an error
      isWriting.current = false;
      
      if (isMounted.current) {
        setPendingAction(null);
        if (capturedDraftId === draftId.current) {
          feedbackTimer.current = window.setTimeout(() => {
            if (isMounted.current && capturedDraftId === draftId.current) {
              dispatchWorkflow({ type: 'SET_COPY_FEEDBACK', value: '' });
            }
          }, 5000);
        }
      }
    }
  };

  const handleStartCapture = () => {
    if (!manualInput.trim()) return;
    invalidateFeedback(); 
    dispatchWorkflow({
      type: 'START_MANUAL',
      session: {
        originalText: manualInput,
        targetIdentity: null,
        selectionDetails: null,
        captureStatus: 'manual',
        manualInput,
        editorValues: {},
      },
      input: manualInput,
    });
    setViewState('library');
  };

  const handleSelectTemplate = (template: Template) => {
    if (!session) {
      setGlobalError('Please enter instructions to build a prompt.');
      setViewState('capture');
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    invalidateFeedback();
    if (draftTemplate?.id !== template.id) {
      dispatchWorkflow({ type: 'UPDATE_EDITOR', template });
      const defaults: Record<string, string> = Object.create(null);
      template.variables.forEach(v => {
        if (v.name !== 'user_input') defaults[v.name] = v.defaultValue;
      });
      dispatchWorkflow({ type: 'UPDATE_VARIABLES', values: defaults });
    }
    setViewState('editor');
  };

  const executePessimisticSave = async (newTemplates: Template[], newFavorites: string[]): Promise<boolean> => {
    if (isReadOnly || storageBusy.current || !preferencesRef.current) return false;
    storageBusy.current = true;
    setIsSaving(true);
    setGlobalError(null);
    
    try {
      const snapshot: StoreSnapshot = {
        templates: [...builtInTemplatesRef.current, ...newTemplates],
        preferences: {
          ...preferencesRef.current,
          favoriteTemplateIds: newFavorites,
          dataRevision: dataRevisionRef.current
        }
      };

      const result = await saveUserDataSnapshot(snapshot);
      if (result.success) {
        setCustomTemplates(newTemplates);
        setFavoriteIds(newFavorites);
        dataRevisionRef.current += 1; 
        return true;
      } else {
        if (result.fatal) {
          setIsReadOnly(true);
          setGlobalError(`Storage Locked [${result.code}]: ${result.error}`);
        } else if (result.code === 'STALE_DATA') {
          setGlobalError('Data was modified elsewhere. Please restart the app to sync.');
        } else {
          setGlobalError(result.error);
        }
        return false;
      }
    } catch (err: unknown) {
      setIsReadOnly(true);
      setGlobalError('An unexpected error occurred during save. Storage locked.');
      return false;
    } finally {
      storageBusy.current = false;
      setIsSaving(false);
    }
  };

  const toggleFavorite = (id: string) => {
    if (isReadOnly || isSaving) return;
    const nextFavorites = favoriteIds.includes(id)
      ? favoriteIds.filter(favoriteId => favoriteId !== id)
      : [...favoriteIds, id];
    void executePessimisticSave(customTemplates, nextFavorites);
  };

  const handleRestoreBackup = async () => {
    if (storageBusy.current) return;
    requestConfirmation('Restore from the last known good backup? Unsaved current data will be lost.', async () => {
      storageBusy.current = true;
      setGlobalError("Restoring backup...");
      const res = await restoreBackup();
      if (res.success) {
        await releaseGlobalShortcuts();
        window.location.reload(); 
      } else {
        setGlobalError(`Restore failed [${res.code}]: ${res.error}`);
        storageBusy.current = false;
      }
    });
  };

  const handleResetStorage = async () => {
    // Initial check before opening the dialog
    if (storageBusy.current || isWriting.current) {
      if (isWriting.current) setGlobalError('Please wait for the clipboard operation to finish.');
      return;
    }
    requestConfirmation(
      'Delete all custom templates, favorites, settings, and the current draft? This will factory reset the application. Proceed?',
      async () => {
        // FR08: Re-verify locks inside the callback to prevent race conditions while the modal was open
        if (storageBusy.current || isWriting.current) {
          setGlobalError('Please wait for the current operation to finish.');
          return;
        }
        
        storageBusy.current = true;
        setGlobalError("Resetting storage to factory defaults...");
        
        const res = await resetStorageToDefaults();
        if (res.success) {
          await releaseGlobalShortcuts();
          window.location.reload(); 
        } else {
          setGlobalError(`Factory reset failed [${res.code}]: ${res.error}`);
          storageBusy.current = false;
        }
      }
    );
  };

  const handleDeleteTemplate = async (id: string) => {
    const target = customTemplates.find(t => t.id === id);
    if (!target || target.isBuiltIn) return;

    requestConfirmation('Permanently delete this custom template? This action cannot be undone.', async () => {
      const updated = customTemplates.filter(t => t.id !== id);
      const updatedFavs = favoriteIds.filter(f => f !== id);
      await executePessimisticSave(updated, updatedFavs);
    });
  };

  const handleSaveBuilderTemplate = async (template: Template): Promise<boolean> => {
    const finalizedTemplate = { ...template, updatedAt: Date.now() };
    const isUpdate = customTemplates.some(t => t.id === finalizedTemplate.id);
    const updatedTemplates = isUpdate 
      ? customTemplates.map(t => t.id === finalizedTemplate.id ? finalizedTemplate : t)
      : [...customTemplates, finalizedTemplate];
      
    const success = await executePessimisticSave(updatedTemplates, favoriteIds);
    if (success) {
      dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: null });
      setViewState('library');
    }
    return success;
  };

  const goBackToLibrary = useCallback(() => {
    invalidateFeedback(); 
    setViewState('library');
  }, [invalidateFeedback]);

  const clearEverything = () => {
    void handleResetStorage();
    dispatchWorkflow({ type: 'CLEAR' });
    invalidateFeedback(); 
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleWindowMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, [role="dialog"], [contenteditable="true"], [data-scrollable]')) return;
    void getCurrentWindow().startDragging();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        aria-hidden="true"
        onMouseDown={handleWindowMouseDown}
        style={{ height: '12px', flexShrink: 0, cursor: 'move' }}
      />
      {viewState === 'capture' && (
        <button
          className="secondary theme-toggle"
          type="button"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </button>
      )}
      
      {(initStatus !== 'success' || initError || globalError) && (
        <div
          className={globalError === 'Please enter instructions to build a prompt.' ? 'status-region status-region--validation' : 'status-region'}
          role="status"
          aria-live="polite"
        >
          <div>{globalError || initError || (initStatus === 'loading' ? 'Loading templates…' : null)}</div>
          
          {isReadOnly && (
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
              <button className="primary" onClick={handleRestoreBackup} disabled={storageBusy.current}>
                Restore Backup
              </button>
              <button className="secondary" onClick={handleResetStorage} disabled={storageBusy.current}>
                Factory Reset
              </button>
            </div>
          )}
        </div>
      )}
      
      <div data-scrollable style={{ flex: 1, overflowY: 'auto', paddingBottom: '24px' }}>
        {confirmState && (
          <div className="confirm-backdrop" onClick={() => setConfirmState(null)}>
            <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
              <h3 id="confirm-title">Confirm action</h3>
              <p>{confirmState.message}</p>
              <div className="confirm-actions">
                <button
                  className="primary"
                  onClick={() => {
                    const action = confirmState.onConfirm;
                    setConfirmState(null);
                    action();
                  }}
                >
                  OK
                </button>
                <button className="secondary" onClick={() => setConfirmState(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {viewState === 'builder' && builderSession && (
          <TemplateBuilder 
            session={builderSession}
            onSave={handleSaveBuilderTemplate}
            onCancel={() => {
              dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: null });
              setViewState('library');
            }}
            isSaving={isSaving}
            storageLocked={isReadOnly}
          />
        )}
        {viewState === 'editor' && session && draftTemplate && (
          <PromptEditor 
            draftTemplate={draftTemplate}
            onTemplateChange={(updated) => dispatchWorkflow({ type: 'UPDATE_EDITOR', template: updated })}
            draftVariables={draftVariables}
            onVariablesChange={(updated) => dispatchWorkflow({ type: 'UPDATE_VARIABLES', values: updated })}
            sessionState={session} 
            onBack={goBackToLibrary}
            pendingAction={pendingAction}
            copyFeedback={copyFeedback}
            executeCopy={executeCopy}
            invalidateFeedback={invalidateFeedback}
          />
        )}

        {viewState === 'library' && (
          <div style={{ maxWidth: '600px', margin: '0 auto' }}>
             <div style={{ padding: '24px 20px 0', marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <button className="primary" onClick={() => { dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: { mode: 'create', template: null } }); setViewState('builder'); }} disabled={isSaving || isReadOnly}>
                    Create Template
                  </button>
                  <button className="secondary" onClick={clearEverything}>Start Fresh</button>
                  <button className="secondary" style={{ color: 'var(--danger-text)', borderColor: 'var(--danger-text)', opacity: isSaving ? 0.5 : 1 }} disabled={isSaving || pendingAction !== null} onClick={handleResetStorage}>
                    Clear All Data
                  </button>
                </div>
             </div>
             <TemplateLibrary 
                templates={allTemplates}
                favoriteIds={favoriteIds}
                onSelectTemplate={handleSelectTemplate}
                onToggleFavorite={isReadOnly || isSaving ? () => {} : toggleFavorite}
                onEditTemplate={(t, mode) => { dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: { mode, template: t } }); setViewState('builder'); }}
                onDeleteTemplate={handleDeleteTemplate}
                mutationsDisabled={isReadOnly || isSaving}
             />
          </div>
        )}

        {viewState === 'capture' && (
          <div style={{ maxWidth: '500px', margin: '20px auto', padding: '0 20px' }}>
            <h2>Create your prompt</h2>
            <label htmlFor="manual-capture" style={{ display: 'block', marginBottom: '8px' }}>
              Paste your text, notes, or instruction:
            </label>
            <textarea 
              ref={inputRef}
              id="manual-capture"
              rows={4} 
              value={manualInput} 
              onChange={(e) => {
                const value = e.target.value;
                dispatchWorkflow({ type: 'UPDATE_INPUT', value });
                if (value.trim()) setGlobalError(null);
              }}
              placeholder="e.g., Summarize this article for me..."
            />
            <div className="action-row" style={{ justifyContent: 'flex-start', marginTop: '12px' }}>
              <button className="primary" onClick={handleStartCapture}>
                Build Prompt
              </button>
              <button className="secondary" onClick={() => { setGlobalError(null); setViewState('library'); }}>
                Manage Templates
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}