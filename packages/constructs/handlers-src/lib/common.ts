/**
 * Shared runtime helpers for the interpreter Lambda handlers.
 * Bundled into each handler by esbuild (scripts/bundle-handlers.mjs).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const s3 = new S3Client({});

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getArtifactText(
  bucket: string,
  key: string,
  maxChars: number,
): Promise<string> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const body = (await response.Body?.transformToString()) ?? '';
  if (body.length <= maxChars) {
    return body;
  }
  return `${body.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
}

export async function putArtifactText(
  bucket: string,
  key: string,
  text: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: text,
      ContentType: 'text/markdown; charset=utf-8',
    }),
  );
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
