import { useReducer, useRef, useCallback } from 'react';
import { SessionState } from '../types';

export type SessionAction = 
  | { type: 'START_MANUAL'; payload: SessionState }
  | { type: 'UPDATE_EDITOR'; payload: Partial<SessionState['editorValues']> }
  | { type: 'SET_MANUAL_INPUT'; payload: string }
  | { type: 'CLEAR' };

export function sessionReducer(state: SessionState | null, action: SessionAction): SessionState | null {
  switch (action.type) {
    case 'START_MANUAL':
      return action.payload;
    case 'UPDATE_EDITOR':
      if (!state) return null;
      return { 
        ...state, 
        editorValues: { ...state.editorValues, ...action.payload } 
      };
    case 'SET_MANUAL_INPUT':
      if (!state) return null;
      return { ...state, manualInput: action.payload };
    case 'CLEAR':
      return null;
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown session action: ${String(exhaustive)}`);
    }
  }
}

export function useSessionLock() {
  const [session, rawDispatchSession] = useReducer(sessionReducer, null);
  const sessionRef = useRef<SessionState | null>(null);

  const dispatchSession = useCallback((action: SessionAction) => {
    const next = sessionReducer(sessionRef.current, action);
    sessionRef.current = next; 
    rawDispatchSession(action);
  }, []);

  return { session, sessionRef, dispatchSession };
}