"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  SquareIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { Streamdown } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ChatMessage = {
  citations?: { path: string }[];
  content: string;
  id: string;
  role: "user" | "assistant";
  state?: "thinking" | "complete" | "error" | "stopped";
  toolCalls?: ChatToolCall[];
};

type ChatToolCall = {
  callId: string;
  input: unknown;
  output?: string;
  status?: string;
  toolName: string;
};

type RepoMessageStreamEvent = {
  data?: {
    actions?: unknown;
    message?: string | null;
    messageSoFar?: string | null;
    result?: unknown;
    status?: string;
  };
  type: string;
};

type ChatSession = {
  continuationToken?: string;
  sessionId?: string;
  streamIndex: number;
};

type PersistedActiveRun = {
  assistantMessageId: string;
  session: ChatSession;
  updatedAt: number;
};

type RepoChatFullPageProps = {
  initialQuestion?: string;
  repoLabel: string;
  repoUrl: string;
};

const MAX_CHAT_MESSAGE_CHARS = 8_000;
const REVEAL_TICK_MS = 26;
const STREAM_OPEN_RETRYABLE_STATUS = new Set([404, 409, 425, 500, 502, 503, 504]);
const STREAM_DISCONNECT_RECONNECT_ATTEMPTS = 3;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_RECONNECT_DELAY_MS = 350;
const CHAT_STORAGE_PREFIX = "openwiki:repo-chat:";
const CHAT_STORAGE_VERSION = 1;
const MAX_STORED_MESSAGES = 40;

const suggestions = [
  "Where should I start reading?",
  "How is this repository organized?",
  "What are the key runtime flows?",
  "Which files define the public API?",
];

export function RepoChatFullPage({ initialQuestion, repoLabel, repoUrl }: RepoChatFullPageProps) {
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [revealingMessageId, setRevealingMessageId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<PersistedActiveRun | null>(null);
  const initialQuestionSent = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const resumeStartedRef = useRef(false);

  const persistSnapshot = useCallback(
    (nextMessages: ChatMessage[], activeRun = activeRunRef.current) => {
      writePersistedRepoChat(repoUrl, nextMessages, activeRun);
    },
    [repoUrl],
  );

  const setMessages = useCallback(
    (updater: SetStateAction<ChatMessage[]>) => {
      setMessagesState((current) => {
        const next =
          typeof updater === "function"
            ? (updater as (value: ChatMessage[]) => ChatMessage[])(current)
            : updater;
        messagesRef.current = next;
        persistSnapshot(next);
        return next;
      });
    },
    [persistSnapshot],
  );

  const setActiveRun = useCallback(
    (activeRun: PersistedActiveRun | null) => {
      activeRunRef.current = activeRun;
      persistSnapshot(messagesRef.current, activeRun);
    },
    [persistSnapshot],
  );

  const updateActiveRunStreamIndex = useCallback(
    (streamIndex: number) => {
      const activeRun = activeRunRef.current;
      if (activeRun === null) return;

      setActiveRun({
        ...activeRun,
        session: {
          ...activeRun.session,
          streamIndex,
        },
        updatedAt: Date.now(),
      });
    },
    [setActiveRun],
  );

  useEffect(() => {
    resumeStartedRef.current = false;
    const persisted = readPersistedRepoChat(repoUrl);
    const restoredMessages = persisted?.messages ?? [];
    const restoredActiveRun = persisted?.activeRun ?? null;

    messagesRef.current = restoredMessages;
    activeRunRef.current = restoredActiveRun;
    setMessagesState(restoredMessages);
    setIsHydrated(true);
  }, [repoUrl]);

  const sendQuestion = useCallback(
    async (question: string) => {
      const message = question.trim();
      if (
        !isHydrated ||
        message.length === 0 ||
        isSending ||
        getMessageLength(message) > MAX_CHAT_MESSAGE_CHARS
      ) {
        return;
      }

      const assistantMessageId = createMessageId();
      const controller = new AbortController();
      abortRef.current = controller;
      setActiveRun(null);
      setInput("");
      setIsSending(true);
      setRevealingMessageId(null);
      setMessages((current) => [
        ...current,
        {
          content: message,
          id: createMessageId(),
          role: "user",
        },
        {
          content: "",
          id: assistantMessageId,
          role: "assistant",
          state: "thinking",
        },
      ]);

      try {
        const history = createChatHistory(messagesRef.current);
        const response = await fetch("/api/chat", {
          body: JSON.stringify({ history, message, repoUrl }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        const payload = (await response.json()) as {
          error?: string;
          session?: ChatSession;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "The eve server returned an error.");
        }

        const startedSession = payload.session;
        if (!startedSession?.sessionId) {
          throw new Error("The eve server did not return a chat session.");
        }

        setActiveRun({
          assistantMessageId,
          session: startedSession,
          updatedAt: Date.now(),
        });

        let streamedText = false;
        const streamResult = await readRepoMessageStream({
          onProgress: (progress) => {
            if (progress.streamIndex !== undefined) {
              updateActiveRunStreamIndex(progress.streamIndex);
            }

            if (progress.reply !== undefined) {
              streamedText = true;
            }

            setMessages((current) =>
              current.map((chatMessage) =>
                chatMessage.id === assistantMessageId
                  ? {
                      ...chatMessage,
                      content: progress.reply ?? chatMessage.content,
                      state: progress.reply !== undefined ? "complete" : chatMessage.state,
                      toolCalls: progress.toolCalls ?? chatMessage.toolCalls,
                    }
                  : chatMessage,
              ),
            );
          },
          session: startedSession,
          signal: controller.signal,
        });
        setActiveRun(null);
        setRevealingMessageId(streamedText ? null : assistantMessageId);
        setMessages((current) =>
          current.map((chatMessage) =>
            chatMessage.id === assistantMessageId
              ? {
                  ...chatMessage,
                  citations: extractCitationPaths(streamResult.reply).map((path) => ({ path })),
                  content: streamResult.reply,
                  state: "complete",
                  toolCalls: streamResult.toolCalls,
                }
              : chatMessage,
          ),
        );
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        setActiveRun(null);
        setMessages((current) =>
          current.map((chatMessage) =>
            chatMessage.id === assistantMessageId
              ? {
                  ...chatMessage,
                  content: error instanceof Error
                      ? error.message
                      : "Failed to reach the eve server.",
                  state: "error",
                }
              : chatMessage,
          ),
        );
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setIsSending(false);
      }
    },
    [
      isHydrated,
      isSending,
      repoUrl,
      setActiveRun,
      setMessages,
      updateActiveRunStreamIndex,
    ],
  );

  useEffect(() => {
    if (
      !isHydrated ||
      initialQuestionSent.current ||
      initialQuestion === undefined ||
      initialQuestion.trim().length === 0 ||
      messagesRef.current.length > 0
    ) {
      return;
    }
    initialQuestionSent.current = true;
    void sendQuestion(initialQuestion);
  }, [initialQuestion, isHydrated, sendQuestion]);

  useEffect(() => {
    if (!isHydrated || resumeStartedRef.current) {
      return;
    }

    const activeRun = activeRunRef.current;
    if (!isActiveRunStillOpen(messagesRef.current, activeRun)) {
      if (activeRun !== null) {
        setActiveRun(null);
      }
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let completed = false;
    let streamedText = false;

    resumeStartedRef.current = true;
    abortRef.current = controller;
    setIsSending(true);
    setRevealingMessageId(null);

    void (async () => {
      try {
        const streamResult = await readRepoMessageStream({
          onProgress: (progress) => {
            if (cancelled) return;

            if (progress.streamIndex !== undefined) {
              updateActiveRunStreamIndex(progress.streamIndex);
            }

            if (progress.reply !== undefined) {
              streamedText = true;
            }

            setMessages((current) =>
              current.map((chatMessage) =>
                chatMessage.id === activeRun.assistantMessageId
                  ? {
                      ...chatMessage,
                      content: progress.reply ?? chatMessage.content,
                      state: progress.reply !== undefined ? "complete" : chatMessage.state,
                      toolCalls: progress.toolCalls ?? chatMessage.toolCalls,
                    }
                  : chatMessage,
              ),
            );
          },
          session: activeRun.session,
          signal: controller.signal,
        });

        if (cancelled) return;

        setActiveRun(null);
        setRevealingMessageId(streamedText ? null : activeRun.assistantMessageId);
        setMessages((current) =>
          current.map((chatMessage) =>
            chatMessage.id === activeRun.assistantMessageId
              ? {
                  ...chatMessage,
                  citations: extractCitationPaths(streamResult.reply).map((path) => ({ path })),
                  content: streamResult.reply,
                  state: "complete",
                  toolCalls: streamResult.toolCalls,
                }
              : chatMessage,
          ),
        );
        completed = true;
      } catch (error) {
        if (cancelled || isAbortError(error)) {
          return;
        }

        setActiveRun(null);
        setMessages((current) =>
          current.map((chatMessage) =>
            chatMessage.id === activeRun.assistantMessageId
              ? {
                  ...chatMessage,
                  content:
                    error instanceof Error ? error.message : "Failed to resume the eve stream.",
                  state: "error",
                }
              : chatMessage,
          ),
        );
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (!cancelled) {
          setIsSending(false);
        }
        if (!completed && !cancelled) {
          resumeStartedRef.current = false;
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!completed) {
        resumeStartedRef.current = false;
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      controller.abort();
    };
  }, [
    isHydrated,
    setActiveRun,
    setMessages,
    updateActiveRunStreamIndex,
  ]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const isEmpty = messages.length === 0;

  return (
    <section className="flex h-[100dvh] min-h-0 flex-col pt-10">
      <ChatConversation>
        <ChatConversationContent
          className={cn(
            isEmpty ? "min-h-full justify-center" : "min-h-full justify-end",
          )}
        >
          {isEmpty ? (
            <EmptyChat repoLabel={repoLabel} onSuggestion={sendQuestion} />
          ) : (
            <div className="flex w-full flex-col gap-5">
              {messages.map((message) => (
                <ChatMessageItem
                  isRevealing={revealingMessageId === message.id}
                  key={message.id}
                  message={message}
                />
              ))}
            </div>
          )}
        </ChatConversationContent>
        <ChatScrollButton />
      </ChatConversation>

      <div className="z-20 shrink-0 bg-background/90 pb-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:pb-6">
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
          <ChatComposer
            isBusy={isSending}
            maxLength={MAX_CHAT_MESSAGE_CHARS}
            onChange={setInput}
            onSubmit={sendQuestion}
            placeholder={`Ask anything about ${repoLabel}...`}
            repoLabel={repoLabel}
            value={input}
          />
        </div>
      </div>
    </section>
  );
}

function EmptyChat({
  onSuggestion,
  repoLabel,
}: {
  onSuggestion: (value: string) => void | Promise<void>;
  repoLabel: string;
}) {
  return (
    <div className="grid w-full justify-items-center gap-5 text-center">
      <div className="grid gap-2">
        <h1 className="m-0 text-2xl font-semibold leading-8 tracking-normal sm:text-3xl">
          Explore <span className="font-mono text-muted-foreground">{repoLabel}</span>
        </h1>
        <p className="m-0 text-sm leading-6 text-muted-foreground">
          Ask source-grounded questions about architecture, APIs, files, and flows.
        </p>
      </div>
      <div className="flex max-w-[720px] flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            className="rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:bg-muted/40 hover:text-foreground"
            key={suggestion}
            onClick={() => void onSuggestion(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatConversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  return (
    <StickToBottom
      className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

function ChatConversationContent({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) {
  return (
    <StickToBottom.Content
      className={cn("mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8 sm:px-6", className)}
      {...props}
    />
  );
}

function ChatScrollButton({ className, ...props }: ComponentProps<typeof Button>) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => scrollToBottom(), [scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      aria-label="Scroll to latest message"
      className={cn("absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-sm", className)}
      onClick={handleScrollToBottom}
      size="icon-sm"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

function ChatMessageItem({
  isRevealing,
  message,
}: {
  isRevealing: boolean;
  message: ChatMessage;
}) {
  const isUser = message.role === "user";

  return (
    <article className={cn("flex w-full min-w-0", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0",
          isUser
            ? "max-w-[85%] rounded-[18px] border border-border/50 bg-muted/70 px-3 py-1.5 text-[15px] leading-6 text-foreground shadow-sm"
            : "w-full max-w-none text-sm leading-relaxed text-foreground",
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <AssistantMessage isRevealing={isRevealing} message={message} />
        )}
      </div>
    </article>
  );
}

function AssistantMessage({
  isRevealing,
  message,
}: {
  isRevealing: boolean;
  message: ChatMessage;
}) {
  if (message.state === "thinking") {
    return <p className="openwiki-shimmer-text m-0 px-3 text-[15px] leading-6">Thinking...</p>;
  }

  if (message.state === "stopped") {
    return <p className="m-0 px-3 text-[15px] leading-6 text-muted-foreground">Stopped.</p>;
  }

  return (
    <div className="grid gap-3">
      <AssistantMarkdown
        isRevealing={isRevealing && message.state === "complete"}
        streamKey={message.id}
        text={message.content}
      />
      {message.toolCalls && message.toolCalls.length > 0 ? (
        <ToolCallList toolCalls={message.toolCalls} />
      ) : null}
      {message.citations && message.citations.length > 0 ? (
        <SourceList citations={message.citations} />
      ) : null}
    </div>
  );
}

function AssistantMarkdown({
  isRevealing,
  streamKey,
  text,
}: {
  isRevealing: boolean;
  streamKey: string;
  text: string;
}) {
  const visibleText = useRevealedText({ isRevealing, streamKey, text });
  const showCaret = isRevealing && visibleText.length > 0 && visibleText !== text;

  return (
    <Streamdown
      animated={showCaret ? { duration: 0, stagger: 0 } : undefined}
      caret={showCaret ? "block" : undefined}
      className={chatMarkdownClassName}
      isAnimating={showCaret}
      mode="static"
    >
      {visibleText}
    </Streamdown>
  );
}

function SourceList({ citations }: { citations: { path: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3">
      {citations.map((citation) => (
        <span
          className="max-w-full truncate rounded-md border bg-muted/30 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground"
          key={citation.path}
          title={citation.path}
        >
          {citation.path}
        </span>
      ))}
    </div>
  );
}

function ToolCallList({ toolCalls }: { toolCalls: ChatToolCall[] }) {
  return (
    <div className="grid gap-2 px-3">
      {toolCalls.map((toolCall) => (
        <details
          className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground"
          key={toolCall.callId}
        >
          <summary className="cursor-pointer list-none font-mono text-foreground">
            {toolCall.toolName}
            {toolCall.status ? <span className="ml-2 font-sans text-muted-foreground">{toolCall.status}</span> : null}
          </summary>
          <div className="mt-2 grid gap-2">
            <ToolCallPayload label="Input" value={formatToolPayload(toolCall.input)} />
            {toolCall.output ? <ToolCallPayload label="Output" value={toolCall.output} /> : null}
          </div>
        </details>
      ))}
    </div>
  );
}

function ToolCallPayload({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-48 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-5 text-foreground">
        {value}
      </pre>
    </div>
  );
}

function ChatComposer({
  isBusy,
  maxLength,
  onChange,
  onSubmit,
  placeholder,
  repoLabel,
  value,
}: {
  isBusy: boolean;
  maxLength: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
  placeholder: string;
  repoLabel: string;
  value: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedValue = value.trim();
  const messageLength = getMessageLength(trimmedValue);
  const isOverMaxLength = messageLength > maxLength;

  useEffect(() => {
    if (isBusy) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isBusy]);

  const submitValue = useCallback(() => {
    if (!trimmedValue || isBusy || isOverMaxLength) return;
    void onSubmit(trimmedValue);
  }, [isBusy, isOverMaxLength, onSubmit, trimmedValue]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitValue();
    },
    [submitValue],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      submitValue();
    },
    [submitValue],
  );

  return (
    <form
      className="min-w-0 rounded-[14px] border border-border/80 bg-card/95 shadow-sm transition-colors focus-within:border-border focus-within:ring-[1px] focus-within:ring-foreground/5 dark:bg-muted/45 dark:focus-within:ring-white/5"
      onSubmit={handleSubmit}
    >
      <label className="sr-only" htmlFor="openwiki-chat-composer">
        Ask OpenWiki about {repoLabel}
      </label>
      <textarea
        className="max-h-32 min-h-12 w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[16px] leading-6 outline-none placeholder:text-muted-foreground/45 disabled:cursor-not-allowed disabled:opacity-60 sm:px-4 dark:placeholder:text-muted-foreground/60"
        disabled={isBusy}
        id="openwiki-chat-composer"
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={textareaRef}
        rows={2}
        value={value}
      />
      <div className="flex min-h-9 items-center justify-between gap-2 px-3 pt-1 pb-2 sm:gap-3 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-xs text-muted-foreground">
          {messageLength > 0 ? (
            <span className={cn("shrink-0 tabular-nums", isOverMaxLength ? "text-destructive" : "")}>
              {messageLength.toLocaleString()}/{maxLength.toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          {isBusy ? (
            <Button
              aria-label="Response in progress"
              className="size-6 cursor-default rounded-md bg-foreground/15 text-foreground/55 shadow-none hover:bg-foreground/15 disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100"
              disabled
              size="icon-xs"
              type="button"
            >
              <SquareIcon className="size-2.5 fill-current" />
            </Button>
          ) : (
            <Button
              aria-label="Send message"
              className="size-6 rounded-md bg-foreground text-background hover:bg-foreground/90 disabled:pointer-events-auto disabled:opacity-30"
              disabled={trimmedValue.length === 0 || isOverMaxLength}
              size="icon-xs"
              type="submit"
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

function createChatHistory(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.content.trim().length > 0 && message.state !== "thinking")
    .slice(-8)
    .map((message) => ({
      content: message.content.trim().slice(0, 4_000),
      role: message.role,
    }));
}

async function readRepoMessageStream({
  onProgress,
  session,
  signal,
}: {
  onProgress?: (progress: {
    reply?: string;
    streamIndex?: number;
    toolCalls?: ChatToolCall[];
  }) => void;
  session: ChatSession;
  signal?: AbortSignal;
}): Promise<{
  reply: string;
  streamIndex: number;
  toolCalls: ChatToolCall[];
}> {
  if (!session.sessionId) {
    throw new Error("The eve session is missing an ID.");
  }

  const toolCalls = new Map<string, ChatToolCall>();
  let lastMessage: string | null = null;
  let nextIndex = session.streamIndex;
  let disconnectReconnectsRemaining = STREAM_DISCONNECT_RECONNECT_ATTEMPTS;
  let lastProgressAt = Date.now();
  let observedEvents = 0;

  for (;;) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    let disconnected = false;
    let foundBoundary = false;
    const body = await openStreamBody({
      sessionId: session.sessionId,
      signal,
      startIndex: nextIndex,
    });

    try {
      for await (const event of readNdjsonStream(body)) {
        const isStaleLeadingWaiting =
          observedEvents === 0 &&
          session.streamIndex > 0 &&
          event.type === "session.waiting";

        observedEvents += 1;
        nextIndex += 1;
        lastProgressAt = Date.now();
        disconnectReconnectsRemaining = STREAM_DISCONNECT_RECONNECT_ATTEMPTS;
        onProgress?.({ streamIndex: nextIndex });

        if (event.type === "message.completed" && typeof event.data?.message === "string") {
          lastMessage = event.data.message;
          onProgress?.({ reply: lastMessage });
        }

        if (event.type === "message.appended" && typeof event.data?.messageSoFar === "string") {
          lastMessage = event.data.messageSoFar;
          onProgress?.({ reply: lastMessage });
        }

        if (event.type === "actions.requested") {
          for (const action of readToolActions(event.data?.actions)) {
            toolCalls.set(action.callId, action);
          }
          onProgress?.({ toolCalls: [...toolCalls.values()] });
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
            onProgress?.({ toolCalls: [...toolCalls.values()] });
          }
        }

        if (event.type === "session.failed") {
          throw new Error(event.data?.message ?? "eve session failed.");
        }

        if (isCurrentTurnBoundaryEvent(event) && !isStaleLeadingWaiting) {
          foundBoundary = true;
          break;
        }
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) {
        throw error;
      }

      disconnected = true;
    }

    if (foundBoundary || signal?.aborted) {
      break;
    }

    if (Date.now() - lastProgressAt >= STREAM_IDLE_TIMEOUT_MS) {
      break;
    }

    if (disconnected) {
      if (disconnectReconnectsRemaining <= 0) {
        break;
      }

      disconnectReconnectsRemaining -= 1;
    }

    await sleep(STREAM_RECONNECT_DELAY_MS);
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  if (lastMessage === null) {
    throw new Error("eve session completed without a text reply.");
  }

  return {
    reply: lastMessage,
    streamIndex: nextIndex,
    toolCalls: [...toolCalls.values()],
  };
}

async function openStreamBody({
  sessionId,
  signal,
  startIndex,
}: {
  sessionId: string;
  signal?: AbortSignal;
  startIndex: number;
}) {
  const path = `/api/chat/stream/${encodeURIComponent(sessionId)}`;
  const query = startIndex > 0 ? `?${new URLSearchParams({ startIndex: String(startIndex) })}` : "";
  let status = 0;
  let body = "Failed to open message stream.";

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${path}${query}`, {
      signal: signal ?? null,
    });

    if (response.ok) {
      if (!response.body) {
        throw new Error("Response body is null.");
      }

      return response.body;
    }

    status = response.status;
    body = await response.text();

    if (!STREAM_OPEN_RETRYABLE_STATUS.has(response.status)) {
      throw new Error(formatResponseError(status, body));
    }

    if (attempt < 11) {
      await sleep(250);
    }
  }

  throw new Error(formatResponseError(status, body));
}

async function* readNdjsonStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        break;
      }

      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          yield JSON.parse(line) as RepoMessageStreamEvent;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const line = buffer.trim();
    if (line.length > 0) {
      yield JSON.parse(line) as RepoMessageStreamEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

function readToolActions(actions: unknown): ChatToolCall[] {
  if (!Array.isArray(actions)) return [];

  return actions.flatMap((action) => {
    if (typeof action !== "object" || action === null) return [];
    const candidate = action as {
      callId?: unknown;
      input?: unknown;
      kind?: unknown;
      toolName?: unknown;
      type?: unknown;
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
    toolName?: unknown;
    type?: unknown;
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

function isCurrentTurnBoundaryEvent(event: RepoMessageStreamEvent) {
  return (
    event.type === "authorization.required" ||
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting" ||
    event.type === "turn.failed"
  );
}

function isStreamDisconnectError(error: unknown) {
  if (isAbortError(error)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    code === "UND_ERR_SOCKET" ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

function formatResponseError(status: number, body: string) {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {}

    return body;
  }

  return `Server returned ${status}.`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createAbortError() {
  return new DOMException("The chat request was stopped.", "AbortError");
}

function useRevealedText({
  isRevealing,
  streamKey,
  text,
}: {
  isRevealing: boolean;
  streamKey: string;
  text: string;
}) {
  const [visibleText, setVisibleText] = useState(() => (isRevealing ? "" : text));

  useEffect(() => {
    if (!isRevealing || text.length === 0) {
      setVisibleText(text);
      return;
    }

    let current = "";
    setVisibleText("");
    const interval = window.setInterval(() => {
      current = nextRevealedText(current, text);
      setVisibleText(current);
      if (current === text) {
        window.clearInterval(interval);
      }
    }, REVEAL_TICK_MS);

    return () => window.clearInterval(interval);
  }, [isRevealing, streamKey, text]);

  return visibleText;
}

function nextRevealedText(current: string, target: string) {
  if (current === target) return current;
  if (!target.startsWith(current)) return target;

  const remaining = target.length - current.length;
  const step =
    remaining > 160 ? 18 :
    remaining > 80 ? 12 :
    remaining > 32 ? 7 :
    remaining > 12 ? 4 :
    2;

  return target.slice(0, current.length + Math.min(remaining, step));
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "{}";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractCitationPaths(message: string): string[] {
  const paths = new Set<string>();

  for (const match of message.matchAll(/`([^`\n]+)`/g)) {
    addCitationPath(paths, match[1]);
  }

  for (const match of message.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    addCitationPath(paths, match[1]);
    addCitationPath(paths, match[2]);
  }

  for (const match of message.matchAll(/https:\/\/github\.com\/[^\s)`]+/gi)) {
    addCitationPath(paths, match[0]);
  }

  for (const match of message.matchAll(
    /(?:^|[\s({"'>])((?!https?:\/\/|\/\/)(?:\.{1,2}\/|\/)?[A-Za-z0-9_@~+-][A-Za-z0-9_@()[\]./+~-]*\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|md|mdx|json|yaml|yml|toml|css|scss|html|sh|sql|lock)(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)?)(?=$|[\s)\]},.;!?"'<])/gi,
  )) {
    addCitationPath(paths, match[1]);
  }

  return [...paths].slice(0, 12);
}

function addCitationPath(paths: Set<string>, value: string | undefined) {
  const path = normalizeCitationPath(value);
  if (path !== null) {
    paths.add(path);
  }
}

function normalizeCitationPath(value: string | undefined): string | null {
  if (value === undefined) return null;

  const githubPath = extractGitHubFilePath(value);
  let path = githubPath ?? value.trim();

  path = path
    .replace(/^<|>$/g, "")
    .replace(/[?#].*$/g, "")
    .replace(/:\d+(?::\d+)?$/g, "")
    .replace(/^\.\/+/g, "")
    .replace(/^\/+/g, "");

  if (
    path.length === 0 ||
    path.includes("://") ||
    path.startsWith("//") ||
    /\s/.test(path) ||
    !/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|md|mdx|json|yaml|yml|toml|css|scss|html|sh|sql|lock)$/i.test(
      path,
    )
  ) {
    return null;
  }

  return path;
}

function extractGitHubFilePath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;

    const segments = url.pathname.split("/").filter(Boolean);
    const markerIndex = segments.findIndex((segment) => segment === "blob" || segment === "tree");
    if (markerIndex === -1 || markerIndex + 2 >= segments.length) return null;

    return segments.slice(markerIndex + 2).join("/");
  } catch {
    return null;
  }
}

function getRepoChatStorageKey(repoUrl: string) {
  return `${CHAT_STORAGE_PREFIX}${encodeURIComponent(repoUrl)}`;
}

function readPersistedRepoChat(repoUrl: string): {
  activeRun: PersistedActiveRun | null;
  messages: ChatMessage[];
} | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getRepoChatStorageKey(repoUrl));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      activeRun?: unknown;
      messages?: unknown;
      repoUrl?: unknown;
      version?: unknown;
    };

    if (parsed.version !== CHAT_STORAGE_VERSION || parsed.repoUrl !== repoUrl) {
      return null;
    }

    const activeRun = readPersistedActiveRun(parsed.activeRun);
    const messages = normalizeRestoredMessages(readPersistedMessages(parsed.messages), activeRun);

    return {
      activeRun: isActiveRunStillOpen(messages, activeRun) ? activeRun : null,
      messages,
    };
  } catch {
    return null;
  }
}

function writePersistedRepoChat(
  repoUrl: string,
  messages: ChatMessage[],
  activeRun: PersistedActiveRun | null,
) {
  if (typeof window === "undefined") return;

  try {
    if (messages.length === 0 && activeRun === null) {
      window.localStorage.removeItem(getRepoChatStorageKey(repoUrl));
      return;
    }

    window.localStorage.setItem(
      getRepoChatStorageKey(repoUrl),
      JSON.stringify({
        activeRun,
        messages: messages.slice(-MAX_STORED_MESSAGES),
        repoUrl,
        updatedAt: Date.now(),
        version: CHAT_STORAGE_VERSION,
      }),
    );
  } catch {
    // Browser storage can be unavailable or full; chat still works in memory.
  }
}

function normalizeRestoredMessages(
  messages: ChatMessage[],
  activeRun: PersistedActiveRun | null,
): ChatMessage[] {
  if (isActiveRunStillOpen(messages, activeRun)) {
    return messages;
  }

  return messages.map((message) =>
    message.role === "assistant" && message.state === "thinking"
      ? {
          ...message,
          content:
            message.content ||
            "Refresh interrupted this response before it could be resumed. Please ask again.",
          state: "error",
        }
      : message,
  );
}

function readPersistedMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): ChatMessage[] => {
    if (typeof item !== "object" || item === null) return [];

    const candidate = item as {
      citations?: unknown;
      content?: unknown;
      id?: unknown;
      role?: unknown;
      state?: unknown;
      toolCalls?: unknown;
    };

    if (
      typeof candidate.id !== "string" ||
      typeof candidate.content !== "string" ||
      (candidate.role !== "assistant" && candidate.role !== "user")
    ) {
      return [];
    }

    return [
      {
        citations: readPersistedCitations(candidate.citations),
        content: candidate.content,
        id: candidate.id,
        role: candidate.role,
        state: readPersistedMessageState(candidate.state),
        toolCalls: readPersistedToolCalls(candidate.toolCalls),
      },
    ];
  });
}

function readPersistedActiveRun(value: unknown): PersistedActiveRun | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as {
    assistantMessageId?: unknown;
    session?: unknown;
    updatedAt?: unknown;
  };
  const session = readPersistedSession(candidate.session);

  if (
    typeof candidate.assistantMessageId !== "string" ||
    session === null ||
    typeof candidate.updatedAt !== "number"
  ) {
    return null;
  }

  return {
    assistantMessageId: candidate.assistantMessageId,
    session,
    updatedAt: candidate.updatedAt,
  };
}

function readPersistedSession(value: unknown): ChatSession | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as {
    continuationToken?: unknown;
    sessionId?: unknown;
    streamIndex?: unknown;
  };

  if (typeof candidate.sessionId !== "string" || typeof candidate.streamIndex !== "number") {
    return null;
  }

  return {
    continuationToken:
      typeof candidate.continuationToken === "string" ? candidate.continuationToken : undefined,
    sessionId: candidate.sessionId,
    streamIndex: Math.max(0, Math.floor(candidate.streamIndex)),
  };
}

function readPersistedMessageState(value: unknown): ChatMessage["state"] | undefined {
  return value === "thinking" || value === "complete" || value === "error" || value === "stopped"
    ? value
    : undefined;
}

function readPersistedCitations(value: unknown): ChatMessage["citations"] {
  if (!Array.isArray(value)) return undefined;

  const citations = value.flatMap((item): { path: string }[] => {
    if (typeof item !== "object" || item === null) return [];
    const path = (item as { path?: unknown }).path;
    return typeof path === "string" ? [{ path }] : [];
  });

  return citations.length > 0 ? citations : undefined;
}

function readPersistedToolCalls(value: unknown): ChatMessage["toolCalls"] {
  if (!Array.isArray(value)) return undefined;

  const toolCalls = value.flatMap((item): ChatToolCall[] => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as {
      callId?: unknown;
      input?: unknown;
      output?: unknown;
      status?: unknown;
      toolName?: unknown;
    };

    if (typeof candidate.callId !== "string" || typeof candidate.toolName !== "string") {
      return [];
    }

    return [
      {
        callId: candidate.callId,
        input: candidate.input,
        output: typeof candidate.output === "string" ? candidate.output : undefined,
        status: typeof candidate.status === "string" ? candidate.status : undefined,
        toolName: candidate.toolName,
      },
    ];
  });

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function isActiveRunStillOpen(
  messages: ChatMessage[],
  activeRun: PersistedActiveRun | null,
): activeRun is PersistedActiveRun {
  if (activeRun === null || !activeRun.session.sessionId) {
    return false;
  }

  return messages.some(
    (message) =>
      message.id === activeRun.assistantMessageId &&
      message.role === "assistant" &&
      message.state === "thinking",
  );
}

function createMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getMessageLength(message: string) {
  return Array.from(message).length;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

const chatMarkdownClassName = [
  "min-w-0 text-[15px] leading-6 text-foreground",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mt-7 [&_h1]:mb-4 [&_h1]:px-3 [&_h1]:text-xl [&_h1]:font-medium [&_h1]:leading-7 [&_h1]:tracking-normal",
  "[&_h2]:mt-6 [&_h2]:mb-3 [&_h2]:px-3 [&_h2]:text-base [&_h2]:font-medium [&_h2]:leading-6 [&_h2]:tracking-normal",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:px-3 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:leading-6 [&_h3]:tracking-normal",
  "[&_p]:px-3 [&_p]:text-[15px] [&_p]:leading-6 [&_p]:text-foreground",
  "[&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:px-3 [&_ul]:pl-8 [&_ul]:text-[15px] [&_ul]:leading-6",
  "[&_ol]:flex [&_ol]:list-decimal [&_ol]:flex-col [&_ol]:gap-1.5 [&_ol]:px-3 [&_ol]:pl-8 [&_ol]:text-[15px] [&_ol]:leading-6",
  "[&_li]:pl-1 [&_li]:text-foreground",
  "[&_blockquote]:mx-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_strong]:font-medium [&_strong]:text-foreground",
  "[&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:decoration-border [&_a]:underline-offset-4 hover:[&_a]:decoration-foreground",
  "[&_code]:rounded-md [&_code]:border [&_code]:border-border/70 [&_code]:bg-muted/40 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.92em] [&_code]:text-foreground",
  "[&_pre]:mx-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-6",
  "[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
].join(" ");
