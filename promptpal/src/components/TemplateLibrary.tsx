import React, { useState, useMemo } from 'react';
import type { Template } from '../types';

interface TemplateLibraryProps {
  templates: Template[];
  favoriteIds: string[];
  onSelectTemplate: (template: Template) => void;
  onToggleFavorite: (id: string) => void;
  onEditTemplate: (template: Template, mode: 'edit' | 'duplicate') => void;
  onDeleteTemplate: (id: string) => void;
  mutationsDisabled?: boolean;
}

export function TemplateLibrary({
  templates,
  favoriteIds,
  onSelectTemplate,
  onToggleFavorite,
  onEditTemplate,
  onDeleteTemplate,
  mutationsDisabled = false
}: TemplateLibraryProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeView, setActiveView] = useState<'All' | 'Favorites'>('All');
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string | null>(null);

  // Derive unique categories dynamically, maintaining first-encountered display casing
  const categories = useMemo(() => {
    const map = new Map<string, string>();
    templates.forEach(t => {
      const raw = t.category?.trim() || 'Uncategorized';
      const key = raw.toLowerCase();
      if (!map.has(key)) map.set(key, raw);
    });
    return Array.from(map.values()).sort();
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    return templates.filter(t => {
      // 1. View Filter
      if (activeView === 'Favorites' && !favoriteIds.includes(t.id)) return false;
      
      // 2. Category Filter (Normalized check)
      const rawCat = t.category?.trim() || 'Uncategorized';
      if (activeCategoryFilter && rawCat.toLowerCase() !== activeCategoryFilter.toLowerCase()) return false;
      
      // 3. Search Filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return t.name.toLowerCase().includes(query) || rawCat.toLowerCase().includes(query);
      }
      
      return true;
    });
  }, [templates, activeView, activeCategoryFilter, searchQuery, favoriteIds]);

  // If a user deletes the last template in a category while viewing it, this resets the filter.
  React.useEffect(() => {
    if (activeCategoryFilter) {
      const exists = categories.some(c => c.toLowerCase() === activeCategoryFilter.toLowerCase());
      if (!exists) setActiveCategoryFilter(null);
    }
  }, [categories, activeCategoryFilter]);

  return (
    <div style={{ padding: '0 20px' }}>
      <input
        type="text"
        placeholder="Search templates..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        style={{ marginBottom: '16px' }}
      />

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
        <button 
          type="button"
          className={activeView === 'All' ? 'primary' : 'secondary'} 
          onClick={() => setActiveView('All')}
          aria-pressed={activeView === 'All'}
        >
          All
        </button>
        <button 
          type="button"
          className={activeView === 'Favorites' ? 'primary' : 'secondary'} 
          onClick={() => setActiveView('Favorites')}
          aria-pressed={activeView === 'Favorites'}
        >
          Favorites
        </button>
      </div>

      <div data-scrollable style={{ display: 'flex', gap: '8px', overflowX: 'auto', marginBottom: '16px', paddingBottom: '4px' }}>
        <button 
          type="button"
          className="secondary" 
          style={{ opacity: activeCategoryFilter === null ? 1 : 0.6 }}
          onClick={() => setActiveCategoryFilter(null)}
          aria-pressed={activeCategoryFilter === null}
        >
          Any Category
        </button>
        {categories.map(cat => (
          <button 
            type="button"
            key={cat} 
            className="secondary"
            style={{ opacity: activeCategoryFilter === cat ? 1 : 0.6 }}
            onClick={() => setActiveCategoryFilter(cat)}
            aria-pressed={activeCategoryFilter === cat}
          >
            {cat}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr' }}>
        {filteredTemplates.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginTop: '20px' }}>
            No templates found.
          </p>
        ) : (
          filteredTemplates.map(t => (
            <div key={t.id} style={{ 
              border: '1px solid var(--border-color)', 
              borderRadius: '12px', 
              padding: '16px', 
              backgroundColor: 'var(--bg-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <h3 style={{ margin: 0, fontSize: '16px' }}>{t.name}</h3>
                <button
                  className="favorite-button"
                  style={{ background: 'none', border: 'none', cursor: mutationsDisabled ? 'not-allowed' : 'pointer', fontSize: '18px', opacity: mutationsDisabled ? 0.5 : 1 }}
                  onClick={() => onToggleFavorite(t.id)}
                  disabled={mutationsDisabled}
                  aria-pressed={favoriteIds.includes(t.id)}
                  aria-label={`${favoriteIds.includes(t.id) ? "Remove" : "Add"} ${t.name} ${favoriteIds.includes(t.id) ? "from" : "to"} favorites`}
                >
                  {favoriteIds.includes(t.id) ? '★' : '☆'}
                </button>
              </div>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {t.category?.trim() || 'Uncategorized'}
              </span>
             <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
      <button className="primary" onClick={() => onSelectTemplate(t)}>
        Use Template
      </button>
      {t.isBuiltIn ? (
        <button className="secondary" onClick={() => onEditTemplate(t, 'duplicate')} disabled={mutationsDisabled}>
          Duplicate & Edit
        </button>
      ) : (
        <>
          <button className="secondary" onClick={() => onEditTemplate(t, 'edit')} disabled={mutationsDisabled}>Edit</button>
          <button className="secondary" onClick={() => onEditTemplate(t, 'duplicate')} disabled={mutationsDisabled}>Duplicate</button>
          <button className="secondary" style={{ color: 'var(--danger-text)' }} onClick={() => onDeleteTemplate(t.id)} disabled={mutationsDisabled}>
            Delete
          </button>
        </>
      )}
    </div>
  </div>
))
        )}
      </div>
    </div>
  );
}