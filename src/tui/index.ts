/**
 * Ink and React are only loaded when a dashboard is actually going to be drawn, so the
 * JSON and table paths keep a cold start a human would not notice.
 */
export async function startDashboard(start: 'dashboard' | 'accounts'): Promise<void> {
  const [{ render }, { createElement }, { Root }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./onboard.tsx'),
  ])
  const instance = render(createElement(Root, { start }), { exitOnCtrlC: true })
  await instance.waitUntilExit()
}
