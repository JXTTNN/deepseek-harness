# @deepseek-ai/dsh-skill-anysearch

## Description

Provides a free web search capability for the DeepSeek Harness using **duckduckgo-search** (or `anysearch` if you have an Elasticsearch/OpenSearch cluster). This skill can be invoked via `ctx.skills` to perform a web search and return results.

## Installation

```bash
# Add to your workspace skills directory
mkdir -p ~/.dsh/skills
# Or directly add to the harness packages
pnpm add @deepseek-ai/dsh-skill-anysearch
```

Then configure the skill provider in your `dsh` config:

```yaml
skills:
  providers:
    - anysearch
```

## Usage

```ts
import { skills } from '@deepseek-ai/cordis';

// Search the web
const results = await skills.invoke('anysearch', {
  query: 'DeepSeek Harness integration',
});
console.log(results);
```

## License

MIT