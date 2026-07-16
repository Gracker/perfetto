// Copyright (C) 2026 The Android Open Source Project
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

// Global setup for Vitest, referenced from vitest.config.mjs (setupFiles).
//
// jsdom does not implement ResizeObserver, which some widgets construct on mount
// (e.g. grid virtualization, virtual canvas). Provide a no-op stub: there is no
// real layout in the test DOM, so the callback would never fire meaningfully
// anyway.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function createMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storageMethods: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  const memoryLocalStorage = new Proxy(storageMethods, {
    get(storageTarget, property, receiver) {
      if (typeof property === 'string' && !(property in storageTarget)) {
        return store.get(property);
      }
      return Reflect.get(storageTarget, property, receiver);
    },
    set(storageTarget, property, value, receiver) {
      if (typeof property === 'string' && !(property in storageTarget)) {
        store.set(property, String(value));
        return true;
      }
      return Reflect.set(storageTarget, property, value, receiver);
    },
    deleteProperty(storageTarget, property) {
      if (typeof property === 'string' && !(property in storageTarget)) {
        store.delete(property);
        return true;
      }
      return Reflect.deleteProperty(storageTarget, property);
    },
    ownKeys(storageTarget) {
      const targetKeys = Reflect.ownKeys(storageTarget);
      const targetStringKeys = new Set(
        targetKeys.filter((key): key is string => typeof key === 'string'),
      );
      return [
        ...targetKeys,
        ...Array.from(store.keys()).filter((key) => !targetStringKeys.has(key)),
      ];
    },
    getOwnPropertyDescriptor(storageTarget, property) {
      if (typeof property === 'string' && store.has(property) && !(property in storageTarget)) {
        return {configurable: true, enumerable: true, writable: true, value: store.get(property)};
      }
      return Reflect.getOwnPropertyDescriptor(storageTarget, property);
    },
  });

  return memoryLocalStorage;
}

function installMemoryLocalStorage(target: typeof globalThis, storage: Storage) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

// Always use one deterministic test Storage. Accessing Node 24/25's native
// experimental localStorage getter can warn or throw when workers have no
// backing file, while older bundled Node versions rely on jsdom instead.
const testLocalStorage = createMemoryLocalStorage();
installMemoryLocalStorage(globalThis, testLocalStorage);
if (typeof window !== 'undefined' && window !== globalThis) {
  installMemoryLocalStorage(window as unknown as typeof globalThis, testLocalStorage);
}
