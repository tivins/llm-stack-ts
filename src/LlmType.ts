export const LLM_TYPES = ['text-generation', 'text-to-image', 'text-to-speech', 'text-to-music'] as const;

export type LlmType = (typeof LLM_TYPES)[number];

export function isLlmType(value: string): value is LlmType {
  return (LLM_TYPES as readonly string[]).includes(value);
}
