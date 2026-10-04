import type { Template } from '../types';

export const starterTemplates: Template[] = [
  {
    id: 't-learn',
    schemaVersion: 1,
    name: 'Learn Fundamentals',
    category: 'Learning',
    contextText: 'I am a {{level}} studying this topic.',
    taskText: 'Explain the core concepts of "{{user_input}}". Provide a practical example and a common analogy.',
    formatText: 'Use clear headings and avoid overly dense jargon.',
    variables: [
      { name: 'user_input', label: 'Topic or Question', required: true, defaultValue: '' },
      { name: 'level', label: 'Experience Level', required: false, defaultValue: 'beginner' }
    ],
    isBuiltIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 't-summarize',
    schemaVersion: 1,
    name: 'Summarize Material',
    category: 'Reading',
    contextText: 'I need to process the following source material: {{source_text}}',
    taskText: 'Review the material and fulfill this instruction: "{{user_input}}". Extract the primary thesis and supporting arguments.',
    formatText: 'Present the summary in bullet points.',
    variables: [
      { name: 'user_input', label: 'Instruction', required: true, defaultValue: '' },
      { name: 'source_text', label: 'Source Material', required: true, defaultValue: '' } // Empty default forces explicit input
    ],
    isBuiltIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 't-compare',
    schemaVersion: 1,
    name: 'Compare Concepts',
    category: 'Learning',
    contextText: 'I am trying to understand the differences and similarities between two concepts.',
    taskText: 'Compare Concept A: "{{user_input}}" with Concept B: "{{concept_b}}". Explain where their use-cases overlap and diverge.',
    formatText: 'Use a structured comparison with distinct sections for similarities and differences.',
    variables: [
      { name: 'user_input', label: 'Concept A', required: true, defaultValue: '' },
      { name: 'concept_b', label: 'Concept B', required: true, defaultValue: '' }
    ],
    isBuiltIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 't-practice',
    schemaVersion: 1,
    name: 'Practice Questions',
    category: 'Testing',
    contextText: 'I am preparing for an exam and need to test my knowledge.',
    taskText: 'Generate 3 practice questions about "{{user_input}}" at a {{difficulty}} difficulty level. Wait for my answer before providing the solution.',
    formatText: 'Ask one question at a time. Include a brief hint.',
    variables: [
      { name: 'user_input', label: 'Topic', required: true, defaultValue: '' },
      { name: 'difficulty', label: 'Difficulty', required: false, defaultValue: 'medium' }
    ],
    isBuiltIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 't-writing',
    schemaVersion: 1,
    name: 'Improve My Writing',
    category: 'Writing',
    contextText: 'Review the following draft: {{rough_draft}}',
    taskText: 'Act as an expert editor. Focus on this goal: "{{user_input}}". Suggest improvements for clarity, tone, and structure.',
    formatText: 'Provide a brief critique, followed by the revised text clearly separated.',
    variables: [
      { name: 'user_input', label: 'Editing Goal', required: true, defaultValue: '' },
      { name: 'rough_draft', label: 'Your Draft', required: true, defaultValue: '' }
    ],
    isBuiltIn: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
];