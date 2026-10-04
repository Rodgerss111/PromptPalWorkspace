import type { Template } from '../types';

export type BuilderResult =
  | { success: true; prompt: string }
  | { success: false; error: string; code: string; details?: string };

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLACEHOLDER_REGEX = /\{\{([^}]+)\}\}/g;
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

// 1. Definition Validation (Blueprint Contract)
export function validateTemplateBlueprint(template: unknown): { success: true } | { success: false; error: string; code: string; details?: string } {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return { success: false, error: "Invalid template object.", code: "INVALID_TEMPLATE" };
  }
  
  const t = template as Template;
  
  if (!t.id || !t.name) {
    return { success: false, error: "Template missing id or name.", code: "MISSING_METADATA" };
  }
  if (typeof t.contextText !== 'string' || typeof t.taskText !== 'string' || typeof t.formatText !== 'string') {
    return { success: false, error: "Template sections must be strings.", code: "INVALID_TEMPLATE_SECTIONS" };
  }
  if (!Array.isArray(t.variables)) {
    return { success: false, error: "Template variables must be an array.", code: "INVALID_TEMPLATE_VARIABLES" };
  }

  const declaredNames = new Set<string>();
  const requiredVars = new Set<string>();
  let hasRequiredUserInput = false;

  for (const v of t.variables) {
    if (!v || typeof v.name !== 'string') {
      return { success: false, error: "Invalid variable definition.", code: "INVALID_VARIABLE_DEFINITION" };
    }
    if (!IDENTIFIER_REGEX.test(v.name)) {
      return { success: false, error: `Invalid variable name: ${v.name}`, code: "INVALID_VARIABLE_NAME" };
    }
    if (declaredNames.has(v.name)) {
      return { success: false, error: `Duplicate declaration: ${v.name}`, code: "DUPLICATE_DECLARATION" };
    }
    declaredNames.add(v.name);

    if (v.required) {
      requiredVars.add(v.name);
      if (v.name === 'user_input') hasRequiredUserInput = true;
    }
  }

  if (!hasRequiredUserInput) {
    return { success: false, error: "'user_input' must be declared and required.", code: "MISSING_USER_INPUT_DECLARATION" };
  }

  if (!/\{\{\s*user_input\s*\}\}/.test(t.taskText)) {
    return { success: false, error: "{{user_input}} must be inside Task section.", code: "USER_INPUT_NOT_IN_TASK" };
  }

  const combinedText = `${t.contextText} ${t.taskText} ${t.formatText}`;
  const strippedText = combinedText.replace(PLACEHOLDER_REGEX, '');
  if (strippedText.includes('{{') || strippedText.includes('}}')) {
    return { success: false, error: "Malformed brace syntax detected.", code: "MALFORMED_SYNTAX" };
  }

  const usedVars = new Set<string>();
  let match;
  PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = PLACEHOLDER_REGEX.exec(combinedText)) !== null) {
    const varName = match[1].trim();
    if (!declaredNames.has(varName)) {
      return { success: false, error: `Undeclared variable used: ${varName}`, code: "UNDECLARED_VARIABLE", details: varName };
    }
    usedVars.add(varName);
  }

  for (const reqVar of requiredVars) {
    if (!usedVars.has(reqVar)) {
      return { success: false, error: `Required variable '${reqVar}' is declared but never used.`, code: "UNUSED_REQUIRED_VARIABLE" };
    }
  }

  return { success: true };
}

// 2. Value Validation (Assembly Contract)
export function assemblePrompt(template: Template, suppliedValues: unknown): BuilderResult {
  // Enforce blueprint integrity before processing values
  const blueprintCheck = validateTemplateBlueprint(template);
  if (!blueprintCheck.success) {
    return blueprintCheck;
  }

  if (!suppliedValues || typeof suppliedValues !== 'object' || Array.isArray(suppliedValues)) {
    return { success: false, error: "Supplied values must be a dictionary object.", code: "INVALID_PAYLOAD_TYPE" };
  }

  const valuesDict = suppliedValues as Record<string, unknown>;
  const resolvedValues = new Map<string, string>();

  for (const v of template.variables) {
    const rawValue = hasOwn(valuesDict, v.name) ? valuesDict[v.name] : undefined;
    const finalValue = rawValue !== undefined ? rawValue : v.defaultValue;

    if (typeof finalValue !== 'string') {
      return { success: false, error: `Value for ${v.name} must be a string.`, code: "INVALID_VALUE_TYPE" };
    }

    if (v.required && finalValue.trim() === '') {
      return { success: false, error: `Missing required explicit input for: ${v.label || v.name}`, code: "MISSING_REQUIRED_VALUE" };
    }
    resolvedValues.set(v.name, finalValue);
  }

  const parseSection = (text: string): string => {
    return text.replace(PLACEHOLDER_REGEX, (_, varName) => {
      return resolvedValues.get(varName.trim()) || '';
    });
  };

  const contextParsed = parseSection(template.contextText);
  const taskParsed = parseSection(template.taskText);
  const formatParsed = parseSection(template.formatText);

  return { 
    success: true, 
    prompt: `Context: ${contextParsed}\n\nTask: ${taskParsed}\n\nFormat: ${formatParsed}` 
  };
}