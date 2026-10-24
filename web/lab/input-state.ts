import type { ConnectionInfo, LabState, OperationDef } from '../../shared/types.ts';

/** Compare what an operation actually sends, rather than editor-only IDs or disabled defaults. */
export function configurationSignature(
  op: OperationDef,
  state: Partial<LabState>,
  connections: ConnectionInfo[] = [],
): string {
  const connection = connections.find((item) => item.id === state.connectionId);
  try {
    return JSON.stringify({
      connectionId: state.connectionId,
      request: op.build({
        model: state.model ?? '',
        input: state.input ?? {},
        params: state.params ?? {},
        extra: connection?.extra ?? {},
      }),
    });
  } catch {
    return JSON.stringify(state, (key, value) => (key === '_id' ? undefined : value));
  }
}

/** Merge a completed upload into the current draft without replacing newer edits. */
export function appendMessageAsset(
  previous: Record<string, unknown>,
  messageId: string,
  kind: 'images' | 'videos',
  assetId: string,
): Record<string, unknown> {
  const messages = (previous.messages as Record<string, any>[] | undefined) ?? [];
  if (!messages.some((message) => message._id === messageId)) return previous;
  return {
    ...previous,
    messages: messages.map((message) =>
      message._id === messageId ? { ...message, [kind]: [...(message[kind] ?? []), assetId] } : message,
    ),
  };
}
