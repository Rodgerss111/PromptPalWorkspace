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
}

export interface Variable {
  name: string;      
  label: string;     
  required: boolean;
  defaultValue: string;
}

export interface SessionState {
  originalText: string; 
  targetIdentity: string | null; 
  selectionDetails: string | null;
  captureStatus: 'idle' | 'captured' | 'failed' | 'manual';
}

export interface EditorState {
  templateId: string | null;
  variableValues: Record<string, string>; 
}