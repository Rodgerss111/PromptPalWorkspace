export interface Template {
  id: string;
  schemaVersion: number; 
  name: string;
  category: string;
  contextText: string;
  taskText: string;
  formatText: string;
  variables: Variable[];
  isBuiltIn: boolean;
  createdAt: number; 
  updatedAt: number; 
  strategyNote?: string; 
}

export interface Variable {
  name: string;      
  label: string;     
  required: boolean;
  defaultValue: string;
}

export interface Preferences {
  favoriteTemplateIds: string[];
  shortcut: string;
  launchAtStartup: boolean;
  iconPosition: number[] | null;
  iconVisible: boolean;
  schemaVersion: number;
  dataRevision: number;
}

export interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoreSnapshot {
  templates: Template[];
  savedPrompts?: SavedPrompt[]; 
  preferences: Preferences;
}

export interface SessionState {
  originalText: string; 
  targetIdentity: string | null; 
  selectionDetails: string | null;
  captureStatus: 'idle' | 'captured' | 'failed' | 'manual';
  manualInput: string;
  editorValues: Record<string, string>;
}

export interface EditorState {
  templateId: string | null;
  variableValues: Record<string, string>; 
}