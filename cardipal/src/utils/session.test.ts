import { expect, test } from 'vitest';
// Adjust import path if you export reduceWorkflow and initialWorkflowState
import { reduceWorkflow, SessionAction } from '../App';

test('reduceWorkflow ignores START_MANUAL and UPDATE_INPUT when a session is active', () => {
  // Added the missing freeform properties to satisfy TypeScript
  const initialState = {
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

  // 1. Establish an active session
  const action1: SessionAction = { 
    type: 'START_MANUAL', 
    session: { originalText: 'First Input', targetIdentity: null, selectionDetails: null, captureStatus: 'manual', manualInput: 'First Input', editorValues: {} }, 
    input: 'First Input' 
  };
  const stateAfterStart = reduceWorkflow(initialState as any, action1);
  
  expect(stateAfterStart.session?.originalText).toBe('First Input');
  expect(stateAfterStart.manualInput).toBe('First Input');

  // 2. Simulate rapid rogue START_MANUAL (e.g., shortcut mashed 3 times)
  const rogueStartAction: SessionAction = { 
    type: 'START_MANUAL', 
    session: { originalText: 'Rogue Input', targetIdentity: null, selectionDetails: null, captureStatus: 'manual', manualInput: 'Rogue Input', editorValues: {} }, 
    input: 'Rogue Input' 
  };
  const stateAfterRogueStart = reduceWorkflow(stateAfterStart, rogueStartAction);

  // Assertion: The original session is strictly preserved
  expect(stateAfterRogueStart.session?.originalText).toBe('First Input');
  expect(stateAfterRogueStart.manualInput).toBe('First Input');

  // 3. Simulate rogue UPDATE_INPUT while session is locked
  const rogueUpdateAction: SessionAction = { type: 'UPDATE_INPUT', value: 'Typing over draft' };
  const stateAfterRogueUpdate = reduceWorkflow(stateAfterStart, rogueUpdateAction);

  // Assertion: Pre-session input remains locked
  expect(stateAfterRogueUpdate.manualInput).toBe('First Input');

  // 4. Verify CLEAR drops everything
  const stateAfterClear = reduceWorkflow(stateAfterRogueUpdate, { type: 'CLEAR' });
  expect(stateAfterClear.session).toBeNull();
  expect(stateAfterClear.manualInput).toBe('');
});