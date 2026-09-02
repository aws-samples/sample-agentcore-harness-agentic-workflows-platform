/**
 * Converts the tools package's JSON-Schema-ish tool definitions into the
 * Gateway L2's typed SchemaDefinition shape, so one definition source serves
 * both the Lambda handler and the target registration.
 */
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type { ToolDefinition as PlatformToolDefinition } from '@agentic-platform/tools';

type JsonSchemaNode = {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
};

function convertNode(node: JsonSchemaNode): agentcore.SchemaDefinition {
  const description = [
    node.description,
    node.enum ? `One of: ${node.enum.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join('. ');
  return {
    type: agentcore.SchemaDefinitionType.of(node.type ?? 'string'),
    ...(description ? { description } : {}),
    ...(node.items ? { items: convertNode(node.items) } : {}),
    ...(node.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(node.properties).map(([key, value]) => [
              key,
              convertNode(value),
            ]),
          ),
        }
      : {}),
    ...(node.required ? { required: node.required } : {}),
  };
}

export function toGatewayToolDefinitions(
  definitions: PlatformToolDefinition[],
): agentcore.ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: convertNode(definition.inputSchema as JsonSchemaNode),
  }));
}
