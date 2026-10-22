import { TemplateBuilder, type BuilderSession } from './components/TemplateBuilder';
import { useState, useRef, useCallback, useEffect, useMemo, useReducer } from 'react';
import { PromptEditor } from './components/PromptEditor';
import { TemplateLibrary } from './components/TemplateLibrary';
import { loadUserData, saveUserDataSnapshot, restoreBackup, resetStorageToDefaults } from './utils/store';
import { clearShortcutCallback, registerGlobalShortcut, releaseGlobalShortcuts } from './utils/shortcut';
import { requestVisibility, toggleVisibility } from './utils/window';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import type { Template, SessionState, Preferences, StoreSnapshot, Variable } from './types';
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

type MessageType = 'error' | 'warning' | 'info';

const ENABLE_UIA_DIAGNOSTICS = import.meta.env.DEV && import.meta.env.VITE_UIA_DIAGNOSTICS === 'true';

export type SessionAction =
  | { type: 'START_MANUAL'; session: SessionState; input: string }
  | { type: 'UPDATE_INPUT'; value: string }
  | { type: 'UPDATE_EDITOR'; template: Template }
  | { type: 'UPDATE_VARIABLES'; values: Record<string, string> }
  | { type: 'SET_BUILDER_SESSION'; builderSession: BuilderSession | null }
  | { type: 'SET_COPY_FEEDBACK'; value: string }
  | { type: 'APPEND_TO_DRAFT'; section: 'contextText' | 'taskText' | 'formatText'; textToAppend: string; newVariables: Variable[] }
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
    case 'APPEND_TO_DRAFT': {
      if (!state.draftTemplate) return state;
      const { section, textToAppend, newVariables } = action;
      
      const currentText = state.draftTemplate[section];
      const newText = currentText.trim() ? `${currentText}\n\n${textToAppend}` : textToAppend;
      
      const updatedTemplate = {
        ...state.draftTemplate,
        [section]: newText,
        variables: [...state.draftTemplate.variables, ...newVariables]
      };

      const newDraftVariables = { ...state.draftVariables };
      newVariables.forEach(v => {
        if (!(v.name in newDraftVariables) && v.name !== 'user_input') {
          newDraftVariables[v.name] = v.defaultValue;
        }
      });

      return { ...state, draftTemplate: updatedTemplate, draftVariables: newDraftVariables };
    }
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
  
  const [launcherVisible, setLauncherVisible] = useState(true);
  const [isToggling, setIsToggling] = useState(false);

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
  
  const [appMessage, setAppMessage] = useState<{ text: string, type: MessageType } | null>(null);
  const clearMessage = useCallback(() => setAppMessage(null), []);
  const showError = useCallback((text: string) => setAppMessage({ text, type: 'error' }), []);
  const showWarning = useCallback((text: string) => setAppMessage({ text, type: 'warning' }), []);
  const showInfo = useCallback((text: string) => setAppMessage({ text, type: 'info' }), []);

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
      showWarning('Please wait for the clipboard operation to finish before clearing.');
      return; 
    }

    const nextState = reduceWorkflow(workflowRef.current, action);
    workflowRef.current = nextState;
    sessionRef.current = nextState.session;
    
    if (action.type === 'CLEAR') {
      clearMessage();
      setViewState('capture');
      setPendingAction(null);
      draftId.current += 1;
      if (feedbackTimer.current) window.clearTimeout(feedbackTimer.current);
    }
    rawDispatchWorkflow(action);
  }, [clearMessage, showWarning]);

  const allTemplates = useMemo(() => [...builtInTemplatesRef.current, ...customTemplates], [customTemplates]);

  const requestConfirmation = useCallback((message: string, onConfirm: () => void) => {
    setConfirmState({ message, onConfirm });
  }, []);

  useEffect(() => {
    const handleConfirmEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && confirmState) {
        e.preventDefault(); 
        e.stopPropagation();
        setConfirmState(null);
      }
    };
    window.addEventListener('keydown', handleConfirmEscape, true);
    return () => window.removeEventListener('keydown', handleConfirmEscape, true);
  }, [confirmState]);

  useEffect(() => {
    let cancelled = false;
    
    loadUserData()
      .then(async result => {
        if (cancelled) return;
        if (result.status === 'success') {
          const snap = result.snapshot;
          builtInTemplatesRef.current = snap.templates.filter(t => t.isBuiltIn);
          setCustomTemplates(snap.templates.filter(t => !t.isBuiltIn));
          setFavoriteIds(snap.preferences.favoriteTemplateIds);
          preferencesRef.current = snap.preferences;
          dataRevisionRef.current = snap.preferences.dataRevision;
          
          const iconVis = snap.preferences.iconVisible ?? true;
          setLauncherVisible(iconVis);
          
          try {
            const companion = await Window.getByLabel('companion');
            if (!companion) throw new Error('Companion window not found');
            
            if (iconVis) {
              await companion.show();
            } else {
              await companion.hide();
            }
          } catch (e) {
            console.error("Could not sync companion visibility on boot:", e);
          }

          setIsReadOnly(false);
          setInitStatus('success');
        } else {
          setIsReadOnly(true);
          setInitError(result.warning);
          setInitStatus('error');
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error("Storage load failed:", err);
        setIsReadOnly(true);
        setInitError(`Storage Error: ${String(err)}`);
        setInitStatus('error');
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
    const handleShortcutTriggered = async () => {
      const activationId = ++currentActivationId.current;
      const isActive = () => isMounted.current && currentActivationId.current === activationId;

      if (sessionRef.current !== null) {
        requestVisibility(true).then(() => {
          if (isActive()) {
            showWarning('Active draft exists. Navigate to the Home screen and clear your session to create a new one.');
            setFocusRequested(false);
          }
        }).catch(() => {
          if (isActive()) showError('Failed to coordinate window visibility.');
        });
        return;
      }

      setViewState('capture');
      clearMessage();
      
      requestVisibility(true).then(() => {
        if (isActive() && sessionRef.current === null) setFocusRequested(true);
      }).catch(() => {
        if (isActive()) showError('Failed to coordinate window visibility.');
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
              showWarning('Active draft exists. Navigate to the Home screen and clear your session to create a new one.');
              return;
            }

            if (probe.status === 'Complete' || probe.status === 'Partial') {
              console.log(`[UIA Probe] Browser: ${probe.process_path} | Class: ${probe.class_name} | Role: ${probe.aria_role}`);
            } else {
              showWarning(`Target probe unavailable: ${probe.status}`);
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
      if (isMounted.current) {
        if (result.fatal) {
          showError(`Shortcut Error: ${result.error}`);
        } else if (!result.success) {
          showWarning(`Shortcut Warning: ${result.error}`);
        }
      }
    });

    const handleGlobalKeyDown = async (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
        currentActivationId.current++;
        setFocusRequested(false);
        try {
          await requestVisibility(false);
        } catch (err) {
          console.warn('Failed to hide window:', err);
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);

    const setupSingleInstance = async () => {
      return await listen('single-instance-summon', () => {
        if (!isMounted.current) return;

        const activationId = ++currentActivationId.current;
        const isActive = () => isMounted.current && currentActivationId.current === activationId;

        requestVisibility(true).then(() => {
          if (isActive() && sessionRef.current === null) setFocusRequested(true);
        }).catch(() => {
          if (isActive()) showError('Failed to coordinate single-instance visibility.');
        });
      });
    };
    const unlistenSingleInstancePromise = setupSingleInstance();

    const setupCompanionListener = async () => {
      return await listen('summon-cardipal', () => {
        if (!isMounted.current) return;

        const activationId = ++currentActivationId.current;
        const isActive = () => isMounted.current && currentActivationId.current === activationId;

        toggleVisibility().then((isNowVisible) => {
          if (isActive() && isNowVisible && sessionRef.current === null) {
            setFocusRequested(true);
          }
        }).catch(() => {
          if (isActive()) showError('Failed to toggle companion visibility.');
        });
      });
    };
    const unlistenCompanionPromise = setupCompanionListener();

    const setupCloseInterceptor = async () => {
      const mainWindow = getCurrentWindow();
      return await mainWindow.onCloseRequested((event) => {
        event.preventDefault(); 
        void requestVisibility(false);
      });
    };
    const unlistenClosePromise = setupCloseInterceptor();

    const setupTrayListener = async () => {
      return await listen('tray-toggle', () => {
        void toggleVisibility();
      });
    };
    const unlistenTrayPromise = setupTrayListener();

    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      clearShortcutCallback(handleShortcutTriggered);
      unlistenSingleInstancePromise.then(unlisten => unlisten());
      unlistenCompanionPromise.then(unlisten => unlisten());
      unlistenClosePromise.then(unlisten => unlisten());
      unlistenTrayPromise.then(unlisten => unlisten());
    };
  }, [clearMessage, showError, showWarning]);

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
      showWarning('Please enter instructions to build a prompt.');
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

  const executePessimisticSave = async (newTemplates: Template[], newFavorites: string[], newIconVisible?: boolean): Promise<boolean> => {
    if (isReadOnly || storageBusy.current || !preferencesRef.current) return false;
    storageBusy.current = true;
    setIsSaving(true);
    clearMessage();
    
    const nextIconVisible = newIconVisible !== undefined ? newIconVisible : (preferencesRef.current.iconVisible ?? true);
    
    try {
      const snapshot: StoreSnapshot = {
        templates: [...builtInTemplatesRef.current, ...newTemplates],
        preferences: {
          ...preferencesRef.current,
          favoriteTemplateIds: newFavorites,
          dataRevision: dataRevisionRef.current,
          iconVisible: nextIconVisible
        }
      };

      const result = await saveUserDataSnapshot(snapshot);
      if (result.success) {
        setCustomTemplates(newTemplates);
        setFavoriteIds(newFavorites);
        preferencesRef.current = snapshot.preferences;
        dataRevisionRef.current += 1; 
        return true;
      } else {
        if (result.fatal) {
          setIsReadOnly(true);
          showError(`Storage Locked [${result.code}]: ${result.error}`);
        } else if (result.code === 'STALE_DATA') {
          showError('Data was modified elsewhere. Please restart the app to sync.');
        } else {
          showError(result.error);
        }
        return false;
      }
    } catch (err: unknown) {
      setIsReadOnly(true);
      showError('An unexpected error occurred during save. Storage locked.');
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
      showInfo("Restoring backup...");
      const res = await restoreBackup();
      if (res.success) {
        await releaseGlobalShortcuts();
        window.location.reload(); 
      } else {
        showError(`Restore failed [${res.code}]: ${res.error}`);
        storageBusy.current = false;
      }
    });
  };

  const handleResetStorage = async () => {
    if (storageBusy.current || isWriting.current) {
      if (isWriting.current) showWarning('Please wait for the clipboard operation to finish.');
      return;
    }
    requestConfirmation(
      'Delete all custom templates, favorites, settings, and the current draft? This will factory reset the application. Proceed?',
      async () => {
        if (storageBusy.current || isWriting.current) {
          showWarning('Please wait for the current operation to finish.');
          return;
        }
        
        storageBusy.current = true;
        showInfo("Resetting storage to factory defaults...");
        
        const res = await resetStorageToDefaults();
        if (res.success) {
          await releaseGlobalShortcuts();
          window.location.reload(); 
        } else {
          showError(`Factory reset failed [${res.code}]: ${res.error}`);
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
    clearMessage();
    invalidateFeedback(); 
    setViewState('library');
  }, [clearMessage, invalidateFeedback]);

  const goHome = useCallback(() => {
    invalidateFeedback();
    dispatchWorkflow({ type: 'CLEAR' });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [dispatchWorkflow, invalidateFeedback]);

  const handleWindowMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, [role="dialog"], [contenteditable="true"], [data-scrollable]')) return;
    void getCurrentWindow().startDragging();
  };

  let floatingMessage = null;
  if (appMessage) {
    floatingMessage = appMessage;
  } else if (initStatus === 'loading') {
    floatingMessage = { text: 'Loading templates…', type: 'info' as MessageType };
  } else if (initError) {
    floatingMessage = { text: initError, type: 'error' as MessageType };
  } else if (isReadOnly) {
    floatingMessage = { text: 'Storage is locked. Please restore or reset data.', type: 'error' as MessageType };
  }

  const getMessageStyles = (type: MessageType, isDark: boolean) => {
    if (type === 'warning') {
      return isDark
        ? { bg: 'rgba(255, 152, 0, 0.2)', text: '#ffb74d', border: 'rgba(255, 152, 0, 0.5)' }
        : { bg: '#fff7ed', text: '#c2410c', border: '#fdba74' };
    }
    if (type === 'error') {
      return isDark
        ? { bg: 'rgba(244, 67, 54, 0.2)', text: '#ef5350', border: 'rgba(244, 67, 54, 0.5)' }
        : { bg: '#fef2f2', text: '#b91c1c', border: '#fca5a5' };
    }
    return isDark
      ? { bg: 'rgba(33, 150, 243, 0.2)', text: '#64b5f6', border: 'rgba(33, 150, 243, 0.5)' }
      : { bg: '#f0f9ff', text: '#0369a1', border: '#7dd3fc' };
  };

  const msgStyles = floatingMessage ? getMessageStyles(floatingMessage.type, theme === 'dark') : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative' }}>
      
      {floatingMessage && msgStyles && (
        <div
          style={{
            position: 'fixed',
            top: '32px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            backgroundColor: msgStyles.bg,
            color: msgStyles.text,
            border: `1px solid ${msgStyles.border}`,
            padding: '12px 32px',
            borderRadius: '9999px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            width: 'max-content',
            maxWidth: '90vw',
            backdropFilter: 'blur(8px)',
            fontWeight: 500,
            fontSize: '14px',
            lineHeight: '1.5',
            pointerEvents: 'auto',
          }}
          role="alert"
          aria-live="polite"
        >
          <span style={{ wordBreak: 'break-word' }}>{floatingMessage.text}</span>
          
          {isReadOnly && (
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="primary" onClick={handleRestoreBackup} disabled={storageBusy.current} style={{ padding: '6px 16px', fontSize: '13px', borderRadius: '9999px' }}>
                Restore Backup
              </button>
              <button className="secondary" onClick={handleResetStorage} disabled={storageBusy.current} style={{ padding: '6px 16px', fontSize: '13px', borderRadius: '9999px', backgroundColor: 'transparent', borderColor: 'currentColor', color: 'currentColor' }}>
                Factory Reset
              </button>
            </div>
          )}
        </div>
      )}

      {confirmState && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px',
            animation: 'fadeIn 0.2s ease-out'
          }}
          onClick={() => setConfirmState(null)}
        >
          <div 
            role="dialog" 
            aria-modal="true" 
            aria-labelledby="confirm-title" 
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--bg-primary, #ffffff)',
              border: '1px solid var(--border-color, #e5e7eb)',
              borderRadius: '16px',
              padding: '28px',
              width: '100%',
              maxWidth: '380px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              textAlign: 'center'
            }}
          >
            <h3 id="confirm-title" style={{ margin: '0 0 12px 0', fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Confirm Action
            </h3>
            <p style={{ margin: '0 0 28px 0', fontSize: '15px', color: 'var(--text-secondary, #666)', lineHeight: '1.5' }}>
              {confirmState.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                className="primary"
                onClick={() => {
                  const action = confirmState.onConfirm;
                  setConfirmState(null);
                  action();
                }}
                style={{ flex: 1, padding: '10px', fontSize: '14px', fontWeight: 500, borderRadius: '8px' }}
              >
                OK
              </button>
              <button 
                className="secondary" 
                onClick={() => setConfirmState(null)}
                style={{ flex: 1, padding: '10px', fontSize: '14px', fontWeight: 500, borderRadius: '8px' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        aria-hidden="true"
        onMouseDown={handleWindowMouseDown}
        style={{ height: '12px', flexShrink: 0, cursor: 'move' }}
      />
      
      {(viewState === 'capture' || viewState === 'library') && (
        <button
          className="secondary theme-toggle"
          type="button"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
        </button>
      )}
      
      <div data-scrollable style={{ flex: 1, overflowY: 'auto', paddingBottom: '24px' }}>
        {viewState === 'builder' && builderSession && (
          <TemplateBuilder 
            session={builderSession}
            onSave={handleSaveBuilderTemplate}
            onCancel={() => {
              clearMessage();
              dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: null });
              setViewState('library');
            }}
            isSaving={isSaving}
            storageLocked={isReadOnly}
            requestConfirmation={requestConfirmation}
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
            allTemplates={allTemplates}
            onAppendToDraft={(section, textToAppend, newVariables) => {
              dispatchWorkflow({ type: 'APPEND_TO_DRAFT', section, textToAppend, newVariables });
              invalidateFeedback();
            }}
          />
        )}

        {viewState === 'library' && (
          <div style={{ maxWidth: '600px', margin: '0 auto' }}>
             <div className="library-header">
               <h2 className="library-title">Template Library</h2>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <button className="secondary" onClick={goHome}>Home</button>
                  <button className="primary" onClick={() => { dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: { mode: 'create', template: null } }); setViewState('builder'); }} disabled={isSaving || isReadOnly}>
                    Create Template
                  </button>
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
          <div className="animate-panel" style={{ maxWidth: '500px', margin: '24px auto', padding: '0 20px' }}>
            <h2 style={{ fontSize: '24px', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 6px' }}>
              Clear prompts, less effort
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', letterSpacing: '0.01em', margin: '0 0 14px 0', maxWidth: '440px' }}>
              Turn your idea into a prompt that fits your goal. Choose a template, refine it, and copy it to your AI tool.
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <label htmlFor="manual-capture" style={{ fontSize: '14px', fontWeight: 500 }}>
                What are you working on?
              </label>
              {manualInput.length === 0 && (
                <button 
                  type="button" 
                  className="text-link"
                  onClick={() => {
                    if (workflowRef.current.manualInput.length === 0) {
                      const example = "Explain the differences between standard polling and WebSockets for real-time data, focusing on resource overhead.";
                      dispatchWorkflow({ type: 'UPDATE_INPUT', value: example });
                      clearMessage();
                    }
                  }}
                >
                  Try an example
                </button>
              )}
            </div>
            
            <textarea
              ref={inputRef}
              id="manual-capture"
              rows={4}
              value={manualInput}
              onChange={(e) => {
                const value = e.target.value;
                dispatchWorkflow({ type: 'UPDATE_INPUT', value });
                if (value.trim()) clearMessage();
              }}
              placeholder="A question, draft, code, or notes..."
            />

            <div className="action-row" style={{ justifyContent: 'flex-start', marginTop: '12px', flexWrap: 'wrap' }}>
              <button className="primary" onClick={handleStartCapture}>Build prompt</button>
              <button className="secondary" onClick={() => {
                clearMessage();
                setViewState('library');
              }}>
                View templates
              </button>
              
              <button 
                className="secondary" 
                disabled={isToggling}
                onClick={async () => {
                  if (isToggling) return;
                  setIsToggling(true);
                  try {
                    const companion = await Window.getByLabel('companion');
                    if (!companion) throw new Error('Companion window not found');
                    
                    const targetVisibility = !launcherVisible;
                    if (targetVisibility) {
                      await companion.show();
                    } else {
                      await companion.hide();
                    }
                    
                    const isNowVisible = await companion.isVisible();
                    if (isNowVisible !== targetVisibility) {
                      throw new Error(`Companion did not toggle. Expected ${targetVisibility} but is ${isNowVisible}.`);
                    }

                    const saveSuccess = await executePessimisticSave(customTemplates, favoriteIds, isNowVisible);
                    if (!saveSuccess) {
                      if (launcherVisible) {
                        await companion.show();
                      } else {
                        await companion.hide();
                      }
                      throw new Error('Failed to save preference. Companion visibility rolled back.');
                    }

                    setLauncherVisible(isNowVisible);
                  } catch (err: any) {
                    console.error('Toggle Launcher Error:', err);
                    showWarning(`Toggle failed: ${err.message || String(err)}`);
                  } finally {
                    setIsToggling(false);
                  }
                }}
              >
                {isToggling ? 'Toggling...' : (launcherVisible ? 'Hide Cardi' : 'Show Cardi')}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="bottom-safe-bar" aria-hidden="true" />
    </div>
  );
}