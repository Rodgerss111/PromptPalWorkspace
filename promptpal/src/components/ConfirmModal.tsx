interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
}

export function ConfirmModal({ 
  isOpen, 
  title, 
  message, 
  confirmText = 'Confirm', 
  cancelText = 'Cancel', 
  onConfirm, 
  onCancel, 
  isDestructive = true 
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div style={{ 
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
      backgroundColor: 'rgba(0, 0, 0, 0.65)', 
      backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', 
      zIndex: 9999, padding: '20px' 
    }}>
      <div role="dialog" aria-modal="true" style={{ 
        backgroundColor: 'var(--bg-color)', 
        border: '1px solid var(--border-color)', 
        borderRadius: '12px', padding: '24px', 
        maxWidth: '420px', width: '100%', 
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)' 
      }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '18px' }}>{title}</h3>
        <p style={{ margin: '0 0 24px 0', fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
          <button className="secondary" onClick={onCancel}>{cancelText}</button>
          <button 
            className={isDestructive ? "" : "primary"} 
            style={isDestructive ? { backgroundColor: 'var(--danger-text)', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '8px', cursor: 'pointer', fontWeight: 500 } : {}} 
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}