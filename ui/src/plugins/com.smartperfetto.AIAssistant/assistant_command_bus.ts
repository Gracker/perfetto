export type AssistantCommand = 'clear-chat' | 'open-settings';

type CommandListener = () => void;

const listeners: Record<AssistantCommand, Set<CommandListener>> = {
  'clear-chat': new Set<CommandListener>(),
  'open-settings': new Set<CommandListener>(),
};

function subscribe(command: AssistantCommand, listener: CommandListener): () => void {
  listeners[command].add(listener);
  return () => {
    listeners[command].delete(listener);
  };
}

function emit(command: AssistantCommand): void {
  for (const listener of listeners[command]) {
    try {
      listener();
    } catch (error) {
      console.warn(`[AIAssistantCommandBus] Listener for ${command} failed:`, error);
    }
  }
}

export function subscribeClearChat(listener: CommandListener): () => void {
  return subscribe('clear-chat', listener);
}

export function subscribeOpenSettings(listener: CommandListener): () => void {
  return subscribe('open-settings', listener);
}

export function emitClearChatCommand(): void {
  emit('clear-chat');
}

export function emitOpenSettingsCommand(): void {
  emit('open-settings');
}

