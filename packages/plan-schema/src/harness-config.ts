/**
 * Typed harness configuration schema.
 *
 * Validated at CDK synth time by the HarnessAgent construct, and kept
 * deliberately close to the AgentCore CLI project-config shape so a config
 * iterated in `agentcore dev` transfers without translation.
 */
import { z } from 'zod';

export const GatewayToolSchema = z.object({
  type: z.literal('agentcore_gateway'),
  gatewayArn: z.string().min(1),
  /** Default tool scoping; per-invocation overrides may narrow it further. */
  allowedTools: z.array(z.string().min(1)).optional(),
});

export const BrowserToolSchema = z.object({
  type: z.literal('agentcore_browser'),
  name: z.string().min(1).default('browser'),
});

export const CodeInterpreterToolSchema = z.object({
  type: z.literal('agentcore_code_interpreter'),
  name: z.string().min(1).default('code_interpreter'),
});

export const HarnessToolSchema = z.discriminatedUnion('type', [
  GatewayToolSchema,
  BrowserToolSchema,
  CodeInterpreterToolSchema,
]);

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  strategies: z
    .array(z.enum(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE']))
    .min(1)
    .default(['SEMANTIC']),
  eventExpiryDays: z.number().int().min(1).max(365).default(30),
});

export const HarnessLimitsSchema = z.object({
  maxIterations: z.number().int().min(1).max(100).optional(),
  /** Hard platform cap: 3,600 s per invocation. */
  timeoutSeconds: z.number().int().min(1).max(3_600).optional(),
  maxTokens: z.number().int().min(1).optional(),
});

/** Matches the AWS::BedrockAgentCore::Harness HarnessName CFN constraint. */
export const HARNESS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * Anthropic adaptive-thinking effort levels (live-verified against
 * au.anthropic.claude-*-5: the models reject thinking.type "enabled" /
 * budget_tokens and require type "adaptive" + output_config.effort).
 */
export const THINKING_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export const ThinkingEffortSchema = z.enum(THINKING_EFFORT_LEVELS);
export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;

export const HarnessConfigSchema = z.object({
  name: z
    .string()
    .regex(
      HARNESS_NAME_PATTERN,
      'harness name must start with a letter, use only [a-zA-Z0-9_] (no hyphens), max 40 chars',
    ),
  description: z.string().max(1_024).optional(),
  /** Bedrock model id or inference profile. Omit to use the service default. */
  modelId: z.string().min(1).optional(),
  instructions: z.string().min(1).max(50_000),
  tools: z.array(HarnessToolSchema).max(16).default([]),
  memory: MemoryConfigSchema.optional(),
  limits: HarnessLimitsSchema.optional(),
  temperature: z.number().min(0).max(1).optional(),
  /**
   * Anthropic adaptive-thinking effort. CFN's harness model config has no
   * thinking field, so this is applied PER-INVOCATION (model override
   * additionalParams → additionalModelRequestFields) by callers that
   * support it — today the planner path. Seeded into the agent's runtime
   * config as defaultThinkingEffort. Thinking tokens count against
   * limits.maxTokens, so size the cap generously at high effort.
   */
  thinkingEffort: ThinkingEffortSchema.optional(),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type HarnessConfigInput = z.input<typeof HarnessConfigSchema>;
export type HarnessTool = z.infer<typeof HarnessToolSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
