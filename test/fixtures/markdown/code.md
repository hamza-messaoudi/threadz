Code samples in several languages.

```ts
// TypeScript
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}
```

```bash
npm run build && npm start -- --replace
```

```json
{ "name": "agent-chat", "private": true, "scripts": { "dev": "vite" } }
```

```python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```diff
- const cache = new Map()
+ const cache = new LruCache(500)
```

```not-a-real-language
Unknown languages render as plain text.
```

```
No language at all, and a very long line that has to scroll horizontally inside the frame instead of widening the message column: 0123456789 0123456789 0123456789 0123456789
```
