/**
 * Model-id verification for admin catalog edits (D-20).
 *
 * An invalid model id in the catalog surfaces only at invocation time as a
 * harness RuntimeClientError ("The provided model identifier is invalid"),
 * failing every task that uses it — so ids are checked against Bedrock in
 * this region when an admin saves the catalog. Accepts foundation model ids,
 * model ARNs, inference profile ids, and inference profile ARNs.
 *
 * Fails open: when the Bedrock listing itself is unavailable (permissions,
 * throttling), the save proceeds with `verified: false` rather than blocking
 * configuration on an unrelated outage.
 */
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';

const bedrock = new BedrockClient({});

export interface ModelIdCheck {
  invalid: string[];
  verified: boolean;
}

export async function checkModelIds(modelIds: string[]): Promise<ModelIdCheck> {
  try {
    const known = new Set<string>();
    const models = await bedrock.send(new ListFoundationModelsCommand({}));
    for (const model of models.modelSummaries ?? []) {
      if (model.modelId) {
        known.add(model.modelId);
      }
      if (model.modelArn) {
        known.add(model.modelArn);
      }
    }
    let nextToken: string | undefined;
    do {
      const page = await bedrock.send(
        new ListInferenceProfilesCommand({
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        }),
      );
      for (const profile of page.inferenceProfileSummaries ?? []) {
        if (profile.inferenceProfileId) {
          known.add(profile.inferenceProfileId);
        }
        if (profile.inferenceProfileArn) {
          known.add(profile.inferenceProfileArn);
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);
    return {
      invalid: modelIds.filter((id) => !known.has(id)),
      verified: true,
    };
  } catch (error) {
    console.warn('model id verification unavailable; accepting unverified', error);
    return { invalid: [], verified: false };
  }
}
