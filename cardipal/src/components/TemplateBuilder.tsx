import { useState, useMemo } from 'react';
import { validateTemplateBlueprint } from '../utils/builder';
import type { Template, Variable } from '../types';

export interface BuilderSession {
  mode: 'create' | 'edit' | 'duplicate';
  template: Template | null;
}

interface TemplateBuilderProps {
  session: BuilderSession;
  onSave: (template: Template) => Promise<boolean>;
  onCancel: () => void;
  isSaving: boolean;
  storageLocked: boolean;
  requestConfirmation: (message: string, onConfirm: () => void) => void;
}

type InternalVariable = Variable & { _key: string; _isReserved: boolean };

// FIXED: requestConfirmation is now correctly destructured here
export function TemplateBuilder({ session, onSave, onCancel, isSaving, storageLocked, requestConfirmation }: TemplateBuilderProps) {
  const isNew = session.mode === 'create' || session.mode === 'duplicate';
  const base = session.template;

  const [isDirty, setIsDirty] = useState(false);
  const [id] = useState(() => isNew ? crypto.randomUUID() : (base?.id || crypto.randomUUID()));
  const [createdAt] = useState(() => isNew ? Date.now() : (base?.createdAt || Date.now()));
  
  const [name, setName] = useState(() => session.mode === 'duplicate' ? `${base?.name || ''} (Copy)` : (base?.name || ''));
  const [category, setCategory] = useState(base?.category || '');
  const [contextText, setContextText] = useState(base?.contextText || '');
  const [taskText, setTaskText] = useState(base?.taskText || '');
  const [formatText, setFormatText] = useState(base?.formatText || '');
  
  const [variables, setVariables] = useState<InternalVariable[]>(() => {
    if (base) {
      return base.variables.map(v => ({ ...v, _key: crypto.randomUUID(), _isReserved: v.name === 'user_input' }));
    }
    return [{ name: 'user_input', label: 'Primary Input', required: true, defaultValue: '', _key: crypto.randomUUID(), _isReserved: true }];
  });

  const addVariable = () => {
    setVariables(prev => [...prev, { name: `new_var_${crypto.randomUUID().slice(0, 4)}`, label: 'New Variable', required: false, defaultValue: '', _key: crypto.randomUUID(), _isReserved: false }]);
    setIsDirty(true);
  };

  const updateVariable = (keyId: string, field: keyof Variable, value: string | boolean) => {
    setVariables(prev => prev.map(v => {
      if (v._key !== keyId) return v;
      if (field === 'name' && value === 'user_input' && !v._isReserved) return v;
      if (v._isReserved && field === 'defaultValue') return { ...v, defaultValue: '' };
      return { ...v, [field]: value };
    }));
    setIsDirty(true);
  };

  const removeVariable = (keyId: string) => {
    setVariables(prev => prev.filter(v => v._key !== keyId));
    setIsDirty(true);
  };

  const handleTextChange = (setter: React.Dispatch<React.SetStateAction<string>>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setter(e.target.value);
    setIsDirty(true);
  };

  // FIXED: Only prompts the user if they actually modified something
  const handleCancel = () => {
    if (isDirty) {
      requestConfirmation("Discard unsaved changes?", () => {
        onCancel();
      });
    } else {
      onCancel();
    }
  };

  const draftTemplate = useMemo((): Template => ({
    id,
    schemaVersion: 1,
    name: name.trim(),
    category: category.trim(),
    contextText,
    taskText,
    formatText,
    variables: variables.map(({ _key, _isReserved, ...rest }) => rest),
    isBuiltIn: false,
    createdAt,
    updatedAt: Date.now(), 
  }), [id, name, category, contextText, taskText, formatText, variables, createdAt]);

  const validation = useMemo(() => {
    if (!name.trim()) return { success: false, error: 'Template Name is required.' };
    return validateTemplateBlueprint(draftTemplate);
  }, [name, draftTemplate]);

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto', padding: '0 20px' }}>
      <h2 style={{ marginTop: 0 }}>
        {session.mode === 'create' ? 'Create Template' : session.mode === 'duplicate' ? 'Duplicate Template' : 'Edit Template'}
      </h2>
      
      {storageLocked && (
        <div role="alert" style={{ color: 'var(--danger-text)', fontSize: '13px', marginBottom: '16px', padding: '12px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--danger-text)', borderRadius: '4px' }}>
          <strong>Storage is read-only.</strong> Your unsaved template remains below. Copy its contents manually or reset storage before saving.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
        <div>
          <label htmlFor="tpl-name" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Template Name *</label>
          <input id="tpl-name" type="text" value={name} onChange={handleTextChange(setName)} placeholder="e.g., Code Reviewer" style={{ width: '100%' }} disabled={isSaving} />
        </div>
        <div>
          <label htmlFor="tpl-cat" style={{ display: 'block', fontWeight: 500, marginBottom: '6px' }}>Category</label>
          <input id="tpl-cat" type="text" value={category} onChange={handleTextChange(setCategory)} placeholder="e.g., Development" style={{ width: '100%' }} disabled={isSaving} />
        </div>

        <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>Prompt Structure</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label htmlFor="tpl-ctx" style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Context (Background)</label>
              <textarea id="tpl-ctx" rows={2} value={contextText} onChange={handleTextChange(setContextText)} placeholder="e.g., Act as a senior developer..." style={{ width: '100%' }} disabled={isSaving} />
            </div>
            <div>
              <label htmlFor="tpl-tsk" style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Task (Action) * - Must contain {'{{user_input}}'}</label>
              <textarea id="tpl-tsk" rows={3} value={taskText} onChange={handleTextChange(setTaskText)} placeholder="e.g., Review this code: {{user_input}}" style={{ width: '100%' }} disabled={isSaving} />
            </div>
            <div>
              <label htmlFor="tpl-fmt" style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Format (Presentation)</label>
              <textarea id="tpl-fmt" rows={2} value={formatText} onChange={handleTextChange(setFormatText)} placeholder="e.g., Output as a markdown table." style={{ width: '100%' }} disabled={isSaving} />
            </div>
          </div>
        </div>

        <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Variables</h3>
            <button className="secondary" style={{ fontSize: '11px', padding: '4px 8px' }} onClick={addVariable} disabled={isSaving}>+ Add Variable</button>
          </div>
          
          {variables.map((v) => (
            <div key={v._key} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ flex: '1 1 45%' }}>
                <label htmlFor={`var-name-${v._key}`} style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Variable Name *</label>
                <input id={`var-name-${v._key}`} type="text" value={v.name} onChange={e => updateVariable(v._key, 'name', e.target.value)} disabled={v._isReserved || isSaving} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: '1 1 45%' }}>
                <label htmlFor={`var-label-${v._key}`} style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Display Label</label>
                <input id={`var-label-${v._key}`} type="text" value={v.label} onChange={e => updateVariable(v._key, 'label', e.target.value)} disabled={isSaving} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: '1 1 45%' }}>
                <label htmlFor={`var-def-${v._key}`} style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>Default Value</label>
                <input id={`var-def-${v._key}`} type="text" value={v.defaultValue} onChange={e => updateVariable(v._key, 'defaultValue', e.target.value)} disabled={v._isReserved || isSaving} placeholder={v._isReserved ? 'Must remain empty' : ''} style={{ width: '100%' }} />
              </div>
              <div style={{ flex: '1 1 45%', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                  <input type="checkbox" checked={v.required} onChange={e => updateVariable(v._key, 'required', e.target.checked)} disabled={v._isReserved || isSaving} />
                  Required Input
                </label>
                {!v._isReserved && (
                  <button className="secondary" style={{ color: 'var(--danger-text)', padding: '4px 8px', fontSize: '11px' }} onClick={() => removeVariable(v._key)} disabled={isSaving}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {!validation.success && (
        <div role="alert" style={{ color: 'var(--danger-text)', fontSize: '13px', marginBottom: '16px', padding: '8px', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
          <strong>Error:</strong> {validation.error}
        </div>
      )}

      <div className="action-row">
        <button className="secondary" onClick={handleCancel} disabled={isSaving}>Cancel</button>
        <button className="primary" disabled={!validation.success || isSaving || storageLocked} onClick={() => onSave(draftTemplate)}>
          {isSaving ? 'Saving...' : 'Save Template'}
        </button>
      </div>
    </div>
  );
}