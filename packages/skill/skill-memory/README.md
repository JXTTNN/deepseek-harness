# @deepseek-ai/dsh-skill-memory

## Description

A simple long‑term memory skill for the DeepSeek Harness. Stores key/value pairs in a JSON file (`$DSH_HOME/memory.json`). Provides two actions:

- `remember(key, value)` – persists a value under the given key.
- `recall(key)` – retrieves a previously stored value.

## Installation

```bash
pnpm add @deepseek-ai/dsh-skill-memory
```

Then add the provider to your `dsh` config:

```yaml
skills:
  providers:
    - memory
```

## Usage

```ts
import { skills } from '@deepseek-ai/cordis';

// Remember something
await skills.invoke('memory', {
  action: 'remember',
  key: 'user-preference',
  value: { theme: 'dark' },
});

// Recall later
const data = await skills.invoke('memory', {
  action: 'recall',
  key: 'user-preference',
});
console.log(data); // { theme: 'dark' }
```

## License

MIT