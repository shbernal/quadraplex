/**
 * The facility wall, a concept dashboard: every project as one tile on a grid that reflows
 * to the terminal. `bun run src/tui/concepts/facility/index.ts`
 */
import { render } from 'ink'
import { createElement } from 'react'
import { FacilityApp } from './app.tsx'

const instance = render(createElement(FacilityApp), { exitOnCtrlC: true })
await instance.waitUntilExit()
