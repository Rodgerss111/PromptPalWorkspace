import { useMemo, useState, useRef, useEffect } from 'react';
import type { Template } from '../types';

interface TemplateLibraryProps {
  templates: Template[];
  favoriteIds: string[];
  searchQuery: string;
  theme: 'light' | 'dark'; // Added theme prop
  onSelectTemplate: (t: Template) => void;
  onToggleFavorite: (id: string) => void;
  onEditTemplate: (t: Template, mode: 'edit' | 'duplicate') => void;
  onDeleteTemplate: (id: string) => void;
  mutationsDisabled: boolean;
}

export function TemplateLibrary({ 
  templates, favoriteIds, searchQuery, theme, onSelectTemplate, onToggleFavorite, onEditTemplate, onDeleteTemplate, mutationsDisabled 
}: TemplateLibraryProps) {
  
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  
  // Tooltip "Mini Screen" State
  const [tooltip, setTooltip] = useState<{ t: Template, x: number, y: number, alignBottom: boolean } | null>(null);
  const hoverTimeout = useRef<number | null>(null);

  const filtered = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return templates.filter(t => 
      t.name.toLowerCase().includes(query) || 
      t.category?.toLowerCase().includes(query)
    );
  }, [templates, searchQuery]);

  const grouped = useMemo(() => {
    const groups: Record<string, Template[]> = {};

    filtered.forEach(t => {
      const cat = t.category?.trim() || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    });

    const result: Record<string, Template[]> = {};
    Object.keys(groups).sort((a, b) => a.localeCompare(b)).forEach(k => {
      result[k] = groups[k];
    });

    return result;
  }, [filtered]);

  const handleMouseEnter = (e: React.MouseEvent, t: Template) => {
    setHoveredId(t.id);
    const rect = e.currentTarget.getBoundingClientRect();
    
    const alignBottom = rect.bottom > window.innerHeight - 120;
    
    if (hoverTimeout.current) window.clearTimeout(hoverTimeout.current);
    
    hoverTimeout.current = window.setTimeout(() => {
      setTooltip({
        t,
        x: rect.left + 16,
        y: alignBottom ? rect.top - 8 : rect.bottom + 8,
        alignBottom
      });
    }, 400);
  };

  const handleMouseLeave = () => {
    setHoveredId(null);
    if (hoverTimeout.current) window.clearTimeout(hoverTimeout.current);
    setTooltip(null);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeout.current) window.clearTimeout(hoverTimeout.current);
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <h3 style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 8px 4px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {category}
            </h3>
            
            <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
              {items.map((t, index) => {
                const isFav = favoriteIds.includes(t.id);
                
                return (
                  <div 
                    key={t.id} 
                    onMouseEnter={(e) => handleMouseEnter(e, t)}
                    onMouseLeave={handleMouseLeave}
                    style={{ display: 'flex', flexDirection: 'column', padding: '10px 12px', borderBottom: index === items.length - 1 ? 'none' : '1px solid var(--border-color)', boxSizing: 'border-box' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                      <button
                        onClick={() => onSelectTemplate(t)}
                        style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', lineHeight: '1.3' }}
                      >
                        {t.name}
                      </button>
                      
                      <div style={{ display: 'flex', gap: '4px', flexShrink: 0, opacity: hoveredId === t.id || isFav ? 1 : 0.4, transition: 'opacity 0.15s ease' }}>
                        <button 
                          onClick={(e) => { e.stopPropagation(); onToggleFavorite(t.id); }}
                          disabled={mutationsDisabled}
                          style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', fontSize: '14px', color: isFav ? '#fbbf24' : 'var(--text-secondary)' }}
                          title={isFav ? "Unfavorite" : "Favorite"}
                          aria-label={isFav ? "Unfavorite" : "Favorite"}
                        >
                          {isFav ? '★' : '☆'}
                        </button>
                        {!t.isBuiltIn && (
                          <>
                            <button 
                              onClick={(e) => { e.stopPropagation(); onEditTemplate(t, 'edit'); }}
                              disabled={mutationsDisabled}
                              style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-secondary)' }}
                              title="Edit Template"
                            >
                              ✎
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); onDeleteTemplate(t.id); }}
                              disabled={mutationsDisabled}
                              style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', fontSize: '12px', color: 'var(--danger-text)' }}
                              title="Delete Template"
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {Object.keys(grouped).length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '13px', textAlign: 'center', margin: '20px 0' }}>
            No templates found matching your search.
          </div>
        )}
      </div>

      {/* SOLID "MINI SCREEN" TOOLTIP */}
      {tooltip && (
        <div 
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            transform: tooltip.alignBottom ? 'translateY(-100%)' : 'none',
            width: '320px',
            maxWidth: '90vw',
            // Hardcoded solid HEX colors guarantee zero transparency
            backgroundColor: theme === 'dark' ? '#1c1c1e' : '#ffffff', 
            border: `1px solid ${theme === 'dark' ? '#333' : '#e5e5e5'}`,
            borderRadius: '8px',
            padding: '12px',
            boxShadow: theme === 'dark' 
              ? '0 10px 30px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255,255,255,0.1)' 
              : '0 10px 30px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0,0,0,0.05)', 
            zIndex: 99999, 
            opacity: 1, 
            pointerEvents: 'none', 
            animation: 'fadeIn 0.2s ease-out',
            boxSizing: 'border-box'
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            {tooltip.t.name}
          </div>
          
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4', marginBottom: '10px' }}>
            {(tooltip.t as any).strategyNote || tooltip.t.contextText}
          </div>
          
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {tooltip.t.variables.map(v => (
              <span key={v.name} style={{ fontSize: '10px', backgroundColor: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>
                {v.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}