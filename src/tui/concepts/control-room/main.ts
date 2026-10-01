/**
 * The control room, a concept TUI. `bun run src/tui/concepts/control-room/main.ts`
 * Reads the store like the dashboard does and never fetches.
 */
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './app.tsx'

const instance = render(createElement(App), { exitOnCtrlC: true })
await instance.waitUntilExit()
