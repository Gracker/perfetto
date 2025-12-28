// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export abstract class AIService {
  abstract chat(messages: AIMessage[]): Promise<string>;
  abstract testConnection(): Promise<boolean>;
}

export class OllamaService extends AIService {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async chat(messages: AIMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.message?.content || data.response || '';
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
      if (!response.ok) return false;

      const data = await response.json();
      if (data.models) {
        // Check if our model exists
        return data.models.some((m: any) => m.name.includes(this.model));
      }
      return true;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json();
      return data.models?.map((m: any) => m.name) || [];
    } catch {
      return [];
    }
  }
}

// Backend proxy service - uses local backend to avoid CORS issues
export class BackendProxyService extends AIService {
  private backendUrl: string;
  private model: string;

  constructor(backendUrl: string, model: string) {
    super();
    this.backendUrl = backendUrl.replace(/\/$/, '');
    this.model = model;
    console.log('[BackendProxyService] Initialized with URL:', this.backendUrl, 'model:', this.model);
  }

  async chat(messages: AIMessage[]): Promise<string> {
    const url = `${this.backendUrl}/chat/completions`;
    console.log('[BackendProxyService] Sending request to:', url);
    console.log('[BackendProxyService] Messages:', messages);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages,
        }),
      });

      console.log('[BackendProxyService] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[BackendProxyService] Error response:', errorData);
        throw new Error(errorData.error?.message || `Backend API error: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[BackendProxyService] Response data:', data);
      return data.choices?.[0]?.message?.content || '';
    } catch (e: any) {
      console.error('[BackendProxyService] Request failed:', e);
      throw e;
    }
  }

  async testConnection(): Promise<boolean> {
    const url = `${this.backendUrl}/chat/completions`;
    console.log('[BackendProxyService] Testing connection to:', url);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      console.log('[BackendProxyService] Test response status:', response.status);
      const result = response.ok || response.status < 500;
      console.log('[BackendProxyService] Test result:', result);
      return result;
    } catch (e: any) {
      console.error('[BackendProxyService] Test connection failed:', e);
      return false;
    }
  }
}

export class OpenAIService extends AIService {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(baseUrl: string, model: string, apiKey: string) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  async chat(messages: AIMessage[]): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async testConnection(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers,
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
