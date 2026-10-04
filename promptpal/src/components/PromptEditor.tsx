import { useMemo, useEffect, useRef } from 'react';
import { assemblePrompt } from '../utils/builder';
import type { Template, SessionState } from '../types';

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
}

export function PromptEditor({ 
  draftTemplate, onTemplateChange, 
  draftVariables, onVariablesChange, 
  sessionState, onBack,
  pendingAction, copyFeedback, executeCopy, invalidateFeedback
}: PromptEditorProps) {
  const isMounted = useRef<boolean>(true);

  const builderResult = useMemo(() => {
    return assemblePrompt(draftTemplate, { 
      ...draftVariables, 
      user_input: sessionState.originalText 
    });
  }, [draftTemplate, draftVariables, sessionState.originalText]);

  useEffect(() => {
    isMounted.current = true;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      isMounted.current = false;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onBack]);

  const handleSectionChange = (section: 'contextText' | 'taskText' | 'formatText', value: string) => {
    onTemplateChange({ ...draftTemplate, [section]: value });
    invalidateFeedback();
  };

  const handleVariableChange = (name: string, value: string) => {
    onVariablesChange({ ...draftVariables, [name]: value });
    invalidateFeedback();
  };

  return (
    <div style={{ maxWidth: '500px', margin: '0 auto', padding: '0 20px' }}>
      <h2 id="template-title" style={{ fontSize: '24px', fontWeight: 600, marginTop: 0 }}>
        {draftTemplate.name}
      </h2>
      
      <div style={{ padding: '12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px', marginBottom: '24px' }}>
        <h3 style={{ fontSize: '13px', margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>Original Question</h3>
        <textarea 
          className="readonly-text"
          readOnly
          rows={3}
          value={sessionState.originalText}
          aria-label="Your original question"
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label htmlFor="ctx-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Context (Background)</label>
          <textarea 
            id="ctx-input"
            rows={2} 
            value={draftTemplate.contextText} 
            onChange={(e) => handleSectionChange('contextText', e.target.value)}
            autoFocus 
          />
        </div>
        <div>
          <label htmlFor="tsk-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Task (Action)</label>
          <textarea 
            id="tsk-input"
            rows={3} 
            value={draftTemplate.taskText} 
            onChange={(e) => handleSectionChange('taskText', e.target.value)} 
          />
        </div>
        <div>
          <label htmlFor="fmt-input" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Format (Presentation)</label>
          <textarea 
            id="fmt-input"
            rows={2} 
            value={draftTemplate.formatText} 
            onChange={(e) => handleSectionChange('formatText', e.target.value)} 
          />
        </div>

        {draftTemplate.variables.filter(v => v.name !== 'user_input').map(v => (
          <div key={v.name}>
            <label htmlFor={`var-${v.name}`} style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>
              {v.label} {v.required && '*'}
            </label>
            <input 
              id={`var-${v.name}`}
              type="text" 
              required={v.required}
              aria-required={v.required}
              value={draftVariables[v.name] ?? ''} 
              onChange={(e) => handleVariableChange(v.name, e.target.value)} 
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: '24px', padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '12px' }}>
        <h3 style={{ fontSize: '14px', margin: '0 0 8px 0' }}>What changed?</h3>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          The starter template initially requested an everyday analogy, a common use-case, and a bulleted format. 
          Please review the final prompt, check any factual claims, and ensure it follows your assignment rules.
        </p>

        <h3 style={{ fontSize: '14px', margin: '0 0 12px 0' }}>Final Preview</h3>
        {!builderResult.success ? (
          <div role="alert" style={{ color: 'var(--danger-text)', fontSize: '13px', fontWeight: 500 }}>
            {builderResult.code}: {builderResult.error} {builderResult.details || ''}
          </div>
        ) : (
          <textarea 
            className="readonly-text"
            readOnly
            rows={6}
            style={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}
            value={builderResult.prompt}
            aria-label="Final assembled prompt preview"
          />
        )}
      </div>

      <div aria-live="polite" style={{ marginTop: '12px', minHeight: '20px', fontSize: '13px', color: 'var(--accent-blue)', fontWeight: 500 }}>
        {copyFeedback}
      </div>

      <div className="action-row">
        <button className="secondary" onClick={onBack}>Back</button>
        <button 
          className="secondary" 
          disabled={pendingAction !== null}
          onClick={() => executeCopy(sessionState.originalText, 'Original')}
        >
          {pendingAction === 'Original' ? 'Copying...' : 'Copy Original'}
        </button>
        <button 
          className="primary" 
          disabled={!builderResult.success || pendingAction !== null} 
          onClick={() => builderResult.success && executeCopy(builderResult.prompt, 'Prompt')}
        >
          {pendingAction === 'Prompt' ? 'Copying...' : 'Copy Prompt'}
        </button>
      </div>
    </div>
  );
}