import { useMemo, useEffect, useRef, useState } from 'react';
import { assemblePrompt, getAppendPayload } from '../utils/builder';
import type { Template, SessionState, Variable } from '../types';

interface PromptEditorProps {
  draftTemplate: Template;
  onTemplateChange: (updated: Template) => void;
  draftVariables: Record<string, string>;
  onVariablesChange: (updated: Record<string, string>) => void;
  sessionState: SessionState;
  onBack: () => void;
  pendingAction: 'Prompt' | 'Original' | null;
  copyFeedback: string;
  executeCopy: (text: string, type: 'Prompt' | 'Original') => Promise<void>;
  invalidateFeedback: () => void;
  allTemplates: Template[];
  onAppendToDraft: (section: 'contextText' | 'taskText' | 'formatText', textToAppend: string, newVariables: Variable[]) => void;
}

export function PromptEditor({ 
  draftTemplate, onTemplateChange, 
  draftVariables, onVariablesChange, 
  sessionState, onBack,
  pendingAction, copyFeedback, executeCopy, invalidateFeedback,
  allTemplates, onAppendToDraft
}: PromptEditorProps) {
  const isMounted = useRef<boolean>(true);
  const appendButtonRef = useRef<HTMLButtonElement>(null);
  const appendContainerRef = useRef<HTMLDivElement>(null);
  
  const [appendViewOpen, setAppendViewOpen] = useState(false);
  const [appendSearch, setAppendSearch] = useState('');
  const [appendCategory, setAppendCategory] = useState<string | null>(null);
  const [selectedAppendTemplate, setSelectedAppendTemplate] = useState<Template | null>(null);
  const [previewSection, setPreviewSection] = useState<'contextText' | 'taskText' | 'formatText' | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  
  const [showPrivacy, setShowPrivacy] = useState(true);
  
  // Track manual edits. 'null' means we use the auto-generated prompt.
  const [customPrompt, setCustomPrompt] = useState<string | null>(null);

  const builderResult = useMemo(() => {
    return assemblePrompt(draftTemplate, { 
      ...draftVariables, 
      user_input: sessionState.originalText 
    });
  }, [draftTemplate, draftVariables, sessionState.originalText]);

  // Safely determine which text to show/copy
  const displayPrompt = customPrompt !== null 
    ? customPrompt 
    : (builderResult.success ? builderResult.prompt : '');

  // Reset the override when a new session starts or the base template changes
  useEffect(() => {
    setCustomPrompt(null);
  }, [sessionState.originalText, draftTemplate.id]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (appendViewOpen && appendContainerRef.current) {
      const input = appendContainerRef.current.querySelector('input');
      if (input) {
        input.focus();
      } else {
        appendContainerRef.current.focus();
      }
    }
  }, [appendViewOpen]);

  const closeAppendView = () => {
    setAppendViewOpen(false);
    setSelectedAppendTemplate(null);
    setPreviewSection(null);
    setAppendError(null);
    setTimeout(() => appendButtonRef.current?.focus(), 0);
  };

  const handleAppendTrap = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault(); 
      e.stopPropagation();
      closeAppendView();
      return;
    }

    if (e.key === 'Tab') {
      if (!appendContainerRef.current) return;
      const focusableElements = appendContainerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement || document.activeElement === appendContainerRef.current) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }
  };

  const handleEditorEscape = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    }
  };

  const handleSectionChange = (section: 'contextText' | 'taskText' | 'formatText', value: string) => {
    onTemplateChange({ ...draftTemplate, [section]: value });
    invalidateFeedback();
  };

  const handleVariableChange = (name: string, value: string) => {
    onVariablesChange({ ...draftVariables, [name]: value });
    invalidateFeedback();
  };

  const appendCategories = useMemo(() => {
    const map = new Map<string, string>();
    allTemplates.forEach(t => {
      const raw = t.category?.trim() || 'Uncategorized';
      const key = raw.toLowerCase();
      if (!map.has(key)) map.set(key, raw);
    });
    return Array.from(map.values()).sort();
  }, [allTemplates]);

  const filteredAppendTemplates = useMemo(() => {
    return allTemplates.filter(t => {
      const rawCat = t.category?.trim() || 'Uncategorized';
      if (appendCategory && rawCat.toLowerCase() !== appendCategory.toLowerCase()) return false;
      if (appendSearch) {
        const query = appendSearch.toLowerCase();
        return t.name.toLowerCase().includes(query) || rawCat.toLowerCase().includes(query);
      }
      return true;
    });
  }, [allTemplates, appendCategory, appendSearch]);

  if (appendViewOpen) {
    return (
      <div 
        ref={appendContainerRef}
        tabIndex={-1}
        onKeyDownCapture={handleAppendTrap}
        style={{ maxWidth: '600px', margin: '0 auto', padding: '0 20px', animation: 'fadeIn 0.2s ease-in-out', outline: 'none' }}
      >
        <div style={{ marginBottom: '24px' }}>
          <button className="secondary" onClick={closeAppendView}>
            &larr; Back to Editor
          </button>
        </div>
        
        <h2 style={{ fontSize: '24px', fontWeight: 600, marginTop: 0, marginBottom: '20px' }}>Append to Prompt</h2>
        
        {!selectedAppendTemplate ? (
          <>
            <input
              type="text" placeholder="Search templates to append..." value={appendSearch}
              onChange={(e) => setAppendSearch(e.target.value)} style={{ width: '100%', marginBottom: '16px' }}
            />
            <div data-scrollable style={{ display: 'flex', gap: '8px', overflowX: 'auto', marginBottom: '24px' }}>
              <button 
                type="button" className="secondary" style={{ opacity: appendCategory === null ? 1 : 0.6 }}
                onClick={() => setAppendCategory(null)}
              >
                Any Category
              </button>
              {appendCategories.map(cat => (
                <button 
                  type="button" key={cat} className="secondary" style={{ opacity: appendCategory === cat ? 1 : 0.6 }}
                  onClick={() => setAppendCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div style={{ display: 'grid', gap: '12px' }}>
              {filteredAppendTemplates.map(t => (
                <button 
                  key={t.id}
                  onClick={() => { setSelectedAppendTemplate(t); setPreviewSection(null); setAppendError(null); }}
                  style={{ 
                    padding: '16px', border: '1px solid var(--border-color)', borderRadius: '12px', 
                    cursor: 'pointer', textAlign: 'left', background: 'var(--bg-secondary)', color: 'inherit', width: '100%' 
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '4px', fontSize: '16px' }}>{t.name}</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t.category || 'Uncategorized'}</div>
                </button>
              ))}
              {filteredAppendTemplates.length === 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>No templates found.</p>}
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, fontSize: '20px' }}>{selectedAppendTemplate.name}</h3>
              <button className="secondary" onClick={() => { setSelectedAppendTemplate(null); setAppendError(null); }}>
                Change Template
              </button>
            </div>
            
            <p style={{ fontWeight: 500, marginBottom: '12px' }}>Select section to append:</p>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
              <button className={previewSection === 'contextText' ? 'primary' : 'secondary'} onClick={() => { setPreviewSection('contextText'); setAppendError(null); }}>Context</button>
              <button className={previewSection === 'taskText' ? 'primary' : 'secondary'} onClick={() => { setPreviewSection('taskText'); setAppendError(null); }}>Task</button>
              <button className={previewSection === 'formatText' ? 'primary' : 'secondary'} onClick={() => { setPreviewSection('formatText'); setAppendError(null); }}>Format</button>
            </div>

            {previewSection && (
              <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '16px', borderRadius: '12px', marginBottom: '24px' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--text-secondary)' }}>Preview (Appends to bottom)</h4>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '14px', color: 'var(--text-primary)', lineHeight: '1.5' }}>
                  {selectedAppendTemplate[previewSection] || <em style={{ color: 'var(--text-secondary)' }}>This section is empty.</em>}
                </div>
              </div>
            )}

            {appendError && (
              <div role="alert" style={{ color: 'var(--danger-text)', fontSize: '14px', fontWeight: 500, marginBottom: '24px', padding: '12px', border: '1px solid var(--danger-text)', borderRadius: '8px' }}>
                {appendError}
              </div>
            )}

            <div className="action-row" style={{ marginTop: '32px' }}>
              <button className="secondary" onClick={closeAppendView}>Cancel</button>
              <button 
                className="primary" disabled={!previewSection || !selectedAppendTemplate[previewSection]}
                onClick={() => {
                  const payload = getAppendPayload(draftTemplate, selectedAppendTemplate, previewSection!);
                  if (payload.success) {
                    onAppendToDraft(previewSection!, payload.textToAppend, payload.newVariables);
                    closeAppendView();
                  } else {
                    setAppendError(payload.error);
                  }
                }}
              >
                Confirm Append
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div 
      onKeyDownCapture={handleEditorEscape}
      style={{ maxWidth: '500px', margin: '0 auto', padding: '0 20px', animation: 'fadeIn 0.2s ease-in-out', outline: 'none' }}
    >
      <h2 id="template-title" style={{ fontSize: '24px', fontWeight: 600, marginTop: 0, marginBottom: draftTemplate.strategyNote ? '12px' : '24px' }}>
        {draftTemplate.name}
      </h2>
      
      {draftTemplate.strategyNote && (
        <div style={{ fontSize: '13px', color: 'var(--accent-blue, #0284c7)', backgroundColor: 'rgba(2, 132, 199, 0.08)', padding: '12px 16px', borderRadius: '8px', marginBottom: '24px', borderLeft: '3px solid var(--accent-blue, #0284c7)', lineHeight: '1.5' }}>
          <strong>💡 Strategy Note:</strong> {draftTemplate.strategyNote}
        </div>
      )}
      
      <div style={{ padding: '12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px', marginBottom: '24px' }}>
        <h3 style={{ fontSize: '13px', margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>Original Question</h3>
        <textarea 
          className="readonly-text"
          readOnly
          rows={3}
          value={sessionState.originalText}
          aria-label="Your original question"
          style={{ width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px' }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label htmlFor="ctx-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Context (Background)</label>
          <textarea 
            id="ctx-input" rows={2} value={draftTemplate.contextText} autoFocus
            onChange={(e) => handleSectionChange('contextText', e.target.value)} 
            style={{ width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px' }}
          />
        </div>
        <div>
          <label htmlFor="tsk-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Task (Action)</label>
          
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', padding: '8px 12px', borderRadius: '6px', marginBottom: '8px' }}>
            Your text is added here automatically. Keep <code style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>{'{{user_input}}'}</code> in the task.
          </div>
          
          <textarea 
            id="tsk-input" rows={3} value={draftTemplate.taskText} 
            onChange={(e) => handleSectionChange('taskText', e.target.value)} 
            style={{ width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px' }}
          />
        </div>
        <div>
          <label htmlFor="fmt-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Format (Presentation)</label>
          <textarea 
            id="fmt-input" rows={2} value={draftTemplate.formatText} 
            onChange={(e) => handleSectionChange('formatText', e.target.value)} 
            style={{ width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px' }}
          />
        </div>

        {draftTemplate.variables.filter(v => v.name !== 'user_input').map(v => (
          <div key={v.name}>
            <label htmlFor={`var-${v.name}`} style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>
              {v.label} {v.required && '*'}
            </label>
            <input 
              id={`var-${v.name}`} type="text" required={v.required} aria-required={v.required}
              value={draftVariables[v.name] ?? ''} 
              onChange={(e) => handleVariableChange(v.name, e.target.value)} 
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: '24px', padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '12px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <h3 style={{ fontSize: '14px', margin: 0 }}>Final Preview</h3>
          {customPrompt !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'right' }}>
              <span style={{ fontSize: '11px', color: 'var(--warning-text, #d97706)', maxWidth: '260px', lineHeight: '1.3' }}>
                <strong>Manual version:</strong> Changes to the fields above will not update this text. Reset to generated to include them.
              </span>
              <button className="secondary" style={{ fontSize: '11px', padding: '4px 8px', flexShrink: 0 }} onClick={() => setCustomPrompt(null)}>
                Reset to generated
              </button>
            </div>
          )}
        </div>

        {!builderResult.success ? (
          <div role="alert" style={{ color: 'var(--danger-text)', fontSize: '13px', fontWeight: 500 }}>
            {builderResult.code}: {builderResult.error} {builderResult.details || ''}
          </div>
        ) : (
          <textarea 
            rows={6}
            style={{ width: '100%', padding: '12px', fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.5', border: '1px solid var(--border-color)', borderRadius: '6px', whiteSpace: 'pre-wrap', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            value={displayPrompt} 
            onChange={(e) => setCustomPrompt(e.target.value)}
            aria-label="Final assembled prompt preview (Editable)"
          />
        )}

        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center' }}>
          <button ref={appendButtonRef} className="secondary" onClick={() => setAppendViewOpen(true)}>
            + Add to Prompt
          </button>
        </div>
      </div>

      {showPrivacy && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-secondary)', padding: '10px 14px', borderRadius: '6px', marginBottom: '16px', border: '1px solid var(--border-color)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🛡️</span>
            <span><strong>Human Review Required:</strong> CardiPal does not scan your text. Please verify you have removed all personal or sensitive information before pasting into any AI tool.</span>
          </span>
          <button 
            type="button" 
            aria-label="Dismiss privacy reminder"
            onClick={() => setShowPrivacy(false)} 
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', color: 'currentColor', opacity: 0.6, fontSize: '14px' }}
          >✕</button>
        </div>
      )}

      {/* INSERT THIS NEW BLOCK HERE */}
      <div style={{ padding: '12px 14px', backgroundColor: 'var(--bg-secondary)', borderLeft: '3px solid var(--accent-blue, #0284c7)', borderRadius: '4px 8px 8px 4px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '16px' }}>
        <strong style={{ color: 'var(--text-primary)' }}>After AI responds:</strong> Check important claims against original sources. Recalculate key numbers, question conclusions without evidence, and mark what remains uncertain before using the answer. <em>CardiPal does not verify it for you.</em>
      </div>

      <div aria-live="polite" style={{ marginBottom: '12px', minHeight: '20px', fontSize: '13px', color: 'var(--accent-blue)', fontWeight: 500 }}>
        {copyFeedback}
      </div>

      <div className="action-row">
        <button className="secondary" onClick={onBack}>Back</button>
        <button 
          className="secondary" disabled={pendingAction !== null}
          onClick={() => executeCopy(sessionState.originalText, 'Original')}
        >
          {pendingAction === 'Original' ? 'Copying...' : 'Copy Original'}
        </button>
        <button 
          className="primary" disabled={!builderResult.success || !displayPrompt || pendingAction !== null} 
          onClick={() => builderResult.success && executeCopy(displayPrompt, 'Prompt')}
        >
          {pendingAction === 'Prompt' ? 'Copying...' : 'Copy Prompt'}
        </button>
      </div>
    </div>
  );
}