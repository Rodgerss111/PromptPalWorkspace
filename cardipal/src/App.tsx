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
import type { Template, SessionState, Preferences, StoreSnapshot, Variable, SavedPrompt } from './types';
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
  | { type: 'UPDATE_FREEFORM_DRAFT'; text: string }
  | { type: 'UPDATE_FREEFORM_TITLE'; title: string }
  | { type: 'SET_FREEFORM_ACTIVE'; id: string | null; title: string; text: string }
  | { type: 'CLEAR_FREEFORM' }
  | { type: 'CLEAR' };

export interface WorkflowState {
  session: SessionState | null;
  manualInput: string;
  draftTemplate: Template | null;
  draftVariables: Record<string, string>;
  builderSession: BuilderSession | null;
  copyFeedback: string;
  freeformId: string | null;
  freeformTitle: string;
  freeformOriginalTitle: string;
  freeformOriginalText: string;
  freeformDraft: string;
}

export const initialWorkflowState: WorkflowState = {
  session: null,
  manualInput: '',
  draftTemplate: null,
  draftVariables: {},
  builderSession: null,
  copyFeedback: '',
  freeformId: null,
  freeformTitle: '',
  freeformOriginalTitle: '',
  freeformOriginalText: '',
  freeformDraft: '',
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
    case 'UPDATE_FREEFORM_DRAFT':
      return { ...state, freeformDraft: action.text };
    case 'UPDATE_FREEFORM_TITLE':
      return { ...state, freeformTitle: action.title };
    case 'SET_FREEFORM_ACTIVE':
      return { 
        ...state, 
        freeformId: action.id, 
        freeformTitle: action.title, 
        freeformOriginalTitle: action.title,
        freeformOriginalText: action.text, 
        freeformDraft: action.text 
      };
    case 'CLEAR_FREEFORM':
      return { ...state, freeformId: null, freeformTitle: '', freeformOriginalTitle: '', freeformOriginalText: '', freeformDraft: '' };
    case 'CLEAR':
      return initialWorkflowState;
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown session action: ${String(exhaustive)}`);
    }
  }
}

export default function App() {
  const [themeState, setThemeState] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('cardipal_theme') as 'dark' | 'light') || 'light';
  });
  
  const setTheme = (val: 'dark' | 'light') => {
    setThemeState(val);
    localStorage.setItem('cardipal_theme', val);
  };

  const [viewState, setViewState] = useState<'capture' | 'library' | 'editor' | 'builder' | 'freeform'>('capture');
  const [libraryTab, setLibraryTab] = useState<'templates' | 'prompts' | 'favorites'>('templates');
  const [librarySearch, setLibrarySearch] = useState('');
  const [focusRequested, setFocusRequested] = useState(false);
  
  const [launcherVisible, setLauncherVisible] = useState(true);
  const [isToggling, setIsToggling] = useState(false);

  const workflowRef = useRef(initialWorkflowState);
  const [workflow, rawDispatchWorkflow] = useReducer(reduceWorkflow, initialWorkflowState);
  const { session, manualInput, draftTemplate, draftVariables, builderSession, copyFeedback } = workflow;
  const sessionRef = useRef<SessionState | null>(null);
  
  const [customTemplates, setCustomTemplates] = useState<Template[]>([]);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
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
  const scrollableRef = useRef<HTMLDivElement>(null);
  const storageBusy = useRef(false);

  const [pendingAction, setPendingAction] = useState<'Prompt' | 'Original' | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const isWriting = useRef<boolean>(false);
  const draftId = useRef<number>(0);
  const feedbackTimer = useRef<number | null>(null);
  const isMounted = useRef<boolean>(true);
  const currentActivationId = useRef<number>(0);

  useEffect(() => {
    if (viewState === 'freeform' && scrollableRef.current) {
      scrollableRef.current.scrollTop = 0;
    }
  }, [viewState]);

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
          setSavedPrompts(snap.savedPrompts || []);
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
    document.body.className = themeState === 'dark' ? 'dark-theme' : 'light-theme';
  }, [themeState]);

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

  const executePessimisticSave = async (
    newTemplates: Template[], 
    newFavorites: string[], 
    newIconVisible?: boolean,
    newSavedPrompts: SavedPrompt[] = savedPrompts
  ): Promise<boolean> => {
    if (isReadOnly || storageBusy.current || !preferencesRef.current) return false;
    storageBusy.current = true;
    setIsSaving(true);
    clearMessage();
    
    const nextIconVisible = newIconVisible !== undefined ? newIconVisible : (preferencesRef.current.iconVisible ?? true);
    
    try {
      const snapshot: StoreSnapshot = {
        templates: [...builtInTemplatesRef.current, ...newTemplates],
        savedPrompts: newSavedPrompts,
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
        setSavedPrompts(newSavedPrompts);
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

  const handleSaveFreeform = async () => {
    const isNew = !workflow.freeformId;
    const now = Date.now();
    let updatedPrompts: SavedPrompt[];
    let activeId = workflow.freeformId;

    if (isNew) {
      activeId = crypto.randomUUID();
      const newPrompt: SavedPrompt = {
        id: activeId,
        title: workflow.freeformTitle.trim(),
        text: workflow.freeformDraft.trim(),
        createdAt: now,
        updatedAt: now
      };
      updatedPrompts = [...savedPrompts, newPrompt];
    } else {
      updatedPrompts = savedPrompts.map(p => 
        p.id === activeId 
          ? { ...p, title: workflow.freeformTitle.trim(), text: workflow.freeformDraft.trim(), updatedAt: now } 
          : p
      );
    }

    const success = await executePessimisticSave(customTemplates, favoriteIds, undefined, updatedPrompts);
    if (success) {
      dispatchWorkflow({ type: 'SET_FREEFORM_ACTIVE', id: activeId, title: workflow.freeformTitle.trim(), text: workflow.freeformDraft.trim() });
      showInfo('Prompt saved successfully.');
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

  const msgStyles = floatingMessage ? getMessageStyles(floatingMessage.type, themeState === 'dark') : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative', backgroundColor: 'var(--bg-primary)' }}>
      
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
              backgroundColor: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
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
            <p style={{ margin: '0 0 28px 0', fontSize: '15px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
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
      
      {/* ROOT CONTAINER: Structurally separates Fixed Headers from Scrollable Bodies */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        
        {viewState === 'freeform' && (
          <div ref={scrollableRef} data-scrollable className="animate-panel" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', maxWidth: '600px', margin: '0 auto', width: '100%' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginTop: 0, marginBottom: '6px', flexShrink: 0 }}>
              {workflow.freeformId ? 'Edit Prompt' : 'Freeform Prompt'}
            </h2>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', flexShrink: 0 }}>
              Write or paste your prompt directly. <strong>Tip:</strong> State your goal and output clearly.
            </div>

            <textarea 
              value={workflow.freeformDraft}
              onChange={(e) => dispatchWorkflow({ type: 'UPDATE_FREEFORM_DRAFT', text: e.target.value })}
              placeholder="Type your complete prompt here..."
              style={{ flex: 1, minHeight: '80px', width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px', marginBottom: '16px', resize: 'none', boxSizing: 'border-box' }}
            />

            <div style={{ padding: '12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px', marginBottom: '16px', flexShrink: 0, boxSizing: 'border-box' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input 
                  id="ff-title" type="text" placeholder="Title for My Prompts" 
                  value={workflow.freeformTitle} onChange={(e) => dispatchWorkflow({ type: 'UPDATE_FREEFORM_TITLE', title: e.target.value })}
                  style={{ flex: 1, padding: '8px 12px', fontSize: '13px', boxSizing: 'border-box' }}
                />
                <button 
                  className="secondary" 
                  disabled={!workflow.freeformTitle.trim() || !workflow.freeformDraft.trim() || isSaving}
                  onClick={handleSaveFreeform}
                  style={{ padding: '8px 16px', fontSize: '13px', flexShrink: 0 }}
                >
                  Save
                </button>
              </div>
            </div>

            <div className="action-row" style={{ marginTop: 'auto', flexShrink: 0, flexWrap: 'nowrap', overflowX: 'auto', gap: '8px' }}>
              <button className="secondary" style={{ whiteSpace: 'nowrap' }} onClick={() => { setViewState('capture'); clearMessage(); }}>Back</button>
              <button className="secondary" style={{ whiteSpace: 'nowrap' }} onClick={() => {
                requestConfirmation('Discard current text and start fresh?', () => {
                  dispatchWorkflow({ type: 'CLEAR_FREEFORM' }); clearMessage();
                });
              }}>Start Fresh</button>
              <button className="secondary" style={{ whiteSpace: 'nowrap' }} disabled={!workflow.freeformDraft.trim() || isSaving} onClick={() => {
                dispatchWorkflow({
                  type: 'SET_BUILDER_SESSION',
                  builderSession: {
                    mode: 'create',
                    template: {
                      id: crypto.randomUUID(), schemaVersion: 1, name: workflow.freeformTitle.trim() || 'Custom Template', category: '', contextText: '', taskText: workflow.freeformDraft, formatText: '',
                      variables: [{ name: 'user_input', label: 'Primary Input', required: true, defaultValue: '' }],
                      isBuiltIn: false, createdAt: Date.now(), updatedAt: Date.now(), strategyNote: ''
                    }
                  }
                });
                setViewState('builder');
              }}>To Template</button>
              <button className="primary" style={{ whiteSpace: 'nowrap', marginLeft: 'auto' }} disabled={!workflow.freeformDraft.trim() || pendingAction !== null} onClick={() => executeCopy(workflow.freeformDraft, 'Prompt')}>
                {pendingAction === 'Prompt' ? 'Copying...' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {viewState === 'builder' && builderSession && (
          <div data-scrollable style={{ flex: 1, overflowY: 'auto' }}>
            <TemplateBuilder 
              session={builderSession}
              onSave={async (template) => {
                const success = await handleSaveBuilderTemplate(template);
                return success;
              }}
              onCancel={() => {
                clearMessage();
                dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: null });
                if (workflow.freeformDraft.trim() || workflow.freeformId) { setViewState('freeform'); } else { setViewState('library'); }
              }}
              isSaving={isSaving}
              storageLocked={isReadOnly}
              requestConfirmation={requestConfirmation}
            />
          </div>
        )}

        {viewState === 'editor' && session && draftTemplate && (
          <div data-scrollable style={{ flex: 1, overflowY: 'auto' }}>
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
          </div>
        )}

        {viewState === 'library' && (
          <div className="animate-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, maxWidth: '600px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
             
             {/* PHYSICALLY SEPARATE HEADER (Not Sticky, Does not Hover) */}
             <div style={{ flexShrink: 0, padding: '16px 20px 12px 20px', borderBottom: '1px solid var(--border-color)' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: '18px', margin: 0, fontWeight: 600 }}>Library</h2>
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <button style={{ background: 'none', border: 'none', padding: 0, fontSize: '13px', fontWeight: libraryTab === 'templates' ? 600 : 400, color: libraryTab === 'templates' ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setLibraryTab('templates')}>Templates</button>
                      <button style={{ background: 'none', border: 'none', padding: 0, fontSize: '13px', fontWeight: libraryTab === 'prompts' ? 600 : 400, color: libraryTab === 'prompts' ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setLibraryTab('prompts')}>Prompts</button>
                      <button style={{ background: 'none', border: 'none', padding: 0, fontSize: '13px', fontWeight: libraryTab === 'favorites' ? 600 : 400, color: libraryTab === 'favorites' ? 'var(--text-primary)' : 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setLibraryTab('favorites')}>Favorites</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginLeft: 'auto' }}>
                    <button className="secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={goHome}>Home</button>
                    <button className="primary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => { dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: { mode: 'create', template: null } }); setViewState('builder'); }} disabled={isSaving || isReadOnly}>+ New</button>
                    <button style={{ background: 'none', border: 'none', padding: '4px', fontSize: '14px', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setTheme(themeState === 'dark' ? 'light' : 'dark')} title={themeState === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'} aria-label={themeState === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
                      {themeState === 'light' ? '🌙' : '☀️'}
                    </button>
                  </div>
               </div>
               
               <input 
                 type="text" 
                 placeholder="Search library..." 
                 value={librarySearch}
                 onChange={e => setLibrarySearch(e.target.value)}
                 style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid var(--border-color)', borderRadius: '6px', boxSizing: 'border-box' }}
                 aria-label="Search library"
               />
             </div>

             {/* INDEPENDENT SCROLLING LIST */}
             <div ref={scrollableRef} data-scrollable style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 24px 20px' }}>
               {libraryTab === 'templates' || libraryTab === 'favorites' ? (
                 <TemplateLibrary 
                    templates={libraryTab === 'favorites' ? allTemplates.filter(t => favoriteIds.includes(t.id)) : allTemplates}
                    favoriteIds={favoriteIds}
                    searchQuery={librarySearch}
                    theme={themeState} // <--- PASSED HERE
                    onSelectTemplate={handleSelectTemplate}
                    onToggleFavorite={isReadOnly || isSaving ? () => {} : toggleFavorite}
                    onEditTemplate={(t, mode) => { dispatchWorkflow({ type: 'SET_BUILDER_SESSION', builderSession: { mode, template: t } }); setViewState('builder'); }}
                    onDeleteTemplate={handleDeleteTemplate}
                    mutationsDisabled={isReadOnly || isSaving}
                 />
               ) : (
                 <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                   {savedPrompts.filter(p => p.title.toLowerCase().includes(librarySearch.toLowerCase()) || p.text.toLowerCase().includes(librarySearch.toLowerCase())).length === 0 ? (
                     <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '20px 0', textAlign: 'center' }}>No saved prompts found.</p>
                   ) : (
                     savedPrompts.filter(p => p.title.toLowerCase().includes(librarySearch.toLowerCase()) || p.text.toLowerCase().includes(librarySearch.toLowerCase())).map((p, index, arr) => (
                       <div key={p.id} style={{ display: 'flex', flexDirection: 'column', padding: '10px 12px', borderBottom: index === arr.length - 1 ? 'none' : '1px solid var(--border-color)', boxSizing: 'border-box' }}>
                         <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                           <button 
                             onClick={() => {
                               const openPrompt = () => {
                                 dispatchWorkflow({ type: 'SET_FREEFORM_ACTIVE', id: p.id, title: p.title, text: p.text });
                                 setViewState('freeform');
                                 clearMessage();
                               };
                               const isDirty = workflow.freeformDraft !== workflow.freeformOriginalText || workflow.freeformTitle !== workflow.freeformOriginalTitle;
                               if (isDirty) {
                                 requestConfirmation('Discard unsaved changes to your current prompt?', openPrompt);
                               } else {
                                 openPrompt();
                               }
                             }}
                             style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', lineHeight: '1.3' }}
                           >
                             {p.title}
                           </button>
                           <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                             <button style={{ background: 'none', border: 'none', padding: '2px 4px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }} disabled={pendingAction !== null} onClick={() => executeCopy(p.text, 'Prompt')}>Copy</button>
                             <button style={{ background: 'none', border: 'none', padding: '2px 4px', fontSize: '12px', color: 'var(--danger-text)', cursor: 'pointer' }} disabled={isSaving} onClick={() => {
                                requestConfirmation('Delete this saved prompt?', async () => {
                                  const updated = savedPrompts.filter(sp => sp.id !== p.id);
                                  const success = await executePessimisticSave(customTemplates, favoriteIds, undefined, updated);
                                  if (success && workflow.freeformId === p.id) {
                                    dispatchWorkflow({ type: 'CLEAR_FREEFORM' });
                                  }
                                });
                             }}>Delete</button>
                           </div>
                         </div>
                         <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: '4px' }}>
                           {p.text}
                         </div>
                       </div>
                     ))
                   )}
                 </div>
               )}
             </div>
          </div>
        )}

        {viewState === 'capture' && (
          <div ref={scrollableRef} data-scrollable className="animate-panel" style={{ flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', maxWidth: '500px', margin: '0 auto', width: '100%' }}>
            
            {/* Exactly Restored Original Headings */}
            <h2 style={{ fontSize: '24px', fontWeight: 600, letterSpacing: '-0.02em', margin: '0 0 6px', flexShrink: 0 }}>
              Clear prompts, less effort
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', letterSpacing: '0.01em', margin: '0 0 14px 0', maxWidth: '440px', flexShrink: 0 }}>
              Turn your idea into a prompt that fits your goal. Choose a template, refine it, and copy it to your AI tool.
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', flexShrink: 0 }}>
              <label htmlFor="manual-capture" style={{ fontSize: '13px', fontWeight: 500 }}>
                What are you working on?
              </label>
              {manualInput.length === 0 && (
                <button 
                  type="button" 
                  className="text-link"
                  style={{ fontSize: '12px', padding: 0 }}
                  onClick={() => {
                    const example = "Explain the differences between standard polling and WebSockets for real-time data, focusing on resource overhead.";
                    dispatchWorkflow({ type: 'UPDATE_INPUT', value: example });
                    clearMessage();
                  }}
                >
                  Try an example
                </button>
              )}
            </div>
            
            <textarea
              ref={inputRef}
              id="manual-capture"
              value={manualInput}
              onChange={(e) => {
                const value = e.target.value;
                dispatchWorkflow({ type: 'UPDATE_INPUT', value });
                if (value.trim()) clearMessage();
              }}
              placeholder="A question, draft, code, or notes..."
              style={{ flex: 1, minHeight: '80px', width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '13px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px', boxSizing: 'border-box', resize: 'none' }}
            />

            {/* Compact wrapped action row */}
            <div className="action-row" style={{ justifyContent: 'flex-start', marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', flexShrink: 0 }}>
              <button className="primary" style={{ padding: '6px 14px', fontSize: '13px', whiteSpace: 'nowrap' }} onClick={handleStartCapture}>Build</button>
              
              <button className="secondary" style={{ padding: '6px 14px', fontSize: '13px', whiteSpace: 'nowrap' }} onClick={() => {
                if (!workflow.freeformDraft.trim() && manualInput.trim()) {
                  dispatchWorkflow({ type: 'UPDATE_FREEFORM_DRAFT', text: manualInput });
                }
                setViewState('freeform');
                clearMessage();
              }}>
                Freeform
              </button>

              <button className="secondary" style={{ padding: '6px 14px', fontSize: '13px', whiteSpace: 'nowrap' }} onClick={() => {
                clearMessage();
                setViewState('library');
              }}>
                Library
              </button>
              
              <button style={{ background: 'none', border: 'none', padding: '6px 10px', fontSize: '14px', cursor: 'pointer', color: 'var(--text-secondary)', marginLeft: 'auto' }} onClick={() => setTheme(themeState === 'dark' ? 'light' : 'dark')} title={themeState === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'} aria-label={themeState === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
                {themeState === 'light' ? '🌙' : '☀️'}
              </button>

              <button 
                style={{ background: 'none', border: 'none', padding: '6px 10px', fontSize: '14px', cursor: 'pointer', color: 'var(--text-secondary)' }}
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
                title={launcherVisible ? 'Hide Cardi' : 'Show Cardi'} 
                aria-label={launcherVisible ? 'Hide Cardi' : 'Show Cardi'}
              >
                {launcherVisible ? '➖' : '➕'}
              </button>
            </div>
          </div>
        )}

      </div>
      <div className="bottom-safe-bar" aria-hidden="true" />
    </div>
  );
}