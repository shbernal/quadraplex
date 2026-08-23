/**
 * Ink and React are only loaded when a dashboard is actually going to be drawn, so the
 * JSON and table paths keep a cold start a human would not notice.
 */
export async function startDashboard(): Promise<void> {
  const [{ render }, { createElement }, { App }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./app.tsx'),
  ])
  const instance = render(createElement(App), { exitOnCtrlC: true })
  await instance.waitUntilExit()
}
