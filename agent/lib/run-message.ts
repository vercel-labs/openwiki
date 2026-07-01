type StreamEvent = {
  type: string;
  data?: {
    actions?: unknown;
    code?: string;
    message?: string | null;
    result?: unknown;
    status?: string;
  };
};

export type RunToolCall = {
  callId: string;
  input: unknown;
  output?: string;
  status?: string;
  toolName: string;
};

export class RunMessageMissingReplyError extends Error {
  constructor() {
    super("eve session completed without a text reply.");
    this.name = "RunMessageMissingReplyError";
  }
}

export async function readRunMessage(events: ReadableStream<unknown>): Promise<string> {
  const result = await readRunMessageWithToolCalls(events);
  return result.reply;
}

export async function readRunMessageWithToolCalls(events: ReadableStream<unknown>): Promise<{
  reply: string;
  toolCalls: RunToolCall[];
}> {
  const reader = events.getReader();
  let lastMessage: string | null = null;
  const toolCalls = new Map<string, RunToolCall>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const event = value as StreamEvent;
      if (event.type === "message.completed" && typeof event.data?.message === "string") {
        lastMessage = event.data.message;
      }

      if (event.type === "actions.requested") {
        for (const action of readToolActions(event.data?.actions)) {
          toolCalls.set(action.callId, action);
        }
      }

      if (event.type === "action.result") {
        const result = readToolResult(event.data?.result);
        if (result !== null) {
          const previous = toolCalls.get(result.callId);
          toolCalls.set(result.callId, {
            callId: result.callId,
            input: previous?.input,
            output: result.output,
            status: event.data?.status,
            toolName: result.toolName ?? previous?.toolName ?? "tool",
          });
        }
      }

      if (event.type === "session.failed") {
        throw new Error(event.data?.message ?? "eve session failed.");
      }

      if (
        event.type === "turn.completed" ||
        event.type === "session.waiting" ||
        event.type === "session.completed"
      ) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (lastMessage === null) {
    throw new RunMessageMissingReplyError();
  }

  return {
    reply: lastMessage,
    toolCalls: [...toolCalls.values()],
  };
}

function readToolActions(actions: unknown): RunToolCall[] {
  if (!Array.isArray(actions)) return [];

  return actions.flatMap((action) => {
    if (typeof action !== "object" || action === null) return [];
    const candidate = action as {
      callId?: unknown;
      input?: unknown;
      kind?: unknown;
      type?: unknown;
      toolName?: unknown;
    };
    if (
      (candidate.kind ?? candidate.type) !== "tool-call" ||
      typeof candidate.callId !== "string" ||
      typeof candidate.toolName !== "string"
    ) {
      return [];
    }

    return [
      {
        callId: candidate.callId,
        input: candidate.input,
        toolName: candidate.toolName,
      },
    ];
  });
}

function readToolResult(result: unknown): {
  callId: string;
  output?: string;
  toolName?: string;
} | null {
  if (typeof result !== "object" || result === null) return null;
  const candidate = result as {
    callId?: unknown;
    kind?: unknown;
    output?: unknown;
    type?: unknown;
    toolName?: unknown;
  };
  if ((candidate.kind ?? candidate.type) !== "tool-result" || typeof candidate.callId !== "string") {
    return null;
  }

  return {
    callId: candidate.callId,
    output:
      typeof candidate.output === "string"
        ? candidate.output
        : candidate.output === undefined
          ? undefined
          : JSON.stringify(candidate.output),
    toolName: typeof candidate.toolName === "string" ? candidate.toolName : undefined,
  };
}
