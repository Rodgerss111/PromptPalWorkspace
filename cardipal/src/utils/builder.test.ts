import { describe, it, expect } from 'vitest';
import { assemblePrompt } from './builder';
import type { Template } from '../types';

describe('assemblePrompt', () => {
  const getBaseTemplate = (): Template => ({
    id: 'test-1',
    schemaVersion: 1,
    name: 'Test',
    category: 'Test',
    contextText: 'Context block',
    taskText: '{{user_input}}',
    formatText: 'Format block',
    variables: [{ name: 'user_input', label: 'Input', required: true, defaultValue: 'default_input' }],
    isBuiltIn: true,
    createdAt: 0,
    updatedAt: 0,
  });

  it('1. preserves exact whitespace from user input (FR05)', () => {
    const template = getBaseTemplate();
    const rawInput = '  \nMy original text\n  ';
    const result = assemblePrompt(template, { user_input: rawInput });
    expect(result.success).toBe(true);
    if (result.success) expect(result.prompt).toBe(`Context: Context block\n\nTask: ${rawInput}\n\nFormat: Format block`);
  });

  it('2. rejects non-string values at runtime', () => {
    const template = getBaseTemplate();
    template.variables.push({ name: 'extra', label: 'Extra', required: false, defaultValue: '' });
    template.taskText += ' {{extra}}';
    const result = assemblePrompt(template, { user_input: "valid", extra: { polluted: "yes" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('INVALID_VALUE_TYPE');
  });

  it('3. ignores inherited properties via Object.create', () => {
    const template = getBaseTemplate();
    // Payload inherits 'user_input' but lacks it as an own property
    const inheritedPayload = Object.create({ user_input: "Inherited question" });
    const result = assemblePrompt(template, inheritedPayload);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('MISSING_USER_INPUT_VALUE');
  });

  it('4. rejects invalid template structure without crashing', () => {
    // @ts-expect-error - Testing runtime bounds
    const result = assemblePrompt({ contextText: "Missing arrays" }, { user_input: "test" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('INVALID_TEMPLATE_VARIABLES');
  });

  it('5. rejects missing user_input despite a declared default', () => {
    const template = getBaseTemplate();
    const result = assemblePrompt(template, { }); // Empty payload
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('MISSING_USER_INPUT_VALUE');
  });

  it('6. rejects cross-section unmatched brackets', () => {
    const template = getBaseTemplate();
    template.contextText = 'Context {{';
    template.taskText = 'user_input}}';
    const result = assemblePrompt(template, { user_input: 'test' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe('MALFORMED_SYNTAX');
  });

  it('7. reports undeclared placeholders with details', () => {
    const template = getBaseTemplate();
    template.taskText = '{{user_input}} {{missing_var}}';
    const result = assemblePrompt(template, { user_input: 'test' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('UNDECLARED_VARIABLE');
      expect(result.details).toBe('missing_var');
    }
  });

  it('8. preserves Unicode and literal braces in user input', () => {
    const template = getBaseTemplate();
    const complexInput = 'Hello 🌍 { literal } {{ not_a_var }}';
    const result = assemblePrompt(template, { user_input: complexInput });
    expect(result.success).toBe(true);
    if (result.success) expect(result.prompt).toContain(`Task: ${complexInput}`);
  });

  it('9. assembles 10,000 characters within 100ms', () => {
    const template = getBaseTemplate();
    const largeInput = 'A'.repeat(10000);
    const start = performance.now();
    const result = assemblePrompt(template, { user_input: largeInput });
    const end = performance.now();
    expect(result.success).toBe(true);
    expect(end - start).toBeLessThan(100);
  });
});