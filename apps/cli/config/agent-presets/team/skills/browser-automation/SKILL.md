---
name: browser-automation
description: Drive a real browser to verify the current app/UI, take screenshots, fill forms, click through flows, or scrape JS-rendered pages. Use this skill when plain HTTP fetch is not enough — the page needs JavaScript, a login session, or visual/interaction proof — and when a human asked to "check the UI", "test like a user", or capture a page screenshot.
---

# Browser Automation

The trustworthy way to verify a UI claim is to drive a real browser. Do everything through Playwright — never imagine layout or content from reading markup.

## Setup

The project usually has Playwright already (this repo does). If it does not:

```sh
pnpm add -D playwright
npx playwright install chromium
```

One-off fallback without adding dependencies: `npx -y playwright screenshot <url> <file>.png`.

## Supported exchanges with the user

- Screenshot a URL (full page or viewport).
- Click a route: navigate, click, read the rendered object, assert visible text.
- Fill forms / tap menus with accessible selectors followed by text assertions.
- Run a minimal check suite like "open http://localhost:3080; expect 'Team Mode' text".

## Recipe: a loop of one command + one assertion

Keep checks in the terminal, one command at a time:

```sh
node --input-type=module -e "
import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true })
const p = await b.newContext().newPage()
await p.goto('http://127.0.0.1:3080', { waitUntil: 'domcontentloaded' })
await p.getByRole('button', { name: 'New Session' }).click()
await p.waitForTimeout(500)
const text = await p.locator('body').innerText()
if (!text.includes('New Session')) throw new Error('session chrome missing')
console.log('OK', text.length)
await b.close()
"
```

For step evidence, print a screenshot path next to your PASS lines:

```sh
node --input-type=module -e "
import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newContext().newPage()
await p.goto('http://127.0.0.1:3080')
await p.screenshot({ path: 'evidence/home.png', fullPage: true })
console.log('stored evidence/home.png')
await b.close()
"
```

## What to report

- What you did (urls visited, controls touched), not code you wrote.
- What the rendered page SHOWED: visible text and structure, in the user's language.
- Where the evidence lives on disk (screenshots / HAR files), so a reviewer can click through the proof.

## Constraints

- Never judge visuals without a screenshot — read it back with the image-read tool before asserting a claim about looks.
- Use `getByRole`/`getByText`/`getByTestId`, not fragile CSS.
- Public endpoints and local pages only; do not crawl third-party sites you did not get consent to hit.
- Clean up browser processes when done (`await b.close()`); a leaked chromium pins ~a hundred MB of RAM.
