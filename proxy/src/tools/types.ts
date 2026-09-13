/**
 * JSON Schema definition following the OpenAI function calling spec.
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  nullable?: boolean;
}

/**
 * OpenAI-compatible function tool definition.
 */
export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/**
 * A parsed tool call from the LLM response.
 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a single tool call (server-side execution loop).
 */
export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

/**
 * Context passed to registered tool handlers during execution.
 */
export interface ToolContext {
  messages: unknown[];
  turn: number;
  model: string;
}
