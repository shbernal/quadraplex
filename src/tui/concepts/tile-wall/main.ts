/**
 * The tile wall, a concept TUI. `bun run src/tui/concepts/tile-wall/main.ts`
 * Reads the store like the dashboard does and never fetches; `r` shells out to refresh.
 */
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './app.tsx'

const instance = render(createElement(App), { exitOnCtrlC: true })
await instance.waitUntilExit()
