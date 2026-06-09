export interface Message {
    role: 'user' | 'assistant';
    content: string;
}

export interface AIProvider {
    stream(messages: Message[], onChunk: (text: string) => void): Promise<void>;
    complete(messages: Message[]): Promise<string>;
}
